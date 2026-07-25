import { LiveFlowError } from '../shared/errors.js';
export declare class InvalidMultiviewLayoutError extends LiveFlowError {
    readonly field: string;
    constructor(field: string);
}
