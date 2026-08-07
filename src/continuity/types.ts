export type ContinuityState =
  | 'idle'
  | 'resolving'
  | 'warming'
  | 'playing'
  | 'degraded'
  | 'recovering'
  | 'waiting-reopen'
  | 'suspended'
  | 'stopped'

export type PlaybackSuspensionReason = 'browser-suspended' | 'autoplay-blocked'

export interface PlaybackSuspension {
  readonly reason: PlaybackSuspensionReason
  readonly generation: number
}

export interface PageActivitySource {
  isHidden(): boolean
  subscribe(listener: (hidden: boolean) => void): () => void
}

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
  strandedGapSeconds?: number | null
}

export type PlaybackEvent =
  | { type: 'ready'; generation: number }
  | { type: 'playing'; generation: number }
  | { type: 'waiting'; generation: number }
  | { type: 'stalled'; generation: number }
  | { type: 'first-frame'; generation: number }
  | { type: 'ended'; generation: number }
  | { type: 'error'; generation: number; code: string; recoverable: boolean }

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
  seek?(seconds: number): void
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
  maxGapJumpSeconds: number
  stallNudgeSeconds: number
  maxStallSeeksPerSource: number
}

export interface ContinuitySnapshot {
  readonly state: ContinuityState
  readonly generation: number
  readonly automaticRecoveryCount: number
  // Clock timestamp the current healthy streak began; null while not healthy.
  readonly healthySince: number | null
  readonly suspension: PlaybackSuspension | null
}

export type ContinuitySnapshotListener = (snapshot: ContinuitySnapshot) => void

export type ContinuityRecoveryReason = 'stall' | 'latency' | 'playback-error' | 'source-timeout'

export interface ContinuityRecoveryRequest {
  readonly reason: ContinuityRecoveryReason
  readonly generation: number
  readonly attempt: number
}

export type ContinuityRecoveryRequestListener = (request: ContinuityRecoveryRequest) => void

export interface ContinuityController {
  setSource(source: LiveSource): Promise<void>
  resume(): Promise<void>
  getSnapshot(): ContinuitySnapshot
  subscribe(listener: ContinuitySnapshotListener): () => void
  destroy(): Promise<void>
}
