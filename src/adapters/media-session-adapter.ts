import { CapacityExceededError } from '../shared/errors.js'
import type {
  LivePlayerAdapter,
  LiveSource,
  PlaybackEvent,
  PlaybackEventListener,
  PlaybackMetrics,
  PreparedSource,
} from '../continuity/types.js'
import type { EngineHooks } from '../shared/diagnostics.js'
import { PlayerAdapterError } from './adapter-error.js'

const MAX_LISTENERS = 32
const MAX_PREPARED_SESSIONS = 4

export interface TimeRangesLike {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export interface VideoElementLike {
  src: string
  crossOrigin: string | null
  preload: string
  currentTime: number
  playbackRate: number
  muted: boolean
  volume: number
  readonly paused: boolean
  readonly ended: boolean
  readonly readyState: number
  readonly buffered: TimeRangesLike
  readonly error: { readonly code: number } | null
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  load(): void
  play(): Promise<void>
  pause(): void
  removeAttribute(name: string): void
  requestVideoFrameCallback?(callback: (timestampMs: number) => void): number
  cancelVideoFrameCallback?(handle: number): void
  getVideoPlaybackQuality?(): { readonly droppedVideoFrames: number }
}

export type ResourceEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'playing' }
  | { readonly type: 'waiting' }
  | { readonly type: 'stalled' }
  | { readonly type: 'ended' }
  | { readonly type: 'error'; readonly code: string; readonly recoverable: boolean }

export interface MediaResourceDriver<Resource> {
  readonly initialResource: Resource
  create(source: LiveSource, generation: number): Promise<Resource>
  activate(resource: Resource, source: LiveSource): void
  video(resource: Resource): VideoElementLike
  subscribe(resource: Resource, listener: (event: ResourceEvent) => void): () => void
  reveal(next: Resource, previous: Resource): void
  release(resource: Resource): void
}

export interface MediaSessionAdapterOptions extends EngineHooks {
  readonly now?: () => number
}

type PreparedToken = PreparedSource

interface Session<Resource> {
  readonly generation: number
  readonly prepared: PreparedToken
  readonly resource: Resource
  readonly unsubscribe: () => void
  stalledSince: number | null
  frameHandle: number | null
  committed: boolean
  released: boolean
}

