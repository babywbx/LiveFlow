import { describe, expect, it } from 'vitest'

import { createSystemClock } from '../../src/shared/clock.js'
import { CapacityExceededError } from '../../src/shared/errors.js'

describe('system clock', () => {
  it('bounds native timer handles retained by one clock', () => {
    const clock = createSystemClock()
    const handles: number[] = []

    for (let index = 0; index < 256; index += 1) {
      handles.push(clock.setTimeout(() => {}, 60_000))
    }

    expect(() => {
      clock.setTimeout(() => {}, 60_000)
    }).toThrow(CapacityExceededError)

    for (const handle of handles) {
      clock.clearTimeout(handle)
    }
  })
})
