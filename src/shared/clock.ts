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

type FrameClock = Pick<Clock, 'now' | 'requestFrame' | 'cancelFrame'>
type Timers = Map<number, ReturnType<typeof globalThis.setTimeout>>
type Frames = Map<number, () => void>

function now(): number {
  return globalThis.performance.now()
}

function handleAllocator(
  handles: ReadonlyMap<number, unknown>,
  other?: ReadonlyMap<number, unknown>,
): () => number {
  const maxActiveHandles = 256
  let nextHandle = 1
  return (): number => {
    if (handles.size + (other?.size ?? 0) >= maxActiveHandles) {
      throw new CapacityExceededError('system-clock-handles', maxActiveHandles)
    }
    return nextHandle++
  }
}

function systemTimers(timers: Timers, allocateHandle: () => number): TimerClock {
  return {
    now,
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
}

function systemFrames(frames: Frames, allocateHandle: () => number): FrameClock {
  return {
    now,
    requestFrame(handler: (timestampMs: number) => void): FrameHandle {
      const handle = allocateHandle()
      const onFrame = (timestampMs?: number): void => {
        frames.delete(handle)
        handler(timestampMs ?? now())
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

export function createSystemTimerClock(): TimerClock {
  const timers: Timers = new Map()
  return systemTimers(timers, handleAllocator(timers))
}

export function createSystemFrameClock(): FrameClock {
  const frames: Frames = new Map()
  return systemFrames(frames, handleAllocator(frames))
}

export function createSystemClock(): Clock {
  const timers: Timers = new Map()
  const frames: Frames = new Map()
  const allocateHandle = handleAllocator(timers, frames)
  return { ...systemTimers(timers, allocateHandle), ...systemFrames(frames, allocateHandle) }
}
