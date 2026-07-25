import { LiveFlowError } from '../shared/errors.js';
export class InvalidMultiviewLayoutError extends LiveFlowError {
    field;
    constructor(field) {
        super('invalid-multiview-layout', `Multiview layout field ${field} is invalid.`);
        this.name = 'InvalidMultiviewLayoutError';
        this.field = field;
    }
}
