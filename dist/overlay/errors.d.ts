import { LiveFlowError } from '../shared/errors.js';
export declare class InvalidOverlayEventError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export declare class InvalidOverlayConfigurationError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export declare class OverlayCapacityError extends LiveFlowError {
    readonly resource: string;
    readonly limit: number;
    constructor(resource: string, limit: number);
}
export declare class OverlayDestroyedError extends LiveFlowError {
    constructor(resource: string);
}
export declare class OverlayRenderError extends LiveFlowError {
    readonly kind: string;
    constructor(kind: string);
}
export declare class OverlaySchedulingError extends LiveFlowError {
    constructor();
}
export declare class OverlayCleanupError extends LiveFlowError {
    constructor();
}
