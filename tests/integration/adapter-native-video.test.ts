import { describe, expect, it } from 'vitest'

import {
  createNativeVideoAdapter,
  PlayerAdapterError,
  type NativeVideoSurface,
  type VideoElementLike,
} from '../../src/adapters/native-video.js'
import type { PlaybackEvent } from '../../src/continuity/index.js'

class SyntheticTimeRanges {
  constructor(private readonly ranges: readonly (readonly [number, number])[]) {}

  get length(): number {
    return this.ranges.length
  }

  start(index: number): number {
    const range = this.ranges[index]
    if (range === undefined) {
      throw new RangeError('Missing range.')
    }
    return range[0]
  }

  end(index: number): number {
    const range = this.ranges[index]
    if (range === undefined) {
      throw new RangeError('Missing range.')
    }
    return range[1]
  }
}

class SyntheticVideo implements VideoElementLike {
  src = ''
  crossOrigin: string | null = null
  preload = ''
  currentTime = 0
  playbackRate = 1
  failMutedWrites = false
  failFrameCancellation = false
  failListenerRemoval = false
  volume = 1
  paused = true
  ended = false
  readyState = 0
  buffered = new SyntheticTimeRanges([])
  error: { readonly code: number } | null = null
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly frameCallbacks = new Map<number, (timestampMs: number) => void>()
  private nextFrameHandle = 1
  private mutedValue = false
  private addedListeners = 0
  pauseCalls = 0
  loadCalls = 0
  failSubscriptionAfter: number | null = null

  get muted(): boolean {
    return this.mutedValue
  }

  set muted(value: boolean) {
    if (this.failMutedWrites) {
      throw new Error('Synthetic muted setter failed.')
    }
    this.mutedValue = value
  }

  addEventListener(type: string, listener: () => void): void {
    if (this.failSubscriptionAfter !== null && this.addedListeners >= this.failSubscriptionAfter) {
      throw new Error('Synthetic subscription failed.')
    }
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
    this.addedListeners += 1
  }

  removeEventListener(type: string, listener: () => void): void {
    if (this.failListenerRemoval) {
      throw new Error('Synthetic listener removal failed.')
    }
    this.listeners.get(type)?.delete(listener)
  }

  load(): void {
    this.loadCalls += 1
  }

  async play(): Promise<void> {
    this.paused = false
  }

  pause(): void {
    this.paused = true
    this.pauseCalls += 1
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = ''
    }
  }

  requestVideoFrameCallback(callback: (timestampMs: number) => void): number {
    const handle = this.nextFrameHandle
    this.nextFrameHandle += 1
    this.frameCallbacks.set(handle, callback)
    return handle
  }

  cancelVideoFrameCallback(handle: number): void {
    if (this.failFrameCancellation) {
      throw new Error('Synthetic frame cancellation failed.')
    }
    this.frameCallbacks.delete(handle)
  }

  getVideoPlaybackQuality(): { readonly droppedVideoFrames: number } {
    return { droppedVideoFrames: 7 }
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener()
    }
  }

  renderFrame(timestampMs = 100): void {
    const callbacks = [...this.frameCallbacks.values()]
    this.frameCallbacks.clear()
    for (const callback of callbacks) {
      callback(timestampMs)
    }
  }

  listenerCount(): number {
    let count = 0
    for (const listeners of this.listeners.values()) {
      count += listeners.size
    }
    return count
  }
}

class SyntheticSurface implements NativeVideoSurface {
  readonly created: SyntheticVideo[] = []
  readonly mounted = new Set<VideoElementLike>()
  visible: VideoElementLike

  constructor(initial: SyntheticVideo) {
    this.visible = initial
    this.mounted.add(initial)
  }

  createVideo(): VideoElementLike {
    const video = new SyntheticVideo()
    this.created.push(video)
    return video
  }

  stage(video: VideoElementLike): void {
    this.mounted.add(video)
  }

