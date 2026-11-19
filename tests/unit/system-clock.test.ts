import { describe, expect, it, vi } from 'vitest'

import { createSystemClock, createSystemFrameClock } from '../../src/shared/clock.js'
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

  it('shares capacity across timers and frames and releases it before callbacks', () => {
    vi.useFakeTimers()
    try {
      const clock = createSystemClock()
      const noop = (): void => {}
      const onTimer = vi.fn(noop)
      const onFrame = vi.fn(() => clock.setTimeout(noop, 60_000))
      const frame = clock.requestFrame(onFrame)
      const timer = clock.setTimeout(onTimer, 1)
      for (let index = 0; index < 254; index += 1) {
        clock.setTimeout(noop, 60_000)
      }
      clock.clearTimeout(frame)
      clock.cancelFrame(timer)
      expect(() => clock.requestFrame(onFrame)).toThrow(CapacityExceededError)
      vi.advanceTimersByTime(1)
      expect(onTimer).toHaveBeenCalledOnce()
      const cancelled = clock.requestFrame(noop)
      clock.cancelFrame(cancelled)
      clock.setTimeout(noop, 60_000)
      vi.advanceTimersByTime(16)
      expect(onFrame).toHaveBeenCalledOnce()
      expect(() => clock.setTimeout(noop, 1)).toThrow(CapacityExceededError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps frame capacity reserved until native cancellation succeeds', () => {
    let nextNativeHandle = 41
    const request = vi.fn(function (this: unknown): number {
      expect(this).toBe(globalThis)
      return nextNativeHandle++
    })
    const cancel = vi.fn(function (this: unknown, nativeHandle: number): void {
      expect(this).toBe(globalThis)
      expect(nativeHandle).toBe(41)
    })
    cancel.mockImplementationOnce(() => {
      throw new Error('cancel failed')
    })
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const clock = createSystemFrameClock()
      const handler = (): void => {}
      const first = clock.requestFrame(handler)
      for (let index = 1; index < 256; index += 1) clock.requestFrame(handler)

      expect(() => clock.cancelFrame(first)).toThrow('cancel failed')
      expect(() => clock.requestFrame(handler)).toThrow(CapacityExceededError)
      clock.cancelFrame(first)
      clock.cancelFrame(first)
      expect(cancel).toHaveBeenCalledTimes(2)
      expect(() => clock.requestFrame(handler)).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
