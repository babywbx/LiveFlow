import type { Clock, FrameHandle, TimerHandle } from '../../src/index.js'

interface ScheduledTask {
  readonly handle: number
  readonly dueAt: number
  readonly handler: () => void
}

export class FakeClock implements Clock {
  private currentTime = 0
  private nextHandle = 1
  private readonly tasks = new Map<number, ScheduledTask>()

  now(): number {
    return this.currentTime
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    return this.schedule(handler, delayMs)
  }

  clearTimeout(handle: TimerHandle): void {
    this.tasks.delete(handle)
  }

  requestFrame(handler: (timestampMs: number) => void): FrameHandle {
    return this.schedule(() => {
      handler(this.currentTime)
    }, 16)
  }

  cancelFrame(handle: FrameHandle): void {
    this.tasks.delete(handle)
  }

  advanceBy(durationMs: number): void {
    const targetTime = this.currentTime + durationMs

    while (true) {
      const nextTask = this.findNextTask(targetTime)
      if (nextTask === null) {
        break
      }

      this.currentTime = nextTask.dueAt
      this.tasks.delete(nextTask.handle)
      nextTask.handler()
    }

    this.currentTime = targetTime
  }

  pendingTaskCount(): number {
    return this.tasks.size
  }

  private schedule(handler: () => void, delayMs: number): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.tasks.set(handle, {
      handle,
      dueAt: this.currentTime + Math.max(0, delayMs),
      handler,
    })
    return handle
  }

  private findNextTask(targetTime: number): ScheduledTask | null {
    let candidate: ScheduledTask | null = null

    for (const task of this.tasks.values()) {
      if (task.dueAt > targetTime) {
        continue
      }
      if (
        candidate === null ||
        task.dueAt < candidate.dueAt ||
        (task.dueAt === candidate.dueAt && task.handle < candidate.handle)
      ) {
        candidate = task
      }
    }

    return candidate
  }
}
