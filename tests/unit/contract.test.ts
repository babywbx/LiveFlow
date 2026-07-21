import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSION, ContractVersionMismatchError, LiveFlowError } from '../../src/index.js'

describe('public contract', () => {
  it('exposes a numeric contract version', () => {
    expect(Number.isInteger(CONTRACT_VERSION)).toBe(true)
    expect(CONTRACT_VERSION).toBeGreaterThan(0)
  })

  it('reports both sides of a contract mismatch', () => {
    const error = new ContractVersionMismatchError(CONTRACT_VERSION, CONTRACT_VERSION + 1)

    expect(error).toBeInstanceOf(LiveFlowError)
    expect(error.code).toBe('contract-version-mismatch')
    expect(error.expected).toBe(CONTRACT_VERSION)
    expect(error.received).toBe(CONTRACT_VERSION + 1)
  })
})
