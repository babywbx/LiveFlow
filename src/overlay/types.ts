import type { Destroyable } from '../shared/disposable.js'
import type { DanmakuIdentity } from '../danmaku/types.js'

export type OverlayNode =
  | { type: 'text'; role: string; text: string }
  | { type: 'identity'; identity: DanmakuIdentity }
  | { type: 'asset'; role: string; assetKey: string; alt: string }
  | { type: 'metric'; role: string; label: string; value: string }

export interface RealtimeOverlayEvent {
  id: string
  dedupeKey?: string
  kind: string
  receivedAt: number
  priority: number
  durationMs: number
  nodes: readonly OverlayNode[]
}

export interface OverlayLimits {
  maxPending: number
  maxVisible: number
  maxNodesPerEvent: number
  maxLabelLength: number
  dedupeWindowMs: number
  maxEventLifetimeMs: number
}

export interface OverlayMetrics {
  received: number
  displayed: number
  deduped: number
  expired: number
  dropped: number
  budgetDenied: number
}

export interface OverlayRenderer extends Destroyable {
  render(event: RealtimeOverlayEvent, container: HTMLElement): Destroyable
}

export type OverlayPresentation = 'full' | 'compact' | 'suppressed'

export interface OverlayBudgetGrant extends Destroyable {
  readonly presentation: OverlayPresentation
}

export interface OverlayBudgetCoordinator extends Destroyable {
  register(instanceId: string, weight: number): Destroyable
  request(instanceId: string, priority: number): OverlayBudgetGrant | null
  getMetrics(): OverlayMetrics
}
