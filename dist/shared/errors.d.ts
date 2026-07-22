export declare class LiveFlowError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions);
}
export declare class ContractVersionMismatchError extends LiveFlowError {
    readonly expected: number;
    readonly received: number;
    constructor(expected: number, received: number);
}
export declare class AssetResolutionError extends LiveFlowError {
    readonly assetKey: string;
    constructor(assetKey: string);
}
export declare class InvalidContinuityPolicyError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export declare class InvalidPlaybackMetricsError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export type SourceTransitionPhase = 'prepare' | 'commit' | 'discard' | 'play';
export declare class SourceTransitionError extends LiveFlowError {
    readonly phase: SourceTransitionPhase;
    readonly generation: number;
    constructor(phase: SourceTransitionPhase, generation: number);
}
export declare class PreparedSourceGenerationMismatchError extends LiveFlowError {
    readonly expected: number;
    readonly received: number;
    constructor(expected: number, received: number);
}
export declare class CapacityExceededError extends LiveFlowError {
    readonly resource: string;
    readonly limit: number;
    constructor(resource: string, limit: number);
}
