import { describe, expect, it } from 'vitest'

import { PlayerAdapterError } from '../../src/adapters/adapter-error.js'
import {
  bindManagedEvents,
  createManagedPlayerAdapter,
  type ManagedEventHandler,
  type ManagedPlayerSurface,
} from '../../src/adapters/managed-player.js'
import type { VideoElementLike } from '../../src/adapters/media-session-adapter.js'
import type { LivePlayerAdapter, LiveSource } from '../../src/continuity/types.js'

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

  addEventListener(_type: string, _listener: () => void): void {}

  removeEventListener(_type: string, _listener: () => void): void {}

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
}

class FakeTarget {
  private readonly bound = new Map<string, Set<ManagedEventHandler>>()
  private added = 0
  failAfter: number | null = null
  failOff = false

  on(event: string, handler: ManagedEventHandler): void {
    if (this.failAfter !== null && this.added >= this.failAfter) {
      throw new Error('Synthetic bind failure.')
    }
    const handlers = this.bound.get(event) ?? new Set()
    handlers.add(handler)
    this.bound.set(event, handlers)
    this.added += 1
  }

  off(event: string, handler: ManagedEventHandler): void {
    if (this.failOff) {
      throw new Error('Synthetic unbind failure.')
    }
    this.bound.get(event)?.delete(handler)
  }

  count(): number {
    let total = 0
    for (const handlers of this.bound.values()) {
      total += handlers.size
    }
    return total
  }
}

class OffLessTarget {
  private readonly bound = new Map<string, Set<ManagedEventHandler>>()
  private added = 0
  failAfter: number | null = null

  on(event: string, handler: ManagedEventHandler): void {
    if (this.failAfter !== null && this.added >= this.failAfter) {
      throw new Error('Synthetic bind failure.')
    }
    const handlers = this.bound.get(event) ?? new Set()
    handlers.add(handler)
    this.bound.set(event, handlers)
    this.added += 1
  }

  count(): number {
    let total = 0
    for (const handlers of this.bound.values()) {
      total += handlers.size
    }
    return total
  }
}

const NOOP_REGISTRATIONS = [
  ['ready', (): void => {}],
  ['playing', (): void => {}],
  ['ended', (): void => {}],
] as const

describe('bindManagedEvents', () => {
  it('binds all registrations and removes them on unsubscribe', () => {
    const target = new FakeTarget()
    const unsubscribe = bindManagedEvents('demo', 'Demo', target, NOOP_REGISTRATIONS)

    expect(target.count()).toBe(3)
    unsubscribe()
    expect(target.count()).toBe(0)
  })

  it('rolls back partial bindings and throws a typed subscribe error', () => {
    const target = new FakeTarget()
    target.failAfter = 2

    expect(() => bindManagedEvents('demo', 'Demo', target, NOOP_REGISTRATIONS)).toThrowError(
      expect.objectContaining({
        name: 'PlayerAdapterError',
        code: 'demo-subscribe-failed',
      }),
    )
    expect(target.count()).toBe(0)
  })

  it('throws a typed unsubscribe error when unbinding fails', () => {
    const target = new FakeTarget()
    const unsubscribe = bindManagedEvents('demo', 'Demo', target, NOOP_REGISTRATIONS)
    target.failOff = true

    expect(() => unsubscribe()).toThrowError(
      expect.objectContaining({
        name: 'PlayerAdapterError',
        code: 'demo-unsubscribe-failed',
      }),
    )
  })

  it('treats targets without off() as bind-only and never throws on unsubscribe', () => {
    const target = new OffLessTarget()
    const unsubscribe = bindManagedEvents('demo', 'Demo', target, NOOP_REGISTRATIONS)

    expect(target.count()).toBe(3)
    expect(() => unsubscribe()).not.toThrow()
    expect(target.count()).toBe(3)

    const failing = new OffLessTarget()
    failing.failAfter = 1
    expect(() => bindManagedEvents('demo', 'Demo', failing, NOOP_REGISTRATIONS)).toThrow(
      PlayerAdapterError,
    )
  })
})

interface FakePlayer {
  readonly id: number
  readonly video: SyntheticVideo
}

