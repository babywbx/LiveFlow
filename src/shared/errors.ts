export class LiveFlowError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LiveFlowError'
    this.code = code
  }
}

export class ContractVersionMismatchError extends LiveFlowError {
  readonly expected: number
  readonly received: number

  constructor(expected: number, received: number) {
    super(
      'contract-version-mismatch',
      `LiveFlow expects contract version ${String(expected)} but the caller was built against ${String(received)}.`,
    )
    this.name = 'ContractVersionMismatchError'
    this.expected = expected
    this.received = received
  }
}

export class AssetResolutionError extends LiveFlowError {
  readonly assetKey: string

  constructor(assetKey: string) {
    super('asset-resolution-failed', `The caller asset resolver rejected key ${assetKey}.`)
    this.name = 'AssetResolutionError'
    this.assetKey = assetKey
  }
}
