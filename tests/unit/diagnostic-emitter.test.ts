import { describe, expect, it } from 'vitest'

import type { Clock } from '../../src/index.js'
import { createDiagnosticEmitter } from '../../src/shared/diagnostic-emitter.js'

class FailingClock implements Clock {
  now(): number {
    throw new Error('Synthetic clock failure.')
  }

  setTimeout(): number {
    return 1
  }

  clearTimeout(): void {}

  requestFrame(): number {
    return 1
  }

  cancelFrame(): void {}
}

describe('diagnostic emitter', () => {
  it('does not let a diagnostic clock failure escape into engine control flow', () => {
    let calls = 0
    const emitter = createDiagnosticEmitter(
      {
        onDiagnostic(): void {
          calls += 1
        },
      },
      new FailingClock(),
    )

    expect(() =>
      emitter.emit({
        scope: 'continuity',
        code: 'synthetic',
        level: 'warn',
      }),
    ).not.toThrow()
    expect(calls).toBe(0)
  })
})