interface FlowLog {
  readonly action: 'stage' | 'reveal' | 'remove' | 'destroy'
  readonly id: number
}

function createFlowHarness(options: { removeFailsOnce?: boolean; stageFails?: boolean } = {}) {
  const log: FlowLog[] = []
  let nextId = 1
  let removeFailures = options.removeFailsOnce === true ? 1 : 0
  const initial: FakePlayer = { id: 0, video: new SyntheticVideo() }
  const surface: ManagedPlayerSurface<FakePlayer> = {
    stage(player: FakePlayer): void {
      if (options.stageFails === true) {
        throw new Error('Synthetic stage failure.')
      }
      log.push({ action: 'stage', id: player.id })
    },
    reveal(player: FakePlayer, _previous: FakePlayer): void {
      log.push({ action: 'reveal', id: player.id })
    },
    remove(player: FakePlayer): void {
      if (removeFailures > 0 && player.id !== 0) {
        removeFailures -= 1
        throw new Error('Synthetic remove failure.')
      }
      log.push({ action: 'remove', id: player.id })
    },
  }
  const adapter = createManagedPlayerAdapter<FakePlayer>(
    {
      scope: 'demo',
      operations: {
        createCandidate: 'create a demo candidate',
        releaseInstance: 'release a demo instance',
      },
      initialPlayer: initial,
      surface,
      createPlayer(_source: LiveSource, _generation: number): FakePlayer {
        const player: FakePlayer = { id: nextId, video: new SyntheticVideo() }
        nextId += 1
        return player
      },
      video(player: FakePlayer): VideoElementLike {
        return player.video
      },
      subscribe(): () => void {
        return () => {}
      },
      destroyPlayer(player: FakePlayer): void {
        log.push({ action: 'destroy', id: player.id })
      },
    },
    {},
  )
  return { adapter, log }
}

describe('createManagedPlayerAdapter', () => {
  it('retains a staged candidate until failed cleanup can be retried', async () => {
    const { adapter, log } = createFlowHarness({ stageFails: true, removeFailsOnce: true })

    await expect(
      adapter.prepare({ url: 'https://media.invalid/live.m3u8', kind: 'hls' }, 1),
    ).rejects.toThrow(PlayerAdapterError)
    expect(log).toContainEqual({ action: 'destroy', id: 1 })
    expect(log).not.toContainEqual({ action: 'remove', id: 1 })

    await adapter.destroy()
    expect(log.filter((entry) => entry.action === 'destroy' && entry.id === 1)).toHaveLength(1)
    expect(log).toContainEqual({ action: 'remove', id: 1 })
  })

  it('destroys the initial player exactly once across repeated destroys', async () => {
    const { adapter, log } = createFlowHarness()

    await adapter.destroy()
    await adapter.destroy()
    expect(log.filter((entry) => entry.action === 'destroy')).toEqual([
      { action: 'destroy', id: 0 },
    ])
  })

  it('shares the cached destroy promise with reentrant cleanup', async () => {
    const initial: FakePlayer = { id: 0, video: new SyntheticVideo() }
    const reentrant: Promise<void>[] = []
    let adapter: LivePlayerAdapter | null = null
    const liveAdapter = createManagedPlayerAdapter<FakePlayer>(
      {
        scope: 'demo',
        operations: {
          createCandidate: 'create a demo candidate',
          releaseInstance: 'release a demo instance',
        },
        initialPlayer: initial,
        surface: {
          stage(): void {},
          reveal(): void {},
          remove(): void {},
        },
        createPlayer(): FakePlayer {
          return { id: 1, video: new SyntheticVideo() }
        },
        video(player: FakePlayer): VideoElementLike {
          return player.video
        },
        subscribe(): () => void {
          return () => {
            if (adapter !== null) {
              reentrant.push(adapter.destroy())
            }
          }
        },
        destroyPlayer(): void {
          if (adapter !== null) {
            reentrant.push(adapter.destroy())
          }
        },
      },
      {},
    )
    adapter = liveAdapter

    const destruction = liveAdapter.destroy()
    await destruction

    expect(reentrant).toEqual([destruction, destruction])
  })
})
