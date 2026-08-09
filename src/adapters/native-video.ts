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
  readonly binding?: NativeVideoSourceBinding
  readonly crossOrigin?: 'anonymous' | 'use-credentials'
  readonly now?: () => number
}

export interface NativeVideoSourceBinding {
  attach(video: VideoElementLike, source: LiveSource): void
  detach(video: VideoElementLike): void
}

export interface NativeVideoSurface {
  createVideo(): VideoElementLike
  stage(video: VideoElementLike): void
  reveal(video: VideoElementLike, previous: VideoElementLike): void
  remove(video: VideoElementLike): void
}

interface NativeResource {
  readonly video: VideoElementLike
  bindingDetached: boolean
  mediaCleaned: boolean
  removed: boolean
  removeOnRelease: boolean
}

export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js'
export { PlayerAdapterError } from './adapter-error.js'

export function createNativeVideoAdapter(options: NativeVideoAdapterOptions): LivePlayerAdapter {
  const surface = options.surface ?? createDefaultNativeVideoSurface(options.video)
  const driver: MediaResourceDriver<NativeResource> = {
    initialResource: {
      video: options.video,
      bindingDetached: options.binding === undefined,
      mediaCleaned: false,
      removed: false,
      removeOnRelease: false,
    },
    create(_source: LiveSource, _generation: number): Promise<NativeResource> {
      const video = surface.createVideo()
      return Promise.resolve({
        video,
        bindingDetached: true,
        mediaCleaned: false,
        removed: false,
        removeOnRelease: true,
      })
    },
    activate(resource: NativeResource, source: LiveSource): void {
      surface.stage(resource.video)
      if (options.crossOrigin !== undefined) {
        resource.video.crossOrigin = options.crossOrigin
      }
      if (options.binding !== undefined) {
        resource.bindingDetached = false
        options.binding.attach(resource.video, source)
        return
      }
      resource.video.preload = 'auto'
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
      if (!resource.bindingDetached && options.binding !== undefined) {
        try {
          options.binding.detach(resource.video)
          resource.bindingDetached = true
        } catch {
          cleanupFailed = true
        }
      } else if (options.binding === undefined) {
        resource.bindingDetached = true
      }
      if (!resource.mediaCleaned) {
        try {
          cleanupVideo(resource.video)
          resource.mediaCleaned = true
        } catch {
          cleanupFailed = true
        }
      }
      if (!resource.removeOnRelease) {
        resource.removed = true
      } else if (!resource.removed) {
        try {
          surface.remove(resource.video)
          resource.removed = true
        } catch {
          cleanupFailed = true
        }
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
  const readyAtSubscription = video.readyState >= 2
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
  if (readyAtSubscription) {
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
