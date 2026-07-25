import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js'
import type { EngineHooks } from '../shared/diagnostics.js'
import { PlayerAdapterError } from './adapter-error.js'
import { bindManagedEvents, createManagedPlayerAdapter } from './managed-player.js'
import type { ResourceEvent, VideoElementLike } from './media-session-adapter.js'

export interface DPlayerLike {
  readonly video: VideoElementLike
  readonly container?: HTMLElement
  on(event: string, handler: (...args: readonly unknown[]) => void): void
  destroy(): void
}

export interface DPlayerSurface {
  stage(player: DPlayerLike): void
  reveal(player: DPlayerLike, previous: DPlayerLike): void
  remove(player: DPlayerLike): void
}

export interface DPlayerAdapterOptions extends EngineHooks {
  readonly player: DPlayerLike
  readonly createPlayer: (
    source: LiveSource,
    generation: number,
  ) => DPlayerLike | Promise<DPlayerLike>
  readonly surface?: DPlayerSurface
  readonly now?: () => number
}

export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js'
export { PlayerAdapterError } from './adapter-error.js'

export function createDPlayerAdapter(options: DPlayerAdapterOptions): LivePlayerAdapter {
  const surface = options.surface ?? createDefaultDPlayerSurface(options.player)

  return createManagedPlayerAdapter<DPlayerLike>(
    {
      scope: 'dplayer',
      operations: {
        createCandidate: 'create a DPlayer candidate',
        releaseFailedCandidate: 'release a failed DPlayer candidate',
        releaseInstance: 'release a DPlayer instance',
      },
      initialPlayer: options.player,
      surface,
      createPlayer: options.createPlayer,
      video(player: DPlayerLike): VideoElementLike {
        return player.video
      },
      subscribe: subscribeToDPlayer,
      destroyPlayer(player: DPlayerLike): void {
        player.destroy()
      },
    },
    options,
  )
}

// DPlayer has no off(); a disposed flag keeps handlers inert.
function subscribeToDPlayer(
  player: DPlayerLike,
  listener: (event: ResourceEvent) => void,
): () => void {
  let disposed = false
  const forward = (event: ResourceEvent): void => {
    if (!disposed) {
      listener(event)
    }
  }
  const ready = (): void => {
    forward({ type: 'ready' })
  }
  const playing = (): void => {
    forward({ type: 'playing' })
  }
  const waiting = (): void => {
    forward({ type: 'waiting' })
  }
  const stalled = (): void => {
    forward({ type: 'stalled' })
  }
  const ended = (): void => {
    forward({ type: 'ended' })
  }
  const error = (): void => {
    forward({ type: 'error', code: 'dplayer-media-error', recoverable: true })
  }
  const externallyDestroyed = (): void => {
    forward({ type: 'error', code: 'dplayer-destroyed', recoverable: false })
  }
  const registrations = [
    ['loadeddata', ready],
    ['canplay', ready],
    ['playing', playing],
    ['waiting', waiting],
    ['stalled', stalled],
    ['ended', ended],
    ['error', error],
    ['destroy', externallyDestroyed],
  ] as const

  try {
    bindManagedEvents('dplayer', 'DPlayer', player, registrations)
  } catch (bindError) {
    disposed = true
    throw bindError
  }
  if (player.video.readyState >= 2) {
    ready()
  }

  return () => {
    disposed = true
  }
}

function createDefaultDPlayerSurface(initial: DPlayerLike): DPlayerSurface {
  if (initial.container === undefined) {
    throw new PlayerAdapterError('dplayer-surface-required', 'create the DPlayer surface')
  }

  return {
    stage(player: DPlayerLike): void {
      if (player.container === undefined) {
        throw new PlayerAdapterError('dplayer-container-missing', 'stage a DPlayer candidate')
      }
      player.container.hidden = true
    },
    reveal(player: DPlayerLike, previous: DPlayerLike): void {
      if (player.container === undefined || previous.container === undefined) {
        throw new PlayerAdapterError('dplayer-container-missing', 'reveal a DPlayer candidate')
      }
      player.container.hidden = false
      previous.container.hidden = true
    },
    remove(player: DPlayerLike): void {
      player.container?.remove()
    },
  }
}
