import { LiveFlowError } from '../shared/errors.js'

export class PlayerAdapterError extends LiveFlowError {
  readonly operation: string

  constructor(code: string, operation: string) {
    super(code, `The player adapter could not complete ${operation}.`)
    this.name = 'PlayerAdapterError'
    this.operation = operation
  }
}
