import { describe, expect, it } from 'vitest'

import {
  createXgPlayerAdapter,
  PlayerAdapterError,
  type VideoElementLike,
  type XgPlayerLike,
  type XgPlayerSurface,
} from '../../src/adapters/xgplayer.js'
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

interface SyntheticXgPlayerOptions {
  readonly exposeMedia?: boolean
  readonly exposeVideo?: boolean
}

class SyntheticXgPlayer implements XgPlayerLike {
  readonly media?: VideoElementLike
  readonly video?: VideoElementLike
  readonly element = new SyntheticVideo()
  private readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  private addedListeners = 0
  destroyCalls = 0
  failSubscriptionAfter: number | null = null

  constructor(options: SyntheticXgPlayerOptions = { exposeMedia: true }) {
    if (options.exposeMedia === true) {
      this.media = this.element
    }
    if (options.exposeVideo === true) {
      this.video = this.element
    }
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

class SyntheticSurface implements XgPlayerSurface {
  visible: XgPlayerLike
  readonly mounted = new Set<XgPlayerLike>()

  constructor(initial: XgPlayerLike) {
    this.visible = initial
    this.mounted.add(initial)
  }

  stage(player: XgPlayerLike): void {
    this.mounted.add(player)
  }

  reveal(player: XgPlayerLike, _previous: XgPlayerLike): void {
    this.visible = player
  }

  remove(player: XgPlayerLike): void {
    this.mounted.delete(player)
  }
}

function createPlayerFactory(created: SyntheticXgPlayer[]) {
  return async (_source: LiveSource, _generation: number): Promise<XgPlayerLike> => {
    const player = new SyntheticXgPlayer()
    created.push(player)
    return player
  }
}

describe('XGPlayer-like adapter', () => {
  it('atomically reveals a hidden candidate and converts player events', async () => {
    const initial = new SyntheticXgPlayer()
    const created: SyntheticXgPlayer[] = []
    const surface = new SyntheticSurface(initial)
    const adapter = createXgPlayerAdapter({
      player: initial,
      createPlayer: createPlayerFactory(created),
      surface,
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    const prepared = await adapter.prepare(
      { url: 'https://media.invalid/live-5.flv', kind: 'flv' },
      5,
    )
    const candidate = created[0]
    expect(candidate).toBeDefined()
    expect(surface.visible).toBe(initial)

    await adapter.commit(prepared, 5)
    await adapter.play()
    candidate?.emit('playing')
    expect(surface.visible).toBe(initial)

    candidate?.element.renderFrame()
    candidate?.emit('waiting')
    candidate?.emit('stalled')
    expect(surface.visible).toBe(candidate)
    expect(initial.destroyCalls).toBe(1)
    expect(events).toContainEqual({ type: 'first-frame', generation: 5 })
    expect(events).toContainEqual({ type: 'waiting', generation: 5 })
    expect(events).toContainEqual({ type: 'stalled', generation: 5 })

    await adapter.destroy()
    expect(candidate?.destroyCalls).toBe(1)
  })

  it('falls back to the video property when media is unavailable', async () => {
    const initial = new SyntheticXgPlayer({ exposeVideo: true })
    const adapter = createXgPlayerAdapter({
      player: initial,
      createPlayer: createPlayerFactory([]),
      surface: new SyntheticSurface(initial),
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    initial.emit('ready')
    expect(events).toContainEqual({ type: 'ready', generation: 0 })

    await adapter.destroy()
  })

  it('throws a typed error when no media element is exposed', () => {
    const initial = new SyntheticXgPlayer({})

    expect(() =>
      createXgPlayerAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface: new SyntheticSurface(initial),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'PlayerAdapterError',
        code: 'xgplayer-media-missing',
      }),
    )
  })

  it('converts an external destroy into a non-recoverable error event', async () => {
    const initial = new SyntheticXgPlayer()
    const adapter = createXgPlayerAdapter({
      player: initial,
      createPlayer: createPlayerFactory([]),
      surface: new SyntheticSurface(initial),
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    initial.emit('destroy')
    expect(events).toContainEqual({
      type: 'error',
      generation: 0,
      code: 'xgplayer-destroyed',
      recoverable: false,
    })

    await adapter.destroy()
  })

  it('rolls back partial subscriptions and throws a typed error', () => {
    const initial = new SyntheticXgPlayer()
    initial.failSubscriptionAfter = 3

    expect(() =>
      createXgPlayerAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface: new SyntheticSurface(initial),
      }),
    ).toThrow(PlayerAdapterError)
    expect(initial.listenerCount()).toBe(0)
  })
})
