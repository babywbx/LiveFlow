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
