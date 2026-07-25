import { LiveFlowError } from '../shared/errors.js';
export declare class InvalidChromeVisibilityConfigurationError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
export declare class ChromeVisibilityDestroyedError extends LiveFlowError {
    constructor();
}
export declare class ChromeVisibilityPinUnderflowError extends LiveFlowError {
    constructor();
}
