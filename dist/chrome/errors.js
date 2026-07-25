import { LiveFlowError } from '../shared/errors.js';
export class InvalidChromeVisibilityConfigurationError extends LiveFlowError {
    field;
    constructor(field) {
        super('invalid-chrome-visibility-configuration', `Chrome visibility configuration ${field} is invalid.`);
        this.name = 'InvalidChromeVisibilityConfigurationError';
        this.field = field;
    }
}
export class ChromeVisibilityDestroyedError extends LiveFlowError {
    constructor() {
        super('chrome-visibility-destroyed', 'The chrome visibility controller has been destroyed.');
        this.name = 'ChromeVisibilityDestroyedError';
    }
}
export class ChromeVisibilityPinUnderflowError extends LiveFlowError {
    constructor() {
        super('chrome-visibility-pin-underflow', 'Chrome visibility received an unpin without a matching pin.');
        this.name = 'ChromeVisibilityPinUnderflowError';
    }
}
