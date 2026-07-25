import { describe, expect, it } from 'vitest'

import {
  createVideoJsAdapter,
  PlayerAdapterError,
  type VideoElementLike,
  type VideoJsPlayerLike,
  type VideoJsSurface,
} from '../../src/adapters/videojs.js'
import type { LiveSource, PlaybackEvent } from '../../src/continuity/index.js'

class EmptyTimeRanges {
  readonly length = 0

  start(_index: number): number {
    throw new RangeError('Missing range.')
  }

  end(_index: number): number {
    throw new RangeError('Missing range.')
  }
}

class SyntheticVideo implements VideoElementLike {
  src = ''
  crossOrigin: string | null = null
  preload = ''
  currentTime = 0
  playbackRate = 1
  muted = false
  volume = 1
  paused = true
  ended = false
  readyState = 0
  buffered = new EmptyTimeRanges()
  error: { readonly code: number } | null = null
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly frames = new Map<number, (timestampMs: number) => void>()
  private nextFrame = 1

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  load(): void {}

  async play(): Promise<void> {
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = ''
    }
  }

  requestVideoFrameCallback(callback: (timestampMs: number) => void): number {
    const handle = this.nextFrame
    this.nextFrame += 1
    this.frames.set(handle, callback)
    return handle
  }

  cancelVideoFrameCallback(handle: number): void {
    this.frames.delete(handle)
  }

  renderFrame(): void {
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) {
      callback(100)
    }
  }
}

class SyntheticHost {
  hidden = false
  removeCalls = 0

  constructor(private readonly video: SyntheticVideo | null) {}

  querySelector(selectors: string): unknown {
    if (selectors === 'video') {
      return this.video
    }
    return null
  }

  remove(): void {
    this.removeCalls += 1
  }
}

class SyntheticVideoJs implements VideoJsPlayerLike {
  readonly video = new SyntheticVideo()
  host: SyntheticHost | null
  private readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  private addedListeners = 0
  disposeCalls = 0
  failSubscriptionAfter: number | null = null

  constructor(withVideo = true) {
    this.host = new SyntheticHost(withVideo ? this.video : null)
  }

  el(): SyntheticHost | null {
    return this.host
  }

  on(event: string, handler: (...args: readonly unknown[]) => void): void {
    if (this.failSubscriptionAfter !== null && this.addedListeners >= this.failSubscriptionAfter) {
      throw new Error('Synthetic subscription failed.')
    }
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(handler)
    this.listeners.set(event, listeners)
    this.addedListeners += 1
  }

  off(event: string, handler: (...args: readonly unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler)
  }

  dispose(): void {
    this.disposeCalls += 1
    this.host = null
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener()
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

class SyntheticSurface implements VideoJsSurface {
  visible: VideoJsPlayerLike
  readonly mounted = new Set<VideoJsPlayerLike>()

  constructor(initial: VideoJsPlayerLike) {
    this.visible = initial
    this.mounted.add(initial)
  }

  stage(player: VideoJsPlayerLike): void {
    this.mounted.add(player)
  }

  reveal(player: VideoJsPlayerLike, _previous: VideoJsPlayerLike): void {
    this.visible = player
  }

  remove(player: VideoJsPlayerLike): void {
    this.mounted.delete(player)
  }
}

function createPlayerFactory(created: SyntheticVideoJs[]) {
  return async (_source: LiveSource, _generation: number): Promise<VideoJsPlayerLike> => {
    const player = new SyntheticVideoJs()
    created.push(player)
    return player
  }
}

describe('Video.js-like adapter', () => {
  it('atomically reveals a hidden candidate and converts player events', async () => {
    const initial = new SyntheticVideoJs()
    const created: SyntheticVideoJs[] = []
    const surface = new SyntheticSurface(initial)
    const adapter = createVideoJsAdapter({
      player: initial,
      createPlayer: createPlayerFactory(created),
      surface,
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/live-5.m3u8', kind: 'hls' },
      5,
    )
    const candidate = created[0]
    expect(candidate).toBeDefined()
    expect(surface.visible).toBe(initial)

    await adapter.commit(prepared, 5)
    await adapter.play()
    candidate?.emit('playing')
    expect(surface.visible).toBe(initial)

    candidate?.video.renderFrame()
    candidate?.emit('waiting')
    candidate?.emit('stalled')
    expect(surface.visible).toBe(candidate)
    expect(initial.disposeCalls).toBe(1)
    expect(events).toContainEqual({ type: 'first-frame', generation: 5 })
    expect(events).toContainEqual({ type: 'waiting', generation: 5 })
    expect(events).toContainEqual({ type: 'stalled', generation: 5 })

    await adapter.destroy()
    expect(candidate?.disposeCalls).toBe(1)
  })

  it('throws a typed error when the media element cannot be resolved', () => {
    const initial = new SyntheticVideoJs(false)

    expect(() =>
      createVideoJsAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface: new SyntheticSurface(initial),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'PlayerAdapterError',
        code: 'videojs-video-missing',
      }),
    )
  })

  it('converts an external dispose into a non-recoverable error event', async () => {
    const initial = new SyntheticVideoJs()
    const adapter = createVideoJsAdapter({
      player: initial,
      createPlayer: createPlayerFactory([]),
      surface: new SyntheticSurface(initial),
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    initial.emit('dispose')
    expect(events).toContainEqual({
      type: 'error',
      generation: 0,
      code: 'videojs-disposed',
      recoverable: false,
    })

    await adapter.destroy()
  })

  it('rolls back partial subscriptions and throws a typed error', () => {
    const initial = new SyntheticVideoJs()
    initial.failSubscriptionAfter = 3

    expect(() =>
      createVideoJsAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface: new SyntheticSurface(initial),
      }),
    ).toThrow(PlayerAdapterError)
    expect(initial.listenerCount()).toBe(0)
  })
})
