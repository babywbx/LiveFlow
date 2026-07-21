export type ContinuityState =
  | 'idle'
  | 'resolving'
  | 'warming'
  | 'playing'
  | 'degraded'
  | 'recovering'
  | 'waiting-reopen'
  | 'stopped'

export interface LiveSource {
  readonly url: string
  readonly kind: string
  readonly label?: string
}

export interface PreparedSource {
  readonly generation: number
}

export interface PlaybackMetrics {
  currentTimeSeconds: number
  bufferedAheadSeconds: number
  liveEdgeDistanceSeconds: number
  playbackRate: number
  stalledSince: number | null
  droppedFrames: number | null
}

export type PlaybackEvent =
  | { type: 'ready' }
  | { type: 'playing' }
  | { type: 'waiting' }
  | { type: 'stalled' }
  | { type: 'first-frame' }
  | { type: 'ended' }
  | { type: 'error'; code: string; recoverable: boolean }

export type PlaybackEventListener = (event: PlaybackEvent) => void

export interface LivePlayerAdapter {
  prepare(source: LiveSource, generation: number): Promise<PreparedSource>
  commit(prepared: PreparedSource, generation: number): Promise<void>
  discard(prepared: PreparedSource): Promise<void>
  play(): Promise<void>
  pause(): void
  setMuted(muted: boolean): void
  setVolume(volume: number): void
  setPlaybackRate(rate: number): void
  getMetrics(): PlaybackMetrics
  subscribe(listener: PlaybackEventListener): () => void
  destroy(): Promise<void>
}

export interface ContinuityPolicy {
  targetLatencySeconds: number
  softCatchupThresholdSeconds: number
  hardResyncThresholdSeconds: number
  catchupRate: number
  recoveryCooldownMs: number
  sourceWarmupTimeoutMs: number
  reopenGraceMs: number
  maxAutomaticRecoveries: number
}
