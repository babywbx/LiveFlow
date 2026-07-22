import type {
  LivePlayerAdapter,
  LiveSource,
  PlaybackEventListener,
  PlaybackMetrics,
  PreparedSource,
} from '../continuity/types.js'
import type { EngineHooks } from '../shared/diagnostics.js'
import { PlayerAdapterError } from './adapter-error.js'
import {
  createMediaSessionAdapter,
  type MediaResourceDriver,
  type ResourceEvent,
  type VideoElementLike,
} from './media-session-adapter.js'

export interface ArtPlayerLike<OverlayContainer = HTMLElement> {
  readonly video: VideoElementLike
  readonly container?: HTMLElement
  readonly overlayContainer?: OverlayContainer
  on(event: string, handler: (...args: readonly unknown[]) => void): void
  off(event: string, handler: (...args: readonly unknown[]) => void): void
  setMutex(enabled: boolean): void
  destroy(): void
}

export interface ArtPlayerCreationOptions {
  readonly mutex: false
}

export interface ArtPlayerSurface<OverlayContainer = HTMLElement> {
  stage(player: ArtPlayerLike<OverlayContainer>): void
  reveal(player: ArtPlayerLike<OverlayContainer>, previous: ArtPlayerLike<OverlayContainer>): void
  remove(player: ArtPlayerLike<OverlayContainer>): void
}

export interface ArtPlayerAdapterOptions<OverlayContainer = HTMLElement> extends EngineHooks {
  readonly player: ArtPlayerLike<OverlayContainer>
  readonly createPlayer: (
    source: LiveSource,
    generation: number,
    options: ArtPlayerCreationOptions,
  ) => ArtPlayerLike<OverlayContainer> | Promise<ArtPlayerLike<OverlayContainer>>
  readonly surface?: ArtPlayerSurface<OverlayContainer>
  readonly overlayContainer?: OverlayContainer
  readonly now?: () => number
}

export interface ArtPlayerAdapter<OverlayContainer = HTMLElement> extends LivePlayerAdapter {
  getOverlayContainer(): OverlayContainer | null
}

export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js'
export { PlayerAdapterError } from './adapter-error.js'

export function createArtPlayerAdapter<OverlayContainer = HTMLElement>(
  options: ArtPlayerAdapterOptions<OverlayContainer>,
): ArtPlayerAdapter<OverlayContainer> {
  const surface = options.surface ?? createDefaultArtPlayerSurface(options.player)
  let visiblePlayer: ArtPlayerLike<OverlayContainer> | null = options.player
  try {
    options.player.setMutex(false)
  } catch {
    throw new PlayerAdapterError('artplayer-mutex-failed', 'disable the initial player mutex')
  }

  const driver: MediaResourceDriver<ArtPlayerLike<OverlayContainer>> = {
    initialResource: options.player,
    async create(source: LiveSource, generation: number): Promise<ArtPlayerLike<OverlayContainer>> {
      let player: ArtPlayerLike<OverlayContainer> | null = null
      try {
        player = await options.createPlayer(source, generation, { mutex: false })
        player.setMutex(false)
        surface.stage(player)
      } catch {
        if (player !== null) {
          let cleanupFailed = false
          try {
            player.destroy()
          } catch {
            cleanupFailed = true
          }
          try {
            surface.remove(player)
          } catch {
            cleanupFailed = true
          }
          if (cleanupFailed) {
            throw new PlayerAdapterError(
              'artplayer-cleanup-failed',
              'release a failed ArtPlayer candidate',
            )
          }
        }
        throw new PlayerAdapterError('artplayer-create-failed', 'create an ArtPlayer candidate')
      }
      return player
    },
    activate(_resource: ArtPlayerLike<OverlayContainer>, _source: LiveSource): void {},
    video(resource: ArtPlayerLike<OverlayContainer>): VideoElementLike {
      return resource.video
    },
    subscribe(
      resource: ArtPlayerLike<OverlayContainer>,
      listener: (event: ResourceEvent) => void,
    ): () => void {
      return subscribeToArtPlayer(resource, listener)
    },
    reveal(next: ArtPlayerLike<OverlayContainer>, previous: ArtPlayerLike<OverlayContainer>): void {
      surface.reveal(next, previous)
      visiblePlayer = next
    },
    release(resource: ArtPlayerLike<OverlayContainer>): void {
      let cleanupFailed = false
      try {
        resource.destroy()
      } catch {
        cleanupFailed = true
      }
      try {
        surface.remove(resource)
      } catch {
        cleanupFailed = true
      }
      if (visiblePlayer === resource) {
        visiblePlayer = null
      }
      if (cleanupFailed) {
        throw new PlayerAdapterError('artplayer-cleanup-failed', 'release an ArtPlayer instance')
      }
    },
  }

  const adapter = createMediaSessionAdapter(driver, options)

  return {
    prepare(source: LiveSource, generation: number): Promise<PreparedSource> {
      return adapter.prepare(source, generation)
    },
    commit(prepared: PreparedSource, generation: number): Promise<void> {
      return adapter.commit(prepared, generation)
    },
    discard(prepared: PreparedSource): Promise<void> {
      return adapter.discard(prepared)
    },
    play(): Promise<void> {
      return adapter.play()
    },
    pause(): void {
      adapter.pause()
    },
    setMuted(muted: boolean): void {
      adapter.setMuted(muted)
    },
    setVolume(volume: number): void {
      adapter.setVolume(volume)
    },
    setPlaybackRate(rate: number): void {
      adapter.setPlaybackRate(rate)
    },
    getMetrics(): PlaybackMetrics {
      return adapter.getMetrics()
    },
    subscribe(listener: PlaybackEventListener): () => void {
      return adapter.subscribe(listener)
    },
    destroy(): Promise<void> {
      return adapter.destroy()
    },
    getOverlayContainer(): OverlayContainer | null {
      return visiblePlayer?.overlayContainer ?? options.overlayContainer ?? null
    },
  }
}

