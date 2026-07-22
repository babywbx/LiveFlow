import type {
  LivePlayerAdapter,
  LiveSource,
  PlaybackEvent,
  PlaybackEventListener,
  PlaybackMetrics,
  PreparedSource,
} from '../../src/continuity/index.js'

const DEFAULT_METRICS: PlaybackMetrics = {
  currentTimeSeconds: 0,
  bufferedAheadSeconds: 0,
  liveEdgeDistanceSeconds: 0,
  playbackRate: 1,
  stalledSince: null,
  droppedFrames: null,
}

export class FakePlayerAdapter implements LivePlayerAdapter {
  private readonly listeners = new Set<PlaybackEventListener>()
  private readonly pendingPreparations = new Map<number, (prepared: PreparedSource) => void>()
  private readonly discarded = new Set<number>()
  private readonly liveResources = new Set<number>()
  private metrics = DEFAULT_METRICS
  private destroyed = false
  private destroyCalls = 0
  private currentPlaybackRate = 1
  private prepareError: Error | null = null
  private commitError: Error | null = null
  private playError: Error | null = null
  private metricsError: Error | null = null
  private playbackRateError: Error | null = null
  private deferPrepare = false
  private deferPlay = false
  private preparedGenerationOverride: number | null = null
  private stagedSourceGeneration: number | null = null
  private visibleSourceGeneration: number | null = null
  private pendingPlayResolve: (() => void) | null = null
  private playObservedResolve: (() => void) | null = null

  async prepare(_source: LiveSource, generation: number): Promise<PreparedSource> {
    if (this.prepareError !== null) {
      const error = this.prepareError
      this.prepareError = null
      throw error
    }
    if (this.deferPrepare) {
      return new Promise((resolve) => {
        this.pendingPreparations.set(generation, resolve)
      })
    }
    if (this.preparedGenerationOverride !== null) {
      const preparedGeneration = this.preparedGenerationOverride
      this.preparedGenerationOverride = null
      this.liveResources.add(preparedGeneration)
      return { generation: preparedGeneration }
    }
    this.liveResources.add(generation)
    return { generation }
  }

  async commit(_prepared: PreparedSource, generation: number): Promise<void> {
    if (this.commitError !== null) {
      const error = this.commitError
      this.commitError = null
      throw error
    }
    this.stagedSourceGeneration = generation
  }

  async discard(prepared: PreparedSource): Promise<void> {
    this.discarded.add(prepared.generation)
    this.liveResources.delete(prepared.generation)
    if (this.stagedSourceGeneration === prepared.generation) {
      this.stagedSourceGeneration = null
    }
  }

  async play(): Promise<void> {
    if (this.playError !== null) {
      const error = this.playError
      this.playError = null
      throw error
    }
    if (this.deferPlay) {
      if (this.playObservedResolve !== null) {
        this.playObservedResolve()
        this.playObservedResolve = null
      }
      await new Promise<void>((resolve) => {
        this.pendingPlayResolve = resolve
      })
    }
  }

  pause(): void {}

  setMuted(_muted: boolean): void {}

  setVolume(_volume: number): void {}

  setPlaybackRate(rate: number): void {
    if (this.playbackRateError !== null) {
      const error = this.playbackRateError
      this.playbackRateError = null
      throw error
    }
    this.currentPlaybackRate = rate
  }

  getMetrics(): PlaybackMetrics {
    if (this.metricsError !== null) {
      const error = this.metricsError
      this.metricsError = null
      throw error
    }
    return {
      ...this.metrics,
      playbackRate: this.currentPlaybackRate,
    }
  }

  subscribe(listener: PlaybackEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1
    this.destroyed = true
    this.listeners.clear()
    this.liveResources.clear()
    this.stagedSourceGeneration = null
    this.visibleSourceGeneration = null
  }

  emit(event: PlaybackEvent): void {
    if (event.type === 'first-frame' && this.stagedSourceGeneration === event.generation) {
      const previousVisibleGeneration = this.visibleSourceGeneration
      this.visibleSourceGeneration = event.generation
      this.stagedSourceGeneration = null
      if (
        previousVisibleGeneration !== null &&
        previousVisibleGeneration !== this.visibleSourceGeneration
      ) {
        this.liveResources.delete(previousVisibleGeneration)
      }
    }

    for (const listener of this.listeners) {
      listener(event)
    }
  }

  setMetrics(metrics: PlaybackMetrics): void {
    this.metrics = metrics
  }

  playbackRate(): number {
    return this.currentPlaybackRate
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroyCallCount(): number {
    return this.destroyCalls
  }

  failNextPrepare(error: Error): void {
    this.prepareError = error
  }

  failNextPlay(error: Error): void {
    this.playError = error
  }

  failNextCommit(error: Error): void {
    this.commitError = error
  }

  overrideNextPreparedGeneration(generation: number): void {
    this.preparedGenerationOverride = generation
  }

  failNextMetrics(error: Error): void {
    this.metricsError = error
  }

  failNextPlaybackRate(error: Error): void {
    this.playbackRateError = error
  }

  deferPreparations(): void {
    this.deferPrepare = true
  }

  deferPlaybackStart(): Promise<void> {
    this.deferPlay = true
    return new Promise((resolve) => {
      this.playObservedResolve = resolve
    })
  }

  resolvePlaybackStart(): void {
    if (this.pendingPlayResolve === null) {
      throw new Error('No pending playback start.')
    }

    const resolve = this.pendingPlayResolve
    this.pendingPlayResolve = null
    resolve()
  }

  resolvePreparation(generation: number): void {
    const resolve = this.pendingPreparations.get(generation)
    if (resolve === undefined) {
      throw new Error(`No pending preparation for generation ${String(generation)}.`)
    }

    this.pendingPreparations.delete(generation)
    this.liveResources.add(generation)
    resolve({ generation })
  }

  wasDiscarded(generation: number): boolean {
    return this.discarded.has(generation)
  }

  stagedGeneration(): number | null {
    return this.stagedSourceGeneration
  }

  visibleGeneration(): number | null {
    return this.visibleSourceGeneration
  }

  hasLiveResource(generation: number): boolean {
    return this.liveResources.has(generation)
  }
}
