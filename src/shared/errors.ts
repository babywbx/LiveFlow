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

export class InvalidContinuityPolicyError extends LiveFlowError {
  readonly field: string

  constructor(field: string) {
    super('invalid-continuity-policy', `Continuity policy field ${field} is invalid.`)
    this.name = 'InvalidContinuityPolicyError'
    this.field = field
  }
}

export class InvalidPlaybackMetricsError extends LiveFlowError {
  readonly field: string

  constructor(field: string) {
    super('invalid-playback-metrics', `Playback metrics field ${field} is invalid.`)
    this.name = 'InvalidPlaybackMetricsError'
    this.field = field
  }
}

export type SourceTransitionPhase = 'prepare' | 'commit' | 'discard' | 'play'

// Upstream messages can embed signed media URLs, so only the class name travels.
export function sanitizeErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown'
  }
  return /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'unknown'
}

export class SourceTransitionError extends LiveFlowError {
  readonly phase: SourceTransitionPhase
  readonly generation: number
  readonly reason: string

  constructor(phase: SourceTransitionPhase, generation: number, reason = 'unknown') {
    super(`source-${phase}-failed`, `Could not ${phase} media generation ${String(generation)}.`)
    this.name = 'SourceTransitionError'
    this.phase = phase
    this.generation = generation
    this.reason = reason
  }
}

export class PreparedSourceGenerationMismatchError extends LiveFlowError {
  readonly expected: number
  readonly received: number

  constructor(expected: number, received: number) {
    super(
      'prepared-source-generation-mismatch',
      `Prepared source generation ${String(received)} does not match expected generation ${String(expected)}.`,
    )
    this.name = 'PreparedSourceGenerationMismatchError'
    this.expected = expected
    this.received = received
  }
}

export class CapacityExceededError extends LiveFlowError {
  readonly resource: string
  readonly limit: number

  constructor(resource: string, limit: number) {
    super(
      'capacity-exceeded',
      `LiveFlow resource ${resource} reached its limit of ${String(limit)}.`,
    )
    this.name = 'CapacityExceededError'
    this.resource = resource
    this.limit = limit
  }
}
