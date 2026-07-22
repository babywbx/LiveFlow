import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSION,
  ContractVersionMismatchError,
  type Clock,
  type FrameHandle,
  type TimerHandle,
} from '../../src/index.js'
import {
  createDanmakuEngine,
  InvalidDanmakuMessageError,
  NonMonotonicDanmakuClockError,
  type DanmakuMeasurement,
  type DanmakuMessage,
  type DanmakuRenderFrame,
  type DanmakuRenderer,
} from '../../src/danmaku/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'

class RecordingRenderer implements DanmakuRenderer {
  readonly frames: DanmakuRenderFrame[] = []
  paused = false
  destroyed = false

  measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[] {
    return messages.map((message) => ({ id: message.id, width: 120, height: 24 }))
  }

  render(frame: DanmakuRenderFrame): void {
    this.frames.push(frame)
  }

  resize(): void {}

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  destroy(): void {
    this.destroyed = true
  }
}

class AdjustableClock implements Clock {
  currentTime = 10

  now(): number {
    return this.currentTime
  }

  setTimeout(): TimerHandle {
    return 1
  }

  clearTimeout(): void {}

  requestFrame(): FrameHandle {
    return 1
  }

  cancelFrame(): void {}
}

function message(id: string, priority = 0): DanmakuMessage {
  return {
    id,
    receivedAt: 0,
    text: `message ${id}`,
    mode: 'scroll',
    priority,
  }
}

describe('danmaku engine', () => {
  it('keeps the pending queue bounded and retains higher-priority messages', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 32 },
      limits: {
        maxPending: 2,
        maxVisible: 1,
        maxPoolSize: 2,
        maxTextLength: 100,
        maxBadgesPerMessage: 2,
        maxMountsPerFrame: 1,
        maxMetadataKeys: 4,
        maxMetadataDepth: 2,
        maxMetadataBytes: 128,
        maxIntakePerSecond: 10,
        maxDisplayPerSecond: 1,
      },
    })

    expect(engine.push(message('ordinary-a', 0))).toEqual({ accepted: true })
    expect(engine.push(message('ordinary-b', 0))).toEqual({ accepted: true })
    expect(engine.push(message('important', 10))).toEqual({ accepted: true })
    expect(engine.getMetrics()).toMatchObject({
      received: 3,
      dropped: 1,
      pendingDepth: 2,
    })

    clock.advanceBy(16)

    expect(renderer.frames.at(-1)?.mounts[0]?.message.id).toBe('important')
    expect(engine.getMetrics().pendingDepth).toBe(1)
  })

  it('drops oversized metadata while retaining the message and bounded identities', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const diagnostics: string[] = []
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
      limits: {
        maxMetadataKeys: 1,
        maxBadgesPerMessage: 1,
      },
      onDiagnostic(event): void {
        diagnostics.push(`${event.scope}:${event.code}`)
      },
    })

    expect(
      engine.push({
        ...message('structured'),
        color: 'not-a-color',
        identities: [
          { kind: 'fan-badge', label: 'A', level: 8 },
          { kind: 'user-level', label: 'B', level: 16 },
        ],
        metadata: { first: 1, second: 2 },
      }),
    ).toEqual({ accepted: true })

    clock.advanceBy(16)

    const rendered = renderer.frames.at(-1)?.mounts[0]?.message
    expect(rendered?.metadata).toBeUndefined()
    expect(rendered?.identities).toEqual([{ kind: 'fan-badge', label: 'A', level: 8 }])
    expect(rendered?.color).toBeUndefined()
    expect(engine.getMetrics().metadataDiscarded).toBe(1)
    expect(diagnostics).toEqual([
      'danmaku:metadata-discarded',
      'danmaku:identities-truncated',
      'danmaku:color-discarded',
    ])
  })

  it('rejects malformed messages with a typed error', () => {
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
    })

    expect(() => engine.push({ ...message('invalid'), receivedAt: Number.NaN })).toThrow(
      InvalidDanmakuMessageError,
    )
  })

  it('discards cyclic metadata without retaining the cyclic object', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })
    const cyclicMetadata: Record<string, unknown> = {}
    cyclicMetadata.self = cyclicMetadata

    expect(engine.push({ ...message('cyclic'), metadata: cyclicMetadata })).toEqual({
      accepted: true,
    })
    clock.advanceBy(16)

    expect(renderer.frames.at(-1)?.mounts[0]?.message.metadata).toBeUndefined()
    expect(engine.getMetrics().metadataDiscarded).toBe(1)
  })

  it('enforces a bounded one-second input window', () => {
    const clock = new FakeClock()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
      limits: { maxIntakePerSecond: 1 },
    })

    expect(engine.push(message('first'))).toEqual({ accepted: true })
    expect(engine.push(message('second'))).toEqual({
      accepted: false,
      reason: 'input-rate',
    })

    clock.advanceBy(1_000)

    expect(engine.push(message('third'))).toEqual({ accepted: true })
    expect(engine.getMetrics().droppedByReason.inputRate).toBe(1)
  })

  it('detects a clock that moves backwards', () => {
    const clock = new AdjustableClock()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('clock'))
    clock.currentTime = 1

    expect(() => engine.pause()).toThrow(NonMonotonicDanmakuClockError)
  })

  it('pauses the single scheduler and resumes without consuming visible time', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('pause'))
    clock.advanceBy(16)
    engine.pause()
    const frameCount = renderer.frames.length

    clock.advanceBy(5_000)

    expect(renderer.paused).toBe(true)
    expect(renderer.frames).toHaveLength(frameCount)
    expect(clock.pendingTaskCount()).toBe(0)

    engine.resume()
    clock.advanceBy(16)

    expect(renderer.paused).toBe(false)
    expect(engine.getMetrics().visible).toBe(1)
  })

  it('is idempotent when destroyed and leaves no scheduled frame', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('destroy'))
    engine.destroy()
    engine.destroy()

    expect(renderer.destroyed).toBe(true)
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('rejects a mismatched contract version before creating renderer state', () => {
    const renderer = new RecordingRenderer()

    expect(() =>
      createDanmakuEngine({
        contractVersion: CONTRACT_VERSION + 1,
        clock: new FakeClock(),
        renderer,
        viewport: { width: 640, height: 64 },
      }),
    ).toThrow(ContractVersionMismatchError)
    expect(renderer.destroyed).toBe(false)
  })
})
