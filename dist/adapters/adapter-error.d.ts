import { LiveFlowError } from '../shared/errors.js';
export declare class PlayerAdapterError extends LiveFlowError {
    readonly operation: string;
    constructor(code: string, operation: string);
}
