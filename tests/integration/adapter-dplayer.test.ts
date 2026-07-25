import { describe, expect, it } from 'vitest'

import {
  createDPlayerAdapter,
  PlayerAdapterError,
  type DPlayerLike,
  type DPlayerSurface,
  type VideoElementLike,
} from '../../src/adapters/dplayer.js'
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

class SyntheticDPlayer implements DPlayerLike {
  readonly video = new SyntheticVideo()
  private readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  private addedListeners = 0
  destroyCalls = 0
  failSubscriptionAfter: number | null = null

  on(event: string, handler: (...args: readonly unknown[]) => void): void {
    if (this.failSubscriptionAfter !== null && this.addedListeners >= this.failSubscriptionAfter) {
      throw new Error('Synthetic subscription failed.')
    }
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(handler)
    this.listeners.set(event, listeners)
    this.addedListeners += 1
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

class SyntheticSurface implements DPlayerSurface {
  visible: DPlayerLike
  readonly mounted = new Set<DPlayerLike>()

  constructor(initial: DPlayerLike) {
    this.visible = initial
    this.mounted.add(initial)
  }

  stage(player: DPlayerLike): void {
    this.mounted.add(player)
  }

  reveal(player: DPlayerLike, _previous: DPlayerLike): void {
    this.visible = player
  }

  remove(player: DPlayerLike): void {
    this.mounted.delete(player)
  }
}

function createPlayerFactory(created: SyntheticDPlayer[]) {
  return async (_source: LiveSource, _generation: number): Promise<DPlayerLike> => {
    const player = new SyntheticDPlayer()
    created.push(player)
    return player
  }
}

describe('DPlayer-like adapter', () => {
  it('atomically reveals a hidden candidate and converts player events', async () => {
    const initial = new SyntheticDPlayer()
    const created: SyntheticDPlayer[] = []
    const surface = new SyntheticSurface(initial)
    const adapter = createDPlayerAdapter({
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

    candidate?.video.renderFrame()
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

  it('converts an external destroy into a non-recoverable error event', async () => {
    const initial = new SyntheticDPlayer()
    const surface = new SyntheticSurface(initial)
    const adapter = createDPlayerAdapter({
      player: initial,
      createPlayer: createPlayerFactory([]),
      surface,
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    initial.emit('destroy')
    expect(events).toContainEqual({
      type: 'error',
      generation: 0,
      code: 'dplayer-destroyed',
      recoverable: false,
    })

    await adapter.destroy()
  })

  it('forwards recoverable media errors with a typed code', async () => {
    const initial = new SyntheticDPlayer()
    const adapter = createDPlayerAdapter({
      player: initial,
      createPlayer: createPlayerFactory([]),
      surface: new SyntheticSurface(initial),
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    initial.emit('error')
    expect(events).toContainEqual({
      type: 'error',
      generation: 0,
      code: 'dplayer-media-error',
      recoverable: true,
    })

    await adapter.destroy()
  })

  it('throws a typed error on partial subscriptions and keeps stale handlers inert', () => {
    const initial = new SyntheticDPlayer()
    initial.failSubscriptionAfter = 3

    expect(() =>
      createDPlayerAdapter({
        player: initial,
        createPlayer: createPlayerFactory([]),
        surface: new SyntheticSurface(initial),
      }),
    ).toThrow(PlayerAdapterError)
    expect(() => {
      initial.emit('playing')
      initial.emit('error')
    }).not.toThrow()
  })

  it('stops forwarding events after destroy even without an off()', async () => {
    const initial = new SyntheticDPlayer()
    const adapter = createDPlayerAdapter({
      player: initial,
      createPlayer: createPlayerFactory([]),
      surface: new SyntheticSurface(initial),
    })
    const events: PlaybackEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
    })

    await adapter.destroy()
    expect(initial.destroyCalls).toBe(1)
    expect(initial.listenerCount()).toBeGreaterThan(0)

    expect(() => {
      initial.emit('playing')
      initial.emit('error')
    }).not.toThrow()
    expect(events).toEqual([])
    await expect(adapter.destroy()).resolves.toBeUndefined()
  })
})
