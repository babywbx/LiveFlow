import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js'
import { PlayerAdapterError } from './adapter-error.js'
import {
  createMediaSessionAdapter,
  type MediaResourceDriver,
  type MediaSessionAdapterOptions,
  type ResourceEvent,
  type VideoElementLike,
} from './media-session-adapter.js'

export interface ManagedPlayerSurface<Player> {
  stage(player: Player): void
  reveal(player: Player, previous: Player): void
  remove(player: Player): void
}

export interface ManagedPlayerOperations {
  readonly createCandidate: string
  readonly releaseFailedCandidate: string
  readonly releaseInstance: string
}

export interface ManagedPlayerContract<Player> {
  readonly scope: string
  readonly operations: ManagedPlayerOperations
  readonly initialPlayer: Player
  readonly surface: ManagedPlayerSurface<Player>
  readonly createPlayer: (source: LiveSource, generation: number) => Player | Promise<Player>
  readonly video: (player: Player) => VideoElementLike
  readonly subscribe: (player: Player, listener: (event: ResourceEvent) => void) => () => void
  readonly destroyPlayer: (player: Player) => void
}

export function createManagedPlayerAdapter<Player>(
  contract: ManagedPlayerContract<Player>,
  options: MediaSessionAdapterOptions,
): LivePlayerAdapter {
  const driver: MediaResourceDriver<Player> = {
    initialResource: contract.initialPlayer,
    async create(source: LiveSource, generation: number): Promise<Player> {
      let player: Player | null = null
      try {
        player = await contract.createPlayer(source, generation)
        contract.surface.stage(player)
      } catch {
        if (player !== null) {
          let cleanupFailed = false
          try {
            contract.destroyPlayer(player)
          } catch {
            cleanupFailed = true
          }
          try {
            contract.surface.remove(player)
          } catch {
            cleanupFailed = true
          }
          if (cleanupFailed) {
            throw new PlayerAdapterError(
              `${contract.scope}-cleanup-failed`,
              contract.operations.releaseFailedCandidate,
            )
          }
        }
        throw new PlayerAdapterError(
          `${contract.scope}-create-failed`,
          contract.operations.createCandidate,
        )
      }
      return player
    },
    activate(_player: Player, _source: LiveSource): void {},
    video(player: Player): VideoElementLike {
      return contract.video(player)
    },
    subscribe(player: Player, listener: (event: ResourceEvent) => void): () => void {
      return contract.subscribe(player, listener)
    },
    reveal(next: Player, previous: Player): void {
      contract.surface.reveal(next, previous)
    },
    release(player: Player): void {
      let cleanupFailed = false
      try {
        contract.destroyPlayer(player)
      } catch {
        cleanupFailed = true
      }
      try {
        contract.surface.remove(player)
      } catch {
        cleanupFailed = true
      }
      if (cleanupFailed) {
        throw new PlayerAdapterError(
          `${contract.scope}-cleanup-failed`,
          contract.operations.releaseInstance,
        )
      }
    },
  }

  return createMediaSessionAdapter(driver, options)
}

export type ManagedEventHandler = (...args: readonly unknown[]) => void

export interface ManagedEventTarget {
  on(event: string, handler: ManagedEventHandler): void
  off?(event: string, handler: ManagedEventHandler): void
}

export function bindManagedEvents(
  scope: string,
  label: string,
  target: ManagedEventTarget,
  registrations: ReadonlyArray<readonly [string, ManagedEventHandler]>,
): () => void {
  const subscribed: Array<readonly [string, ManagedEventHandler]> = []
  try {
    for (const registration of registrations) {
      target.on(registration[0], registration[1])
      subscribed.push(registration)
    }
  } catch {
    for (const [event, handler] of subscribed) {
      try {
        target.off?.(event, handler)
      } catch {
        continue
      }
    }
    throw new PlayerAdapterError(`${scope}-subscribe-failed`, `subscribe to ${label} events`)
  }

  return () => {
    if (target.off === undefined) {
      return
    }
    let cleanupFailed = false
    for (const [event, handler] of registrations) {
      try {
        target.off(event, handler)
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupFailed) {
      throw new PlayerAdapterError(
        `${scope}-unsubscribe-failed`,
        `unsubscribe from ${label} events`,
      )
    }
  }
}
