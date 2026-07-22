import { describe, expect, it } from 'vitest'

import {
  createArtPlayerAdapter,
  PlayerAdapterError,
  type ArtPlayerLike,
  type ArtPlayerSurface,
  type VideoElementLike,
} from '../../src/adapters/artplayer.js'
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
  pauseCalls = 0
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
    this.pauseCalls += 1
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

interface SyntheticOverlay {
  readonly id: string
}

class SyntheticPlayer implements ArtPlayerLike<SyntheticOverlay> {
  readonly video = new SyntheticVideo()
  readonly overlayContainer = { id: 'overlay' }
  private readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  private addedListeners = 0
  mutexValues: boolean[] = []
  destroyCalls = 0
  failSubscriptionAfter: number | null = null
  failMutex = false

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

  setMutex(enabled: boolean): void {
    if (this.failMutex) {
      throw new Error('Synthetic mutex update failed.')
    }
    this.mutexValues.push(enabled)
  }

  destroy(): void {
    this.destroyCalls += 1
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

class SyntheticSurface implements ArtPlayerSurface<SyntheticOverlay> {
  visible: ArtPlayerLike<SyntheticOverlay>
  readonly mounted = new Set<ArtPlayerLike<SyntheticOverlay>>()

  constructor(initial: ArtPlayerLike<SyntheticOverlay>) {
    this.visible = initial
    this.mounted.add(initial)
  }

  stage(player: ArtPlayerLike<SyntheticOverlay>): void {
    this.mounted.add(player)
  }

  reveal(
    player: ArtPlayerLike<SyntheticOverlay>,
    _previous: ArtPlayerLike<SyntheticOverlay>,
  ): void {
    this.visible = player
  }

  remove(player: ArtPlayerLike<SyntheticOverlay>): void {
    this.mounted.delete(player)
  }
}

function createPlayerFactory(created: SyntheticPlayer[]) {
  return async (
    _source: LiveSource,
    _generation: number,
    options: { readonly mutex: false },
  ): Promise<ArtPlayerLike<SyntheticOverlay>> => {
    expect(options.mutex).toBe(false)
    const player = new SyntheticPlayer()
    created.push(player)
    return player
  }
}

describe('ArtPlayer-like adapter', () => {
  it('atomically reveals a hidden candidate and converts player events', async () => {
    const initial = new SyntheticPlayer()
    const created: SyntheticPlayer[] = []
    const surface = new SyntheticSurface(initial)
    const adapter = createArtPlayerAdapter({
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
    expect(initial.mutexValues).toEqual([false])
    expect(candidate?.mutexValues).toEqual([false])
    expect(surface.visible).toBe(initial)

    await adapter.commit(prepared, 5)
    await adapter.play()
    candidate?.emit('playing')
    expect(surface.visible).toBe(initial)

    candidate?.video.renderFrame()
    candidate?.emit('waiting')
    candidate?.emit('stalled')
    expect(surface.visible).toBe(candidate)
    expect(initial.destroyCalls).toBe(1)
    expect(events).toContainEqual({ type: 'first-frame', generation: 5 })
    expect(events).toContainEqual({ type: 'waiting', generation: 5 })
    expect(events).toContainEqual({ type: 'stalled', generation: 5 })
    expect(adapter.getOverlayContainer()).toBe(candidate?.overlayContainer)

    await adapter.destroy()
    expect(candidate?.destroyCalls).toBe(1)
  })

  it('does not pause or destroy resources owned by another adapter instance', async () => {
    const firstInitial = new SyntheticPlayer()
    const secondInitial = new SyntheticPlayer()
    const firstCreated: SyntheticPlayer[] = []
    const secondCreated: SyntheticPlayer[] = []
    const firstAdapter = createArtPlayerAdapter({
      player: firstInitial,
      createPlayer: createPlayerFactory(firstCreated),
      surface: new SyntheticSurface(firstInitial),
    })
    const secondAdapter = createArtPlayerAdapter({
      player: secondInitial,
      createPlayer: createPlayerFactory(secondCreated),
      surface: new SyntheticSurface(secondInitial),
    })

    const firstPrepared = await firstAdapter.prepare(
      { url: 'https://media.invalid/first.m3u8', kind: 'hls' },
      1,
    )
    const secondPrepared = await secondAdapter.prepare(
      { url: 'https://media.invalid/second.m3u8', kind: 'hls' },
      1,
    )
    await firstAdapter.commit(firstPrepared, 1)
    await secondAdapter.commit(secondPrepared, 1)
    await secondAdapter.play()
    const secondCandidate = secondCreated[0]

    await firstAdapter.play()
    firstCreated[0]?.emit('playing')
    firstCreated[0]?.video.renderFrame()

    expect(secondInitial.video.pauseCalls).toBe(0)
    expect(secondInitial.destroyCalls).toBe(0)
    expect(secondCandidate?.video.pauseCalls).toBe(0)
    expect(secondCandidate?.destroyCalls).toBe(0)

    await firstAdapter.destroy()
    await secondAdapter.destroy()
  })

  it('releases the current player without waiting for a late candidate', async () => {
    const initial = new SyntheticPlayer()
    const surface = new SyntheticSurface(initial)
    let resolveCandidate = (_player: ArtPlayerLike<SyntheticOverlay>): void => {
      throw new Error('Candidate factory has not started.')
    }
    const adapter = createArtPlayerAdapter({
      player: initial,
      createPlayer(): Promise<ArtPlayerLike<SyntheticOverlay>> {
        return new Promise((resolve) => {
          resolveCandidate = resolve
        })
      },
      surface,
    })

    const preparation = adapter.prepare({ url: 'https://media.invalid/late.m3u8', kind: 'hls' }, 9)
    const destruction = adapter.destroy()
    let destructionCompleted = false
    void destruction.then(() => {
      destructionCompleted = true
    })
    await Promise.resolve()
    expect(destructionCompleted).toBe(true)
    expect(initial.destroyCalls).toBe(1)
    expect(initial.listenerCount()).toBe(0)

    const candidate = new SyntheticPlayer()
    resolveCandidate(candidate)

    await expect(preparation).resolves.toEqual({ generation: 9 })
    await destruction
    expect(candidate.destroyCalls).toBe(1)
    expect(surface.mounted.has(candidate)).toBe(false)
    await expect(adapter.discard({ generation: 9 })).resolves.toBeUndefined()
  })

  it('rolls back partial initial player subscriptions and throws a typed error', () => {
    const initial = new SyntheticPlayer()
    initial.failSubscriptionAfter = 3
    const surface = new SyntheticSurface(initial)

    expect(() =>
      createArtPlayerAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface,
      }),
    ).toThrow(PlayerAdapterError)
    expect(initial.listenerCount()).toBe(0)
  })

  it('wraps an initial mutex failure in a typed adapter error', () => {
    const initial = new SyntheticPlayer()
    initial.failMutex = true

    expect(() =>
      createArtPlayerAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface: new SyntheticSurface(initial),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'PlayerAdapterError',
        code: 'artplayer-mutex-failed',
      }),
    )
  })
})
