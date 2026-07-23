import { LiveFlowError } from '../shared/errors.js';
export class PlayerAdapterError extends LiveFlowError {
    operation;
    constructor(code, operation) {
        super(code, `The player adapter could not complete ${operation}.`);
        this.name = 'PlayerAdapterError';
        this.operation = operation;
    }
}