export function createMediaSessionAdapter<Resource>(
  driver: MediaResourceDriver<Resource>,
  options: MediaSessionAdapterOptions,
): LivePlayerAdapter {
  const now = options.now ?? defaultNow
  const listeners = new Set<PlaybackEventListener>()
  const sessions = new Map<number, Session<Resource>>()
  const pendingCreations = new Set<Promise<Resource>>()
  let current: Session<Resource> | null = createInitialSession(driver.initialResource)
  let committed: Session<Resource> | null = null
  let destroyed = false
  let destroyPromise: Promise<void> | null = null
  let desiredMuted = driver.video(driver.initialResource).muted
  let desiredVolume = driver.video(driver.initialResource).volume
  let desiredPlaybackRate = driver.video(driver.initialResource).playbackRate

  return {
    async prepare(source: LiveSource, generation: number): Promise<PreparedSource> {
      ensureActive()
      if (sessions.has(generation)) {
        throw new PlayerAdapterError('duplicate-media-generation', 'prepare')
      }
      if (sessions.size + pendingCreations.size >= MAX_PREPARED_SESSIONS) {
        throw new CapacityExceededError('player-adapter-prepared-sessions', MAX_PREPARED_SESSIONS)
      }

      let creation: Promise<Resource>
      try {
        creation = driver.create(source, generation)
      } catch {
        throw new PlayerAdapterError('media-prepare-failed', 'prepare')
      }
      pendingCreations.add(creation)
      let resource: Resource
      try {
        resource = await creation
      } catch {
        throw new PlayerAdapterError('media-prepare-failed', 'prepare')
      } finally {
        pendingCreations.delete(creation)
      }

      const prepared: PreparedToken = Object.freeze({ generation })
      if (destroyed) {
        if (!releaseResource(resource)) {
          throw new PlayerAdapterError('media-release-failed', 'release a late media candidate')
        }
        return prepared
      }
      if (sessions.has(generation)) {
        releaseResource(resource)
        throw new PlayerAdapterError('duplicate-media-generation', 'prepare')
      }

      let session: Session<Resource> | null = null
      let unsubscribe: () => void
      try {
        unsubscribe = driver.subscribe(resource, (event) => {
          if (session !== null) {
            handleResourceEvent(session, event)
          }
        })
      } catch {
        releaseResource(resource)
        throw new PlayerAdapterError('media-subscribe-failed', 'subscribe to media events')
      }
      session = {
        generation,
        prepared,
        resource,
        unsubscribe,
        stalledSince: null,
        frameHandle: null,
        committed: false,
        released: false,
      }
      sessions.set(generation, session)

      try {
        applyCandidateControls(driver.video(resource))
        driver.activate(resource, source)
      } catch {
        sessions.delete(generation)
        releaseSession(session)
        throw new PlayerAdapterError('media-activation-failed', 'prepare')
      }

      return prepared
    },

    commit(prepared: PreparedSource, generation: number): Promise<void> {
      ensureActive()
      const session = sessions.get(generation)
      if (
        session === undefined ||
        session.prepared !== prepared ||
        prepared.generation !== generation
      ) {
        throw new PlayerAdapterError('unknown-prepared-source', 'commit')
      }

      if (committed !== null && committed !== session && committed !== current) {
        sessions.delete(committed.generation)
        releaseSession(committed)
      }
      session.committed = true
      committed = session
      const video = driver.video(session.resource)
      if (!video.paused && !video.ended) {
        requestFirstFrame(session)
      }
      return Promise.resolve()
    },

    discard(prepared: PreparedSource): Promise<void> {
      const session = sessions.get(prepared.generation)
      if (session === undefined || session.prepared !== prepared || session === current) {
        return Promise.resolve()
      }

      sessions.delete(session.generation)
      if (committed === session) {
        committed = null
      }
      if (!releaseSession(session)) {
        throw new PlayerAdapterError('media-discard-failed', 'discard a media candidate')
      }
      return Promise.resolve()
    },

    async play(): Promise<void> {
      ensureActive()
      const target = committed ?? current
      if (target === null || target.released) {
        throw new PlayerAdapterError('media-session-unavailable', 'play')
      }

      try {
        await driver.video(target.resource).play()
      } catch {
        throw new PlayerAdapterError('media-play-failed', 'play')
      }
    },

    pause(): void {
      ensureActive()
      try {
        if (current !== null) {
          driver.video(current.resource).pause()
        }
        if (committed !== null && committed !== current) {
          driver.video(committed.resource).pause()
        }
      } catch {
        throw new PlayerAdapterError('media-pause-failed', 'pause media')
      }
    },

    setMuted(muted: boolean): void {
      ensureActive()
      desiredMuted = muted
      try {
        if (current !== null) {
          driver.video(current.resource).muted = muted
        }
        if (committed !== null && committed !== current) {
          driver.video(committed.resource).muted = true
        }
      } catch {
        throw new PlayerAdapterError('media-mute-failed', 'set muted state')
      }
    },

    setVolume(volume: number): void {
      ensureActive()
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new PlayerAdapterError('invalid-media-volume', 'set volume')
      }
      desiredVolume = volume
      try {
        applyToLiveVideos((video) => {
          video.volume = volume
        })
      } catch {
        throw new PlayerAdapterError('media-volume-failed', 'set volume')
      }
    },

    setPlaybackRate(rate: number): void {
      ensureActive()
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new PlayerAdapterError('invalid-playback-rate', 'set playback rate')
      }
      desiredPlaybackRate = rate
      try {
        applyToLiveVideos((video) => {
          video.playbackRate = rate
        })
      } catch {
        throw new PlayerAdapterError('playback-rate-failed', 'set playback rate')
      }
    },

    getMetrics(): PlaybackMetrics {
      ensureActive()
      if (current === null) {
        throw new PlayerAdapterError('media-session-unavailable', 'read metrics')
      }

      try {
        const video = driver.video(current.resource)
        return readMetrics(video, current.stalledSince)
      } catch {
        throw new PlayerAdapterError('media-metrics-failed', 'read metrics')
      }
    },

    seek(seconds: number): void {
      ensureActive()
      if (current === null) {
        throw new PlayerAdapterError('media-session-unavailable', 'seek')
      }
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new PlayerAdapterError('media-seek-failed', 'seek')
      }

      try {
        driver.video(current.resource).currentTime = seconds
      } catch {
        throw new PlayerAdapterError('media-seek-failed', 'seek')
      }
    },

    subscribe(listener: PlaybackEventListener): () => void {
      ensureActive()
      if (!listeners.has(listener) && listeners.size >= MAX_LISTENERS) {
        throw new CapacityExceededError('player-adapter-listeners', MAX_LISTENERS)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    destroy(): Promise<void> {
      if (destroyPromise !== null) {
        return destroyPromise
      }
      destroyPromise = performDestroy()
      return destroyPromise
    },
  }

  function createInitialSession(resource: Resource): Session<Resource> {
    let session: Session<Resource> | null = null
    let unsubscribe: () => void
    try {
      unsubscribe = driver.subscribe(resource, (event) => {
        if (session !== null) {
          handleResourceEvent(session, event)
        }
      })
    } catch {
      throw new PlayerAdapterError('media-subscribe-failed', 'subscribe to initial media events')
    }
    session = {
      generation: 0,
      prepared: Object.freeze({ generation: 0 }),
      resource,
      unsubscribe,
      stalledSince: null,
      frameHandle: null,
      committed: true,
      released: false,
    }
    return session
  }

  function handleResourceEvent(session: Session<Resource>, event: ResourceEvent): void {
    if (destroyed || session.released) {
      return
    }
    if (session !== current && session !== committed && event.type !== 'ready') {
      return
    }

    if (event.type === 'playing') {
      session.stalledSince = null
      if (session === committed && session !== current) {
        requestFirstFrame(session)
      } else if (session === current) {
        emit({ type: 'playing', generation: session.generation })
      }
      return
    }

    if (event.type === 'waiting' || event.type === 'stalled') {
      session.stalledSince ??= now()
      emit({ type: event.type, generation: session.generation })
      return
    }

    if (event.type === 'ready') {
      emit({ type: 'ready', generation: session.generation })
      return
    }

    if (event.type === 'ended') {
      emit({ type: 'ended', generation: session.generation })
      return
    }

    emit({
      type: 'error',
      generation: session.generation,
      code: event.code,
      recoverable: event.recoverable,
    })
  }

  function requestFirstFrame(session: Session<Resource>): void {
    if (session.frameHandle !== null) {
      return
    }

    const video = driver.video(session.resource)
    if (video.requestVideoFrameCallback === undefined) {
      promote(session)
      return
    }

    try {
      session.frameHandle = video.requestVideoFrameCallback(() => {
        session.frameHandle = null
        promote(session)
      })
    } catch {
      emit({
        type: 'error',
        generation: session.generation,
        code: 'video-frame-callback-failed',
        recoverable: true,
      })
    }
  }

  function promote(session: Session<Resource>): void {
    if (destroyed || session.released || committed !== session || current === session) {
      return
    }

    const previous = current
    if (previous === null) {
      return
    }
    try {
      driver.reveal(session.resource, previous.resource)
    } catch {
      sessions.delete(session.generation)
      committed = null
      releaseSession(session)
      emit({
        type: 'error',
        generation: session.generation,
        code: 'adapter-reveal-failed',
        recoverable: true,
      })
      emitDiagnostic('media-reveal-failed', session.generation)
      return
    }

    current = session
    committed = session
    sessions.delete(session.generation)
    session.committed = true
    releaseSession(previous)
    emit({ type: 'first-frame', generation: session.generation })

    try {
      const video = driver.video(session.resource)
      video.muted = desiredMuted
      video.volume = desiredVolume
      video.playbackRate = desiredPlaybackRate
    } catch {
      emit({
        type: 'error',
        generation: session.generation,
        code: 'media-control-restore-failed',
        recoverable: true,
      })
      emitDiagnostic('media-control-restore-failed', session.generation)
      return
    }

    emit({ type: 'playing', generation: session.generation })
  }

  function releaseSession(session: Session<Resource>): boolean {
    if (session.released) {
      return true
    }
    session.released = true
    try {
      cancelFrame(session)
    } catch {
      emitDiagnostic('media-frame-cancel-failed', session.generation)
    }
    let unsubscribed = true
    try {
      session.unsubscribe()
    } catch {
      unsubscribed = false
      emitDiagnostic('media-unsubscribe-failed', session.generation)
    }
    const released = releaseResource(session.resource)
    return unsubscribed && released
  }

  function releaseResource(resource: Resource): boolean {
    try {
      driver.release(resource)
      return true
    } catch {
      emitDiagnostic('media-release-failed')
      return false
    }
  }

  function cancelFrame(session: Session<Resource>): void {
    if (session.frameHandle === null) {
      return
    }
    const handle = session.frameHandle
    session.frameHandle = null
    const video = driver.video(session.resource)
    if (video.cancelVideoFrameCallback !== undefined) {
      video.cancelVideoFrameCallback(handle)
    }
  }

  function applyCandidateControls(video: VideoElementLike): void {
    video.muted = true
    video.volume = desiredVolume
    video.playbackRate = desiredPlaybackRate
  }

  function applyToLiveVideos(operation: (video: VideoElementLike) => void): void {
    if (current !== null) {
      operation(driver.video(current.resource))
    }
    if (committed !== null && committed !== current) {
      operation(driver.video(committed.resource))
    }
  }

  function emit(event: PlaybackEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        emitDiagnostic('playback-listener-failed', event.generation)
      }
    }
  }

  function emitDiagnostic(code: string, generation?: number): void {
    if (options.onDiagnostic === undefined) {
      return
    }
    try {
      if (generation === undefined) {
        options.onDiagnostic({ scope: 'continuity', code, level: 'warn' })
      } else {
        options.onDiagnostic({ scope: 'continuity', code, level: 'warn', generation })
      }
    } catch {
      return
    }
  }

  function performDestroy(): Promise<void> {
    destroyed = true
    listeners.clear()
    const releasable = new Set<Session<Resource>>()
    if (current !== null) {
      releasable.add(current)
    }
    if (committed !== null) {
      releasable.add(committed)
    }
    for (const session of sessions.values()) {
      releasable.add(session)
    }
    sessions.clear()
    committed = null
    current = null
    let cleanupFailed = false
    for (const session of releasable) {
      if (!releaseSession(session)) {
        cleanupFailed = true
      }
    }
    if (cleanupFailed) {
      return Promise.reject(
        new PlayerAdapterError('player-adapter-cleanup-failed', 'destroy the adapter'),
      )
    }
    return Promise.resolve()
  }

  function ensureActive(): void {
    if (destroyed) {
      throw new PlayerAdapterError('player-adapter-destroyed', 'use a destroyed adapter')
    }
  }
}

function defaultNow(): number {
  return globalThis.performance.now()
}

function readMetrics(video: VideoElementLike, stalledSince: number | null): PlaybackMetrics {
  const currentTime = video.currentTime
  let bufferedAhead = 0
  let liveEdge = currentTime
  let inRange = false
  let nextStart: number | null = null

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index)
    const end = video.buffered.end(index)
    if (currentTime >= start && currentTime <= end) {
      inRange = true
      bufferedAhead = Math.max(bufferedAhead, end - currentTime)
    } else if (start > currentTime && (nextStart === null || start < nextStart)) {
      nextStart = start
    }
    liveEdge = Math.max(liveEdge, end)
  }

  const metrics: PlaybackMetrics = {
    currentTimeSeconds: currentTime,
    bufferedAheadSeconds: Math.max(0, bufferedAhead),
    liveEdgeDistanceSeconds: Math.max(0, liveEdge - currentTime),
    playbackRate: video.playbackRate,
    stalledSince,
    droppedFrames: video.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
  }
  if (inRange || nextStart === null) return metrics
  return { ...metrics, strandedGapSeconds: nextStart - currentTime }
}