  reveal(video: VideoElementLike, _previous: VideoElementLike): void {
    this.visible = video
  }

  remove(video: VideoElementLike): void {
    this.mounted.delete(video)
  }

  latestCreated(): SyntheticVideo {
    const video = this.created.at(-1)
    if (video === undefined) {
      throw new Error('No candidate video was created.')
    }
    return video
  }
}

describe('native video adapter', () => {
  it('accepts the native HTMLVideoElement shape', () => {
    const compatible: HTMLVideoElement extends VideoElementLike ? true : false = true
    expect(compatible).toBe(true)
  })

  it('keeps the current video visible until the prepared video renders its first frame', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/live-2.m3u8', kind: 'hls' },
      2,
    )
    const candidate = surface.latestCreated()
    expect(surface.visible).toBe(initial)
    expect(surface.mounted.has(candidate)).toBe(true)
    candidate.emit('waiting')
    expect(events).not.toContainEqual({ type: 'waiting', generation: 2 })

    await adapter.commit(prepared, 2)
    await adapter.play()
    candidate.emit('playing')
    expect(surface.visible).toBe(initial)

    candidate.renderFrame()
    expect(surface.visible).toBe(candidate)
    expect(initial.pauseCalls).toBe(1)
    expect(surface.mounted.has(initial)).toBe(false)
    expect(events).toContainEqual({ type: 'first-frame', generation: 2 })

    await adapter.destroy()
  })

  it('discards a prepared video safely after the adapter has been destroyed', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
    })
    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/live-3.m3u8', kind: 'hls' },
      3,
    )
    const candidate = surface.latestCreated()

    await adapter.destroy()
    await expect(adapter.discard(prepared)).resolves.toBeUndefined()
    await expect(adapter.destroy()).resolves.toBeUndefined()
    expect(surface.mounted.has(candidate)).toBe(false)
    expect(surface.mounted.has(initial)).toBe(true)
  })

  it('reports metrics from the visible video and applies media controls locally', async () => {
    const initial = new SyntheticVideo()
    initial.currentTime = 12
    initial.buffered = new SyntheticTimeRanges([
      [0, 15],
      [18, 24],
    ])
    const surface = new SyntheticSurface(initial)
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
    })

    adapter.setMuted(true)
    adapter.setVolume(0.4)
    adapter.setPlaybackRate(1.05)

    expect(initial.muted).toBe(true)
    expect(initial.volume).toBe(0.4)
    expect(initial.playbackRate).toBe(1.05)
    expect(adapter.getMetrics()).toEqual({
      currentTimeSeconds: 12,
      bufferedAheadSeconds: 3,
      liveEdgeDistanceSeconds: 12,
      playbackRate: 1.05,
      stalledSince: null,
      droppedFrames: 7,
    })

    await adapter.destroy()
  })

  it('keeps the promoted frame visible when restoring media controls fails', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const diagnostics: string[] = []
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
      onDiagnostic(event): void {
        diagnostics.push(event.code)
      },
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/control-failure.m3u8', kind: 'hls' },
      4,
    )
    const candidate = surface.latestCreated()
    await adapter.commit(prepared, 4)
    await adapter.play()
    candidate.emit('playing')
    candidate.failMutedWrites = true

    candidate.renderFrame()

    expect(surface.visible).toBe(candidate)
    expect(surface.mounted.has(initial)).toBe(false)
    expect(surface.mounted.has(candidate)).toBe(true)
    expect(events).toContainEqual({ type: 'first-frame', generation: 4 })
    expect(events).toContainEqual({
      type: 'error',
      generation: 4,
      code: 'media-control-restore-failed',
      recoverable: true,
    })
    expect(diagnostics).toContain('media-control-restore-failed')

    candidate.failMutedWrites = false
    await adapter.destroy()
  })

  it('rolls back partial initial event subscriptions and throws a typed error', () => {
    const initial = new SyntheticVideo()
    initial.failSubscriptionAfter = 2
    const surface = new SyntheticSurface(initial)

    expect(() =>
      createNativeVideoAdapter({
        video: initial,
        surface,
      }),
    ).toThrow(PlayerAdapterError)
    expect(initial.listenerCount()).toBe(0)
  })

  it('sanitizes a stage failure even when candidate cleanup also fails', async () => {
    const initial = new SyntheticVideo()
    const candidate = new SyntheticVideo()
    const surface: NativeVideoSurface = {
      createVideo(): VideoElementLike {
        return candidate
      },
      stage(): void {
        throw new Error('Raw stage failure with private details.')
      },
      reveal(): void {},
      remove(): void {
        throw new Error('Raw cleanup failure with private details.')
      },
    }
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
    })

    const preparation = adapter.prepare(
      { url: 'https://media.invalid/stage-failure.m3u8', kind: 'hls' },
      6,
    )

    await expect(preparation).rejects.toMatchObject({
      name: 'PlayerAdapterError',
      code: 'media-prepare-failed',
    })
    await adapter.destroy()
  })

  it('continues releasing a candidate when frame cancellation fails', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const diagnosticCodes: string[] = []
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
      onDiagnostic(event): void {
        diagnosticCodes.push(event.code)
      },
    })
    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/cancel-failure.m3u8', kind: 'hls' },
      7,
    )
    const candidate = surface.latestCreated()
    await adapter.commit(prepared, 7)
    await adapter.play()
    candidate.emit('playing')
    candidate.failFrameCancellation = true

    await expect(adapter.discard(prepared)).resolves.toBeUndefined()
    expect(surface.mounted.has(candidate)).toBe(false)
    expect(diagnosticCodes).toContain('media-frame-cancel-failed')

    await adapter.destroy()
  })

  it('reports listener cleanup failure after releasing the media resource', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
    })
    initial.src = 'https://media.invalid/cleanup-failure.m3u8'
    initial.failListenerRemoval = true

    await expect(adapter.destroy()).rejects.toMatchObject({
      name: 'PlayerAdapterError',
      code: 'player-adapter-cleanup-failed',
    })
    expect(initial.src).toBe('')
    expect(initial.pauseCalls).toBe(1)
  })

  it('activates prepared sources through the custom binding instead of the src attribute', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const attached: Array<{ video: VideoElementLike; url: string }> = []
    const detached: VideoElementLike[] = []
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
      crossOrigin: 'anonymous',
      binding: {
        attach(video, source): void {
          attached.push({ video, url: source.url })
        },
        detach(video): void {
          detached.push(video)
        },
      },
    })

    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/live-8.flv', kind: 'flv' },
      8,
    )
    const candidate = surface.latestCreated()
    expect(attached).toEqual([{ video: candidate, url: 'https://media.invalid/live-8.flv' }])
    expect(candidate.src).toBe('')
    expect(candidate.loadCalls).toBe(0)
    expect(candidate.crossOrigin).toBe('anonymous')

    await adapter.discard(prepared)
    expect(detached).toEqual([candidate])
    expect(candidate.pauseCalls).toBe(1)
    expect(surface.mounted.has(candidate)).toBe(false)

    await adapter.destroy()
    expect(detached).toContain(initial)
  })

  it('still releases the video when binding detach fails', async () => {
    const initial = new SyntheticVideo()
    const surface = new SyntheticSurface(initial)
    const adapter = createNativeVideoAdapter({
      video: initial,
      surface,
      binding: {
        attach(): void {},
        detach(): void {
          throw new Error('Synthetic detach failure.')
        },
      },
    })

    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/live-9.flv', kind: 'flv' },
      9,
    )
    const candidate = surface.latestCreated()

    expect(() => adapter.discard(prepared)).toThrowError(PlayerAdapterError)
    expect(candidate.pauseCalls).toBe(1)
    expect(candidate.src).toBe('')
  })
})
