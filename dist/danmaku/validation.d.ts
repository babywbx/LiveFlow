import type { DiagnosticEvent } from '../shared/diagnostics.js';
import type { DanmakuLimits, DanmakuMessage, DanmakuPolicy, DanmakuViewport } from './types.js';
export declare const DEFAULT_DANMAKU_LIMITS: Readonly<DanmakuLimits>;
export declare const DEFAULT_DANMAKU_POLICY: Readonly<DanmakuPolicy>;
export interface SanitizedDanmakuMessage {
    readonly message: DanmakuMessage;
    readonly metadataDiscarded: boolean;
    readonly identitiesTruncated: boolean;
    readonly colorDiscarded: boolean;
}
interface RequiredDanmakuMessageFields {
    readonly id: string;
    readonly receivedAt: number;
    readonly text: string;
    readonly mode: DanmakuMessage['mode'];
    readonly priority: number;
}
export declare function resolveLimits(input: Partial<DanmakuLimits> | undefined): DanmakuLimits;
export declare function resolvePolicy(input: Partial<DanmakuPolicy> | undefined): DanmakuPolicy;
export declare function validateViewport(viewport: DanmakuViewport): void;
export declare function sanitizeMessage(input: DanmakuMessage, required: RequiredDanmakuMessageFields, limits: DanmakuLimits): SanitizedDanmakuMessage;
export declare function emitSanitizationDiagnostics(sanitized: SanitizedDanmakuMessage, emit: (event: DiagnosticEvent) => void): void;
export declare function validateRequiredMessageFields(input: DanmakuMessage): RequiredDanmakuMessageFields;
export {};
