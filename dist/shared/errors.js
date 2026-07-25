export class LiveFlowError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'LiveFlowError';
        this.code = code;
    }
}
export class ContractVersionMismatchError extends LiveFlowError {
    expected;
    received;
    constructor(expected, received) {
        super('contract-version-mismatch', `LiveFlow expects contract version ${String(expected)} but the caller was built against ${String(received)}.`);
        this.name = 'ContractVersionMismatchError';
        this.expected = expected;
        this.received = received;
    }
}
export class AssetResolutionError extends LiveFlowError {
    assetKey;
    constructor(assetKey) {
        super('asset-resolution-failed', `The caller asset resolver rejected key ${assetKey}.`);
        this.name = 'AssetResolutionError';
        this.assetKey = assetKey;
    }
}
export class InvalidContinuityPolicyError extends LiveFlowError {
    field;
    constructor(field) {
        super('invalid-continuity-policy', `Continuity policy field ${field} is invalid.`);
        this.name = 'InvalidContinuityPolicyError';
        this.field = field;
    }
}
export class InvalidPlaybackMetricsError extends LiveFlowError {
    field;
    constructor(field) {
        super('invalid-playback-metrics', `Playback metrics field ${field} is invalid.`);
        this.name = 'InvalidPlaybackMetricsError';
        this.field = field;
    }
}
export function sanitizeErrorName(error) {
    if (!(error instanceof Error)) {
        return 'unknown';
    }
    return /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'unknown';
}
export class SourceTransitionError extends LiveFlowError {
    phase;
    generation;
    reason;
    constructor(phase, generation, reason = 'unknown') {
        super(`source-${phase}-failed`, `Could not ${phase} media generation ${String(generation)}.`);
        this.name = 'SourceTransitionError';
        this.phase = phase;
        this.generation = generation;
        this.reason = reason;
    }
}
export class PreparedSourceGenerationMismatchError extends LiveFlowError {
    expected;
    received;
    constructor(expected, received) {
        super('prepared-source-generation-mismatch', `Prepared source generation ${String(received)} does not match expected generation ${String(expected)}.`);
        this.name = 'PreparedSourceGenerationMismatchError';
        this.expected = expected;
        this.received = received;
    }
}
export class CapacityExceededError extends LiveFlowError {
    resource;
    limit;
    constructor(resource, limit) {
        super('capacity-exceeded', `LiveFlow resource ${resource} reached its limit of ${String(limit)}.`);
        this.name = 'CapacityExceededError';
        this.resource = resource;
        this.limit = limit;
    }
}
