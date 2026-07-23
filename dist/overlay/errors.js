import { LiveFlowError } from '../shared/errors.js';
export class InvalidOverlayEventError extends LiveFlowError {
    field;
    constructor(field) {
        super('invalid-overlay-event', `Realtime overlay event field ${field} is invalid.`);
        this.name = 'InvalidOverlayEventError';
        this.field = field;
    }
}
export class InvalidOverlayConfigurationError extends LiveFlowError {
    field;
    constructor(field) {
        super('invalid-overlay-configuration', `Realtime overlay configuration ${field} is invalid.`);
        this.name = 'InvalidOverlayConfigurationError';
        this.field = field;
    }
}
export class OverlayCapacityError extends LiveFlowError {
    resource;
    limit;
    constructor(resource, limit) {
        super('overlay-capacity-exceeded', `Realtime overlay resource ${resource} reached its limit of ${String(limit)}.`);
        this.name = 'OverlayCapacityError';
        this.resource = resource;
        this.limit = limit;
    }
}
export class OverlayDestroyedError extends LiveFlowError {
    constructor(resource) {
        super('overlay-destroyed', `Realtime overlay resource ${resource} has been destroyed.`);
        this.name = 'OverlayDestroyedError';
    }
}
export class OverlayRenderError extends LiveFlowError {
    kind;
    constructor(kind) {
        super('overlay-render-failed', `Realtime overlay renderer for kind ${kind} failed.`);
        this.name = 'OverlayRenderError';
        this.kind = kind;
    }
}
export class OverlaySchedulingError extends LiveFlowError {
    constructor() {
        super('overlay-scheduling-failed', 'Realtime overlay card scheduling failed.');
        this.name = 'OverlaySchedulingError';
    }
}
export class OverlayCleanupError extends LiveFlowError {
    constructor() {
        super('overlay-cleanup-failed', 'Realtime overlay cleanup did not complete successfully.');
        this.name = 'OverlayCleanupError';
    }
}