function subscribeToArtPlayer<OverlayContainer>(
  player: ArtPlayerLike<OverlayContainer>,
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
    listener({ type: 'error', code: 'artplayer-media-error', recoverable: true })
  }
  const externallyDestroyed = (): void => {
    listener({ type: 'error', code: 'artplayer-destroyed', recoverable: false })
  }
  const registrations = [
    ['ready', ready],
    ['video:loadeddata', ready],
    ['playing', playing],
    ['video:playing', playing],
    ['waiting', waiting],
    ['video:waiting', waiting],
    ['stalled', stalled],
    ['video:stalled', stalled],
    ['ended', ended],
    ['video:ended', ended],
    ['error', error],
    ['video:error', error],
    ['destroy', externallyDestroyed],
  ] as const

  const subscribed: Array<(typeof registrations)[number]> = []
  try {
    for (const registration of registrations) {
      const [event, handler] = registration
      player.on(event, handler)
      subscribed.push(registration)
    }
  } catch {
    for (const [event, handler] of subscribed) {
      try {
        player.off(event, handler)
      } catch {
        continue
      }
    }
    throw new PlayerAdapterError('artplayer-subscribe-failed', 'subscribe to ArtPlayer events')
  }
  if (player.video.readyState >= 2) {
    ready()
  }

  return () => {
    let cleanupFailed = false
    for (const [event, handler] of registrations) {
      try {
        player.off(event, handler)
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupFailed) {
      throw new PlayerAdapterError(
        'artplayer-unsubscribe-failed',
        'unsubscribe from ArtPlayer events',
      )
    }
  }
}

function createDefaultArtPlayerSurface<OverlayContainer>(
  initial: ArtPlayerLike<OverlayContainer>,
): ArtPlayerSurface<OverlayContainer> {
  if (initial.container === undefined) {
    throw new PlayerAdapterError('artplayer-surface-required', 'create the ArtPlayer surface')
  }

  return {
    stage(player: ArtPlayerLike<OverlayContainer>): void {
      if (player.container === undefined) {
        throw new PlayerAdapterError('artplayer-container-missing', 'stage an ArtPlayer candidate')
      }
      player.container.hidden = true
    },
    reveal(
      player: ArtPlayerLike<OverlayContainer>,
      previous: ArtPlayerLike<OverlayContainer>,
    ): void {
      if (player.container === undefined || previous.container === undefined) {
        throw new PlayerAdapterError('artplayer-container-missing', 'reveal an ArtPlayer candidate')
      }
      player.container.hidden = false
      previous.container.hidden = true
    },
    remove(player: ArtPlayerLike<OverlayContainer>): void {
      player.container?.remove()
    },
  }
}
