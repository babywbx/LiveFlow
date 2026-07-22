import { LiveFlowError } from '../shared/errors.js'

export class InvalidDanmakuConfigurationError extends LiveFlowError {
  readonly field: string

  constructor(field: string) {
    super('invalid-danmaku-configuration', `Danmaku configuration field ${field} is invalid.`)
    this.name = 'InvalidDanmakuConfigurationError'
    this.field = field
  }
}

export class InvalidDanmakuMessageError extends LiveFlowError {
  readonly field: string

  constructor(field: string) {
    super('invalid-danmaku-message', `Danmaku message field ${field} is invalid.`)
    this.name = 'InvalidDanmakuMessageError'
    this.field = field
  }
}

export class NonMonotonicDanmakuClockError extends LiveFlowError {
  constructor() {
    super('non-monotonic-danmaku-clock', 'The danmaku clock moved backwards.')
    this.name = 'NonMonotonicDanmakuClockError'
  }
}

export class DanmakuRendererError extends LiveFlowError {
  readonly phase: string

  constructor(phase: string) {
    super('danmaku-renderer-failed', `The danmaku renderer failed during ${phase}.`)
    this.name = 'DanmakuRendererError'
    this.phase = phase
  }
}
