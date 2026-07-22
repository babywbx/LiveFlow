import type { Clock } from '../shared/clock.js'
import type { EngineHooks } from '../shared/diagnostics.js'

export type DanmakuMode = 'scroll' | 'top' | 'bottom'

export interface DanmakuIdentity {
  kind: string
  label: string
  level?: number
  variant?: string
  assetKey?: string
}

export interface DanmakuSender {
  displayName?: string
}

export interface DanmakuMessage {
  id: string
  receivedAt: number
  text: string
  mode: DanmakuMode
  priority: number
  color?: string
  sender?: DanmakuSender
  identities?: readonly DanmakuIdentity[]
  metadata?: Readonly<Record<string, unknown>>
}

export interface DanmakuLimits {
  maxPending: number
  maxVisible: number
  maxPoolSize: number
  maxTextLength: number
  maxBadgesPerMessage: number
  maxMountsPerFrame: number
  maxMetadataKeys: number
  maxMetadataDepth: number
  maxMetadataBytes: number
  maxIntakePerSecond: number
  maxDisplayPerSecond: number
}

export type DanmakuDropReason =
  | 'duplicate'
  | 'expired'
  | 'input-rate'
  | 'pending-capacity'
  | 'display-rate'
  | 'visible-capacity'
  | 'no-lane'
  | 'text-too-long'
  | 'measurement-failed'

export interface DanmakuDropCounts {
  duplicate: number
  expired: number
  inputRate: number
  pendingCapacity: number
  displayRate: number
  visibleCapacity: number
  noLane: number
  textTooLong: number
  measurementFailed: number
}

export interface DanmakuMetrics {
  received: number
  displayed: number
  dropped: number
  pendingDepth: number
  visible: number
  frameBudgetOverruns: number
  metadataDiscarded: number
  readonly droppedByReason: Readonly<DanmakuDropCounts>
}

export interface DanmakuViewport {
  width: number
  height: number
}

export interface DanmakuMeasurement {
  readonly id: string
  readonly width: number
  readonly height: number
}

export interface DanmakuRenderItem {
  readonly message: DanmakuMessage
  readonly lane: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DanmakuRenderPosition {
  readonly id: string
  readonly x: number
  readonly y: number
}

export interface DanmakuRenderFrame {
  readonly timestamp: number
  readonly mounts: readonly DanmakuRenderItem[]
  readonly updates: readonly DanmakuRenderPosition[]
  readonly unmounts: readonly string[]
}

export interface DanmakuRenderer {
  measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[]
  render(frame: DanmakuRenderFrame): void
  resize(viewport: DanmakuViewport): void
  setPaused(paused: boolean): void
  destroy(): void
}

export type DanmakuDiagnosticCode =
  | 'metadata-discarded'
  | 'identities-truncated'
  | 'color-discarded'
  | 'renderer-failed'
  | 'clock-failed'
  | 'measurement-failed'
  | 'frame-budget-exceeded'

export interface DanmakuPushResult {
  readonly accepted: boolean
  readonly reason?: DanmakuDropReason
}

export interface DanmakuPolicy {
  readonly laneHeight: number
  readonly laneGap: number
  readonly scrollPixelsPerSecond: number
  readonly fixedDurationMs: number
  readonly maxPendingAgeMs: number
  readonly maxLaneWaitMs: number
  readonly duplicateWindowMs: number
  readonly frameBudgetMs: number
}

export interface DanmakuEngineOptions extends EngineHooks {
  readonly contractVersion: number
  readonly renderer: DanmakuRenderer
  readonly viewport: DanmakuViewport
  readonly clock?: Clock
  readonly limits?: Partial<DanmakuLimits>
  readonly policy?: Partial<DanmakuPolicy>
}

export interface DanmakuEngine {
  push(message: DanmakuMessage): DanmakuPushResult
  getMetrics(): DanmakuMetrics
  pause(): void
  resume(): void
  resize(viewport: DanmakuViewport): void
  destroy(): void
}
