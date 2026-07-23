import { LiveFlowError } from '../shared/errors.js';
export declare class InvalidDanmakuConfigurationError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export declare class InvalidDanmakuMessageError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export declare class NonMonotonicDanmakuClockError extends LiveFlowError {
    constructor();
}
export declare class DanmakuRendererError extends LiveFlowError {
    readonly phase: string;
    constructor(phase: string);
}
