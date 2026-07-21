export declare class LiveFlowError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions);
}
export declare class ContractVersionMismatchError extends LiveFlowError {
    readonly expected: number;
    readonly received: number;
    constructor(expected: number, received: number);
}
export declare class AssetResolutionError extends LiveFlowError {
    readonly assetKey: string;
    constructor(assetKey: string);
}
