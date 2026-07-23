import type { AssetResolver } from '../danmaku/renderers/types.js';
import type { DanmakuIdentity } from '../danmaku/types.js';
import type { Clock } from '../shared/clock.js';
import type { EngineHooks } from '../shared/diagnostics.js';
import type { Destroyable } from '../shared/disposable.js';
export type OverlayNode = {
    type: 'text';
    role: string;
    text: string;
} | {
    type: 'identity';
    identity: DanmakuIdentity;
} | {
    type: 'asset';
    role: string;
    assetKey: string;
    alt: string;
} | {
    type: 'metric';
    role: string;
    label: string;
    value: string;
};
export interface RealtimeOverlayEvent {
    id: string;
    dedupeKey?: string;
    kind: string;
    receivedAt: number;
    priority: number;
    durationMs: number;
    nodes: readonly OverlayNode[];
}
export interface OverlayLimits {
    maxPending: number;
    maxVisible: number;
    maxNodesPerEvent: number;
    maxTextLength: number;
    maxLabelLength: number;
    maxKeyLength: number;
    maxRenderers: number;
    maxDedupeEntries: number;
    dedupeWindowMs: number;
    maxEventLifetimeMs: number;
}
export interface OverlayMetrics {
    received: number;
    accepted: number;
    displayed: number;
    fullDisplayed: number;
    compactDisplayed: number;
    deduped: number;
    expired: number;
    dropped: number;
    budgetDenied: number;
    renderFailed: number;
    pendingDepth: number;
    visible: number;
}
export type OverlayPresentation = 'full' | 'compact' | 'suppressed';
export interface OverlayRenderer extends Destroyable {
    render(event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable;
}
export interface SafeOverlayRendererOptions {
    readonly assetResolver?: AssetResolver;
}
export interface OverlayInstanceState {
    readonly weight: number;
    readonly focused: boolean;
    readonly visible: boolean;
}
export interface OverlayInstanceStateUpdate {
    readonly weight?: number;
    readonly focused?: boolean;
    readonly visible?: boolean;
}
export interface OverlayBudgetRequest {
    readonly priority: number;
    readonly highCost: boolean;
}
export type OverlayPresentationListener = (presentation: OverlayPresentation) => void;
export interface OverlayBudgetGrant extends Destroyable {
    readonly presentation: OverlayPresentation;
    subscribe(listener: OverlayPresentationListener): () => void;
}
export interface OverlayBudgetRegistration extends Destroyable {
    update(state: OverlayInstanceStateUpdate): void;
}
export interface OverlayBudgetCoordinator extends Destroyable {
    register(registration: OverlayInstanceState & {
        readonly instanceId: string;
    }): OverlayBudgetRegistration;
    request(instanceId: string, request: OverlayBudgetRequest): OverlayBudgetGrant;
    getMetrics(): OverlayBudgetMetrics;
}
export interface OverlayBudgetLimits {
    readonly maxInstances: number;
    readonly maxActiveCards: number;
    readonly maxFullCards: number;
    readonly maxHighCostAnimations: number;
}
export interface OverlayBudgetMetrics {
    readonly requests: number;
    readonly fullGranted: number;
    readonly compactGranted: number;
    readonly suppressed: number;
    readonly promoted: number;
    readonly downgraded: number;
    readonly released: number;
    readonly registeredInstances: number;
    readonly activeCards: number;
    readonly activeFull: number;
    readonly activeHighCost: number;
}
export interface OverlayEngineOptions extends EngineHooks {
    readonly contractVersion: number;
    readonly instanceId: string;
    readonly instanceState?: OverlayInstanceState;
    readonly clock?: Clock;
    readonly coordinator?: OverlayBudgetCoordinator;
    readonly limits?: Partial<OverlayLimits>;
    readonly defaultRenderer?: OverlayRenderer;
    readonly container?: HTMLElement;
    readonly assetResolver?: AssetResolver;
    readonly onError?: (error: Error) => void;
}
export type OverlaySubmitStatus = 'displayed' | 'queued' | 'deduped' | 'expired' | 'dropped';
export interface OverlaySubmitResult {
    readonly status: OverlaySubmitStatus;
}
export interface OverlayEngine extends Destroyable {
    submit(event: unknown): OverlaySubmitResult;
    registerRenderer(kind: string, renderer: OverlayRenderer): Destroyable;
    updateInstance(state: OverlayInstanceStateUpdate): void;
    getMetrics(): OverlayMetrics;
}
