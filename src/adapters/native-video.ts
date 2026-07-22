import type { EngineHooks } from '../shared/diagnostics.js'
import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js'
import { PlayerAdapterError } from './adapter-error.js'
import {
  createMediaSessionAdapter,
  type MediaResourceDriver,
  type ResourceEvent,
  type VideoElementLike,
} from './media-session-adapter.js'

export interface NativeVideoAdapterOptions extends EngineHooks {
  readonly video: VideoElementLike
  readonly surface?: NativeVideoSurface
  readonly crossOrigin?: 'anonymous' | 'use-credentials'
  readonly now?: () => number
}

export interface NativeVideoSurface {
  createVideo(): VideoElementLike
  stage(video: VideoElementLike): void
  reveal(video: VideoElementLike, previous: VideoElementLike): void
  remove(video: VideoElementLike): void
}

interface NativeResource {
  readonly video: VideoElementLike
  removeOnRelease: boolean
}

export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js'
export { PlayerAdapterError } from './adapter-error.js'

export function createNativeVideoAdapter(options: NativeVideoAdapterOptions): LivePlayerAdapter {
  const surface = options.surface ?? createDefaultNativeVideoSurface(options.video)
  const driver: MediaResourceDriver<NativeResource> = {
    initialResource: {
      video: options.video,
      removeOnRelease: false,
    },
    create(_source: LiveSource, _generation: number): Promise<NativeResource> {
      const video = surface.createVideo()
      try {
        surface.stage(video)
      } catch {
        let cleanupFailed = false
        try {
          cleanupVideo(video)
        } catch {
          cleanupFailed = true
        }
        try {
          surface.remove(video)
        } catch {
          cleanupFailed = true
        }
        throw new PlayerAdapterError(
          cleanupFailed ? 'native-video-stage-cleanup-failed' : 'native-video-stage-failed',
          'stage a video',
        )
      }
      return Promise.resolve({
        video,
        removeOnRelease: true,
      })
    },
    activate(resource: NativeResource, source: LiveSource): void {
      resource.video.preload = 'auto'
      if (options.crossOrigin !== undefined) {
        resource.video.crossOrigin = options.crossOrigin
      }
      resource.video.src = source.url
      resource.video.load()
    },
    video(resource: NativeResource): VideoElementLike {
      return resource.video
    },
    subscribe(resource: NativeResource, listener: (event: ResourceEvent) => void): () => void {
      return subscribeToVideo(resource.video, listener)
    },
    reveal(next: NativeResource, previous: NativeResource): void {
      surface.reveal(next.video, previous.video)
      previous.removeOnRelease = true
    },
    release(resource: NativeResource): void {
      let cleanupFailed = false
      try {
        cleanupVideo(resource.video)
      } catch {
        cleanupFailed = true
      }
      try {
        if (resource.removeOnRelease) {
          surface.remove(resource.video)
        }
      } catch {
        cleanupFailed = true
      }
      if (cleanupFailed) {
        throw new PlayerAdapterError('native-video-cleanup-failed', 'release a video')
      }
    },
  }

  return createMediaSessionAdapter(driver, options)
}

function subscribeToVideo(
  video: VideoElementLike,
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
    listener({
      type: 'error',
      code: `media-error-${String(video.error?.code ?? 0)}`,
      recoverable: video.error?.code !== 4,
    })
  }
  const registrations = [
    ['loadeddata', ready],
    ['canplay', ready],
    ['playing', playing],
    ['waiting', waiting],
    ['stalled', stalled],
    ['ended', ended],
    ['error', error],
  ] as const

  const subscribed: Array<(typeof registrations)[number]> = []
  try {
    for (const registration of registrations) {
      const [type, handler] = registration
      video.addEventListener(type, handler)
      subscribed.push(registration)
    }
  } catch {
    for (const [type, handler] of subscribed) {
      try {
        video.removeEventListener(type, handler)
      } catch {
        continue
      }
    }
    throw new PlayerAdapterError('native-video-subscribe-failed', 'subscribe to video events')
  }
  if (video.readyState >= 2) {
    ready()
  }

  return () => {
    let cleanupFailed = false
    for (const [type, handler] of registrations) {
      try {
        video.removeEventListener(type, handler)
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupFailed) {
      throw new PlayerAdapterError(
        'native-video-unsubscribe-failed',
        'unsubscribe from video events',
      )
    }
  }
}

function cleanupVideo(video: VideoElementLike): void {
  let cleanupFailed = false
  try {
    video.pause()
  } catch {
    cleanupFailed = true
  }
  try {
    video.removeAttribute('src')
  } catch {
    cleanupFailed = true
  }
  try {
    video.load()
  } catch {
    cleanupFailed = true
  }
  if (cleanupFailed) {
    throw new PlayerAdapterError('native-video-cleanup-failed', 'clear a video resource')
  }
}

function createDefaultNativeVideoSurface(initial: VideoElementLike): NativeVideoSurface {
  if (
    typeof HTMLVideoElement === 'undefined' ||
    !(initial instanceof HTMLVideoElement) ||
    initial.parentElement === null
  ) {
    throw new PlayerAdapterError('native-video-surface-required', 'create the video surface')
  }

  const parent = initial.parentElement
  const ownerDocument = initial.ownerDocument
  return {
    createVideo(): VideoElementLike {
      const video = ownerDocument.createElement('video')
      video.controls = initial.controls
      video.playsInline = initial.playsInline
      video.className = initial.className
      return video
    },
    stage(video: VideoElementLike): void {
      if (!(video instanceof HTMLVideoElement)) {
        throw new PlayerAdapterError('invalid-native-video', 'stage a video')
      }
      video.hidden = true
      parent.append(video)
    },
    reveal(video: VideoElementLike, previous: VideoElementLike): void {
      if (!(video instanceof HTMLVideoElement) || !(previous instanceof HTMLVideoElement)) {
        throw new PlayerAdapterError('invalid-native-video', 'reveal a video')
      }
      video.hidden = false
      previous.hidden = true
    },
    remove(video: VideoElementLike): void {
      if (video instanceof HTMLVideoElement) {
        video.remove()
      }
    },
  }
}
