import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js'
import type { EngineHooks } from '../shared/diagnostics.js'
import { PlayerAdapterError } from './adapter-error.js'
import { bindManagedEvents, createManagedPlayerAdapter } from './managed-player.js'
import type { ResourceEvent, VideoElementLike } from './media-session-adapter.js'

export interface VideoJsHostElementLike {
  querySelector(selectors: string): unknown
}

export interface VideoJsPlayerLike {
  el(): VideoJsHostElementLike | null
  on(event: string, handler: (...args: readonly unknown[]) => void): void
  off(event: string, handler: (...args: readonly unknown[]) => void): void
  dispose(): void
}

export interface VideoJsSurface {
  stage(player: VideoJsPlayerLike): void
  reveal(player: VideoJsPlayerLike, previous: VideoJsPlayerLike): void
  remove(player: VideoJsPlayerLike): void
}

export interface VideoJsAdapterOptions extends EngineHooks {
  readonly player: VideoJsPlayerLike
  readonly createPlayer: (
    source: LiveSource,
    generation: number,
  ) => VideoJsPlayerLike | Promise<VideoJsPlayerLike>
  readonly surface?: VideoJsSurface
  readonly now?: () => number
}

export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js'
export { PlayerAdapterError } from './adapter-error.js'

export function createVideoJsAdapter(options: VideoJsAdapterOptions): LivePlayerAdapter {
  requireVideo(options.player)
  const surface = options.surface ?? createDefaultVideoJsSurface(options.player)

  return createManagedPlayerAdapter<VideoJsPlayerLike>(
    {
      scope: 'videojs',
      operations: {
        createCandidate: 'create a Video.js candidate',
        releaseFailedCandidate: 'release a failed Video.js candidate',
        releaseInstance: 'release a Video.js instance',
      },
      initialPlayer: options.player,
      surface,
      createPlayer: options.createPlayer,
      video: requireVideo,
      subscribe: subscribeToVideoJs,
      destroyPlayer(player: VideoJsPlayerLike): void {
        player.dispose()
      },
    },
    options,
  )
}

function requireVideo(player: VideoJsPlayerLike): VideoElementLike {
  const candidate = player.el()?.querySelector('video')
  if (candidate === undefined || !isVideoElementLike(candidate)) {
    throw new PlayerAdapterError('videojs-video-missing', 'access the Video.js media element')
  }
  return candidate
}

function isVideoElementLike(value: unknown): value is VideoElementLike {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'play' in value &&
    typeof value.play === 'function' &&
    'pause' in value &&
    typeof value.pause === 'function' &&
    'load' in value &&
    typeof value.load === 'function' &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function' &&
    'buffered' in value
  )
}

function subscribeToVideoJs(
  player: VideoJsPlayerLike,
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
    listener({ type: 'error', code: 'videojs-media-error', recoverable: true })
  }
  const externallyDisposed = (): void => {
    listener({ type: 'error', code: 'videojs-disposed', recoverable: false })
  }
  const registrations = [
    ['loadeddata', ready],
    ['canplay', ready],
    ['playing', playing],
    ['waiting', waiting],
    ['stalled', stalled],
    ['ended', ended],
    ['error', error],
    ['dispose', externallyDisposed],
  ] as const

  const video = requireVideo(player)
  const unsubscribe = bindManagedEvents('videojs', 'Video.js', player, registrations)
  if (video.readyState >= 2) {
    ready()
  }

  return unsubscribe
}

interface HidableHostLike {
  hidden: boolean
  remove(): void
}

function isHidableHost(
  value: VideoJsHostElementLike,
): value is VideoJsHostElementLike & HidableHostLike {
  if (!('hidden' in value) || typeof value.hidden !== 'boolean') {
    return false
  }
  return 'remove' in value && typeof value.remove === 'function'
}

function requireHidableHost(player: VideoJsPlayerLike, operation: string): HidableHostLike {
  const host = player.el()
  if (host === null || !isHidableHost(host)) {
    throw new PlayerAdapterError('videojs-host-missing', operation)
  }
  return host
}

function createDefaultVideoJsSurface(initial: VideoJsPlayerLike): VideoJsSurface {
  const host = initial.el()
  if (host === null || !isHidableHost(host)) {
    throw new PlayerAdapterError('videojs-surface-required', 'create the Video.js surface')
  }

  return {
    stage(player: VideoJsPlayerLike): void {
      requireHidableHost(player, 'stage a Video.js candidate').hidden = true
    },
    reveal(player: VideoJsPlayerLike, previous: VideoJsPlayerLike): void {
      const nextHost = requireHidableHost(player, 'reveal a Video.js candidate')
      const previousHost = requireHidableHost(previous, 'reveal a Video.js candidate')
      nextHost.hidden = false
      previousHost.hidden = true
    },
    remove(player: VideoJsPlayerLike): void {
      // dispose() already detaches the element; tolerate a null host.
      const removable = player.el()
      if (removable !== null && isHidableHost(removable)) {
        removable.remove()
      }
    },
  }
}
