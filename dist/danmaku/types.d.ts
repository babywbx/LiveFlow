export type DanmakuMode = 'scroll' | 'top' | 'bottom';
export interface DanmakuIdentity {
    kind: string;
    label: string;
    level?: number;
    variant?: string;
    assetKey?: string;
}
export interface DanmakuSender {
    displayName?: string;
}
export interface DanmakuMessage {
    id: string;
    receivedAt: number;
    text: string;
    mode: DanmakuMode;
    priority: number;
    color?: string;
    sender?: DanmakuSender;
    identities?: readonly DanmakuIdentity[];
    metadata?: Readonly<Record<string, unknown>>;
}
export interface DanmakuLimits {
    maxPending: number;
    maxVisible: number;
    maxPoolSize: number;
    maxTextLength: number;
    maxBadgesPerMessage: number;
    maxMountsPerFrame: number;
    maxMetadataKeys: number;
    maxMetadataDepth: number;
    maxMetadataBytes: number;
    maxIntakePerSecond: number;
    maxDisplayPerSecond: number;
}
export interface DanmakuMetrics {
    received: number;
    displayed: number;
    dropped: number;
    pendingDepth: number;
    visible: number;
    frameBudgetOverruns: number;
}
