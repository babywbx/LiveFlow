import { CapacityExceededError } from './errors.js'

export type TimerHandle = number

export type FrameHandle = number

export interface Clock {
  now(): number
  setTimeout(handler: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  requestFrame(handler: (timestampMs: number) => void): FrameHandle
  cancelFrame(handle: FrameHandle): void
}

export interface RandomSource {
  next(): number
}

export function createSystemClock(): Clock {
  const maxActiveHandles = 256
  let nextHandle = 1
  const timerCancellations = new Map<number, () => void>()
  const frameCancellations = new Map<number, () => void>()

  return {
    now(): number {
      return globalThis.performance.now()
    },
    setTimeout(handler: () => void, delayMs: number): TimerHandle {
      ensureCapacity()
      const handle = nextHandle
      nextHandle += 1
      const nativeHandle = globalThis.setTimeout(() => {
        timerCancellations.delete(handle)
        handler()
      }, delayMs)
      timerCancellations.set(handle, () => {
        globalThis.clearTimeout(nativeHandle)
      })
      return handle
    },
    clearTimeout(handle: TimerHandle): void {
      const cancel = timerCancellations.get(handle)
      if (cancel === undefined) {
        return
      }

      timerCancellations.delete(handle)
      cancel()
    },
    requestFrame(handler: (timestampMs: number) => void): FrameHandle {
      ensureCapacity()
      const handle = nextHandle
      nextHandle += 1

      if (typeof globalThis.requestAnimationFrame === 'function') {
        const nativeHandle = globalThis.requestAnimationFrame((timestampMs) => {
          frameCancellations.delete(handle)
          handler(timestampMs)
        })
        frameCancellations.set(handle, () => {
          globalThis.cancelAnimationFrame(nativeHandle)
        })
        return handle
      }

      const nativeHandle = globalThis.setTimeout(() => {
        frameCancellations.delete(handle)
        handler(globalThis.performance.now())
      }, 16)
      frameCancellations.set(handle, () => {
        globalThis.clearTimeout(nativeHandle)
      })
      return handle
    },
    cancelFrame(handle: FrameHandle): void {
      const cancel = frameCancellations.get(handle)
      if (cancel === undefined) {
        return
      }

      frameCancellations.delete(handle)
      cancel()
    },
  }

  function ensureCapacity(): void {
    if (timerCancellations.size + frameCancellations.size >= maxActiveHandles) {
      throw new CapacityExceededError('system-clock-handles', maxActiveHandles)
    }
  }
}
