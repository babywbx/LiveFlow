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

export type TimerClock = Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>

function systemTimers(frames?: ReadonlyMap<number, () => void>): {
  clock: TimerClock
  allocateHandle: () => number
} {
  const maxActiveHandles = 256
  const timers = new Map<number, ReturnType<typeof globalThis.setTimeout>>()
  let nextHandle = 1

  function allocateHandle(): number {
    if (timers.size + (frames?.size ?? 0) >= maxActiveHandles) {
      throw new CapacityExceededError('system-clock-handles', maxActiveHandles)
    }
    return nextHandle++
  }

  const clock: TimerClock = {
    now(): number {
      return globalThis.performance.now()
    },
    setTimeout(handler: () => void, delayMs: number): TimerHandle {
      const handle = allocateHandle()
      const nativeHandle = globalThis.setTimeout(() => {
        timers.delete(handle)
        handler()
      }, delayMs)
      timers.set(handle, nativeHandle)
      return handle
    },
    clearTimeout(handle: TimerHandle): void {
      const nativeHandle = timers.get(handle)
      if (nativeHandle !== undefined) {
        globalThis.clearTimeout(nativeHandle)
        timers.delete(handle)
      }
    },
  }
  return { clock, allocateHandle }
}

export function createSystemTimerClock(): TimerClock {
  return systemTimers().clock
}

export function createSystemClock(): Clock {
  const frames = new Map<number, () => void>()
  const { clock, allocateHandle } = systemTimers(frames)
  return {
    ...clock,
    requestFrame(handler: (timestampMs: number) => void): FrameHandle {
      const handle = allocateHandle()
      const onFrame = (timestampMs?: number): void => {
        frames.delete(handle)
        handler(timestampMs ?? clock.now())
      }
      if (typeof globalThis.requestAnimationFrame === 'function') {
        const nativeHandle = globalThis.requestAnimationFrame(onFrame)
        frames.set(handle, () => globalThis.cancelAnimationFrame(nativeHandle))
      } else {
        const nativeHandle = globalThis.setTimeout(onFrame, 16)
        frames.set(handle, () => globalThis.clearTimeout(nativeHandle))
      }
      return handle
    },
    cancelFrame(handle: FrameHandle): void {
      const cancel = frames.get(handle)
      if (cancel !== undefined) {
        cancel()
        frames.delete(handle)
      }
    },
  }
}
