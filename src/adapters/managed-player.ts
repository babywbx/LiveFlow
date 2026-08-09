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

interface ManagedPlayerResource<Player> {
  readonly player: Player
  destroyed: boolean
  removed: boolean
}

export function createManagedPlayerAdapter<Player>(
  contract: ManagedPlayerContract<Player>,
  options: MediaSessionAdapterOptions,
): LivePlayerAdapter {
  const driver: MediaResourceDriver<ManagedPlayerResource<Player>> = {
    initialResource: createResource(contract.initialPlayer),
    async create(source: LiveSource, generation: number): Promise<ManagedPlayerResource<Player>> {
      try {
        return createResource(await contract.createPlayer(source, generation))
      } catch {
        throw new PlayerAdapterError(
          `${contract.scope}-create-failed`,
          contract.operations.createCandidate,
        )
      }
    },
    activate(resource: ManagedPlayerResource<Player>, _source: LiveSource): void {
      contract.surface.stage(resource.player)
    },
    video(resource: ManagedPlayerResource<Player>): VideoElementLike {
      return contract.video(resource.player)
    },
    subscribe(
      resource: ManagedPlayerResource<Player>,
      listener: (event: ResourceEvent) => void,
    ): () => void {
      return contract.subscribe(resource.player, listener)
    },
    reveal(next: ManagedPlayerResource<Player>, previous: ManagedPlayerResource<Player>): void {
      contract.surface.reveal(next.player, previous.player)
    },
    release(resource: ManagedPlayerResource<Player>): void {
      let cleanupFailed = false
      if (!resource.destroyed) {
        try {
          contract.destroyPlayer(resource.player)
          resource.destroyed = true
        } catch {
          cleanupFailed = true
        }
      }
      if (!resource.removed) {
        try {
          contract.surface.remove(resource.player)
          resource.removed = true
        } catch {
          cleanupFailed = true
        }
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

  function createResource(player: Player): ManagedPlayerResource<Player> {
    return { player, destroyed: false, removed: false }
  }
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
