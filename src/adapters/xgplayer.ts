import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js'
import type { EngineHooks } from '../shared/diagnostics.js'
import { PlayerAdapterError } from './adapter-error.js'
import { bindManagedEvents, createManagedPlayerAdapter } from './managed-player.js'
import type { ResourceEvent, VideoElementLike } from './media-session-adapter.js'

export interface XgPlayerLike {
  readonly media?: VideoElementLike | null
  readonly video?: VideoElementLike | null
  readonly root?: HTMLElement | null
  on(event: string, handler: (...args: readonly unknown[]) => void): void
  off(event: string, handler: (...args: readonly unknown[]) => void): void
  destroy(): void
}

export interface XgPlayerSurface {
  stage(player: XgPlayerLike): void
  reveal(player: XgPlayerLike, previous: XgPlayerLike): void
  remove(player: XgPlayerLike): void
}

export interface XgPlayerAdapterOptions extends EngineHooks {
  readonly player: XgPlayerLike
  readonly createPlayer: (
    source: LiveSource,
    generation: number,
  ) => XgPlayerLike | Promise<XgPlayerLike>
  readonly surface?: XgPlayerSurface
  readonly now?: () => number
}

export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js'
export { PlayerAdapterError } from './adapter-error.js'

export function createXgPlayerAdapter(options: XgPlayerAdapterOptions): LivePlayerAdapter {
  requireMedia(options.player)
  const surface = options.surface ?? createDefaultXgPlayerSurface(options.player)

  return createManagedPlayerAdapter<XgPlayerLike>(
    {
      scope: 'xgplayer',
      operations: {
        createCandidate: 'create an XGPlayer candidate',
        releaseFailedCandidate: 'release a failed XGPlayer candidate',
        releaseInstance: 'release an XGPlayer instance',
      },
      initialPlayer: options.player,
      surface,
      createPlayer: options.createPlayer,
      video: requireMedia,
      subscribe: subscribeToXgPlayer,
      destroyPlayer(player: XgPlayerLike): void {
        player.destroy()
      },
    },
    options,
  )
}

function requireMedia(player: XgPlayerLike): VideoElementLike {
  const media = player.media ?? player.video
  if (media === undefined || media === null) {
    throw new PlayerAdapterError('xgplayer-media-missing', 'access the XGPlayer media element')
  }
  return media
}

function subscribeToXgPlayer(
  player: XgPlayerLike,
  listener: (event: ResourceEvent) => void,
): () => void {
  const ready = (): void => {
    listener({ type: 'ready' })
  }
  const playing = (): void => {
    listener({ type: 'playing' })
  }
  const waiting = (): void => {
    listener({ type: 'waiting' })
  }
  const stalled = (): void => {
    listener({ type: 'stalled' })
  }
  const ended = (): void => {
    listener({ type: 'ended' })
  }
  const error = (): void => {
    listener({ type: 'error', code: 'xgplayer-media-error', recoverable: true })
  }
  const externallyDestroyed = (): void => {
    listener({ type: 'error', code: 'xgplayer-destroyed', recoverable: false })
  }
  const registrations = [
    ['ready', ready],
    ['loadeddata', ready],
    ['canplay', ready],
    ['playing', playing],
    ['waiting', waiting],
    ['stalled', stalled],
    ['ended', ended],
    ['error', error],
    ['destroy', externallyDestroyed],
  ] as const

  const media = requireMedia(player)
  const unsubscribe = bindManagedEvents('xgplayer', 'XGPlayer', player, registrations)
  if (media.readyState >= 2) {
    ready()
  }

  return unsubscribe
}

function createDefaultXgPlayerSurface(initial: XgPlayerLike): XgPlayerSurface {
  if (initial.root === undefined || initial.root === null) {
    throw new PlayerAdapterError('xgplayer-surface-required', 'create the XGPlayer surface')
  }

  return {
    stage(player: XgPlayerLike): void {
      if (player.root === undefined || player.root === null) {
        throw new PlayerAdapterError('xgplayer-root-missing', 'stage an XGPlayer candidate')
      }
      player.root.hidden = true
    },
    reveal(player: XgPlayerLike, previous: XgPlayerLike): void {
      if (
        player.root === undefined ||
        player.root === null ||
        previous.root === undefined ||
        previous.root === null
      ) {
        throw new PlayerAdapterError('xgplayer-root-missing', 'reveal an XGPlayer candidate')
      }
      player.root.hidden = false
      previous.root.hidden = true
    },
    remove(player: XgPlayerLike): void {
      player.root?.remove()
    },
  }
}
