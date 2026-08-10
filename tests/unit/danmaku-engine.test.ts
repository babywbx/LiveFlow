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
  DanmakuRendererError,
  InvalidDanmakuMessageError,
  NonMonotonicDanmakuClockError,
  type DanmakuMeasurement,
  type DanmakuMessage,
  type DanmakuMetadata,
  type DanmakuMetadataEntry,
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

class ThrowingCancelClock extends AdjustableClock {
  cancelCalls = 0

  override cancelFrame(): void {
    this.cancelCalls += 1
    if (this.cancelCalls === 1) {
      throw new Error('cancel failed')
    }
  }
}

class ThrowingResizeRenderer extends RecordingRenderer {
  override resize(): void {
    throw new Error('resize failed')
  }
}

class PoisonedMeasurementCollectionRenderer extends RecordingRenderer {
  iteratorReads = 0
  sliceReads = 0

  override measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[] {
    const measurements = messages.map((item) => ({ id: item.id, width: 120, height: 24 }))
    Object.defineProperty(measurements, 'slice', {
      get: (): never => {
        this.sliceReads += 1
        throw new Error('slice must not be read')
      },
    })
    Object.defineProperty(measurements, Symbol.iterator, {
      get: (): never => {
        this.iteratorReads += 1
        throw new Error('iterator must not be read')
      },
    })
    return measurements
  }
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
        metadata: {
          entries: [
            ['first', 1],
            ['second', 2],
          ],
        },
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

  it('does not expose errors thrown by hostile message getters', () => {
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
    })
    const hostile = message('hostile')
    Object.defineProperty(hostile, 'text', {
      get(): never {
        throw new Error('https://media.test/live.m3u8?token=secret')
      },
    })

    expect(() => engine.push(hostile)).toThrow(InvalidDanmakuMessageError)
    try {
      engine.push(hostile)
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
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
    const entries: DanmakuMetadataEntry[] = []
    const cyclicMetadata: DanmakuMetadata = { entries }
    entries.push(['self', cyclicMetadata])

    expect(engine.push({ ...message('cyclic'), metadata: cyclicMetadata })).toEqual({
      accepted: true,
    })
    clock.advanceBy(16)

    expect(renderer.frames.at(-1)?.mounts[0]?.message.metadata).toBeUndefined()
    expect(engine.getMetrics().metadataDiscarded).toBe(1)
  })

  it('stops reading metadata getters at the configured key budget', () => {
    const entries: DanmakuMetadataEntry[] = []
    entries.length = 1_000_000
    let getterReads = 0
    Object.defineProperty(entries, 0, {
      get(): DanmakuMetadataEntry {
        getterReads += 1
        return ['payload', 'not read']
      },
    })
    const metadata: DanmakuMetadata = { entries }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
      limits: { maxMetadataKeys: 4 },
    })

    expect(engine.push({ ...message('bounded-getters'), metadata })).toEqual({ accepted: true })
    expect(getterReads).toBe(0)
    expect(engine.getMetrics().metadataDiscarded).toBe(1)
  })

  it('does not invoke a metadata array iterator', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const entries: DanmakuMetadataEntry[] = [['payload', 1]]
    let iteratorReads = 0
    Object.defineProperty(entries, Symbol.iterator, {
      get(): never {
        iteratorReads += 1
        throw new Error('iterator should not run')
      },
    })
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    expect(engine.push({ ...message('iterator'), metadata: { entries } })).toEqual({
      accepted: true,
    })
    expect(iteratorReads).toBe(0)
    clock.advanceBy(16)
    expect(renderer.frames.at(-1)?.mounts[0]?.message.metadata).toEqual({
      entries: [['payload', 1]],
    })
  })

  it('rejects a metadata proxy with a fractional length before reading entries', () => {
    let entryReads = 0
    const entries = new Proxy<DanmakuMetadataEntry[]>([['payload', 1]], {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          return 0.5
        }
        if (property === '0') {
          entryReads += 1
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
    })

    expect(engine.push({ ...message('fractional-length'), metadata: { entries } })).toEqual({
      accepted: true,
    })
    expect(entryReads).toBe(0)
    expect(engine.getMetrics().metadataDiscarded).toBe(1)
  })

  it('rejects over-rate input before reading metadata', () => {
    const clock = new FakeClock()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
      limits: { maxIntakePerSecond: 1 },
    })
    let getterReads = 0
    const metadata: DanmakuMetadata = {
      get entries(): readonly DanmakuMetadataEntry[] {
        getterReads += 1
        return [['payload', 'not read']]
      },
    }

    expect(engine.push(message('first'))).toEqual({ accepted: true })
    expect(engine.push({ ...message('second'), metadata })).toEqual({
      accepted: false,
      reason: 'input-rate',
    })
    expect(getterReads).toBe(0)
  })

  it('still validates required fields when the intake window is full', () => {
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
      limits: { maxIntakePerSecond: 1 },
    })

    expect(engine.push(message('first'))).toEqual({ accepted: true })
    expect(() => engine.push({ ...message('invalid'), receivedAt: Number.NaN })).toThrow(
      InvalidDanmakuMessageError,
    )
  })

  it('rejects oversized text before reading metadata', () => {
    let getterReads = 0
    const metadata: DanmakuMetadata = {
      get entries(): readonly DanmakuMetadataEntry[] {
        getterReads += 1
        return [['payload', 'not read']]
      },
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new RecordingRenderer(),
      viewport: { width: 640, height: 64 },
      limits: { maxTextLength: 4 },
    })

    expect(engine.push({ ...message('oversized'), text: '12345', metadata })).toEqual({
      accepted: false,
      reason: 'text-too-long',
    })
    expect(getterReads).toBe(0)
  })

  it('honors the UTF-8 metadata byte boundary', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
      limits: { maxMetadataBytes: 10 },
    })

    expect(
      engine.push({ ...message('utf8-boundary'), metadata: { entries: [['a', 'é']] } }),
    ).toEqual({
      accepted: true,
    })
    expect(engine.push({ ...message('utf8-over'), metadata: { entries: [['a', 'éé']] } })).toEqual({
      accepted: true,
    })
    clock.advanceBy(16)

    const mounts = renderer.frames.at(-1)?.mounts ?? []
    expect(mounts.find((mount) => mount.message.id === 'utf8-boundary')?.message.metadata).toEqual({
      entries: [['a', 'é']],
    })
    expect(
      mounts.find((mount) => mount.message.id === 'utf8-over')?.message.metadata,
    ).toBeUndefined()
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

  it('clears queued and visible messages without replacing the renderer', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 32 },
      limits: { maxIntakePerSecond: 2 },
    })

    engine.push(message('visible'))
    clock.advanceBy(16)
    engine.push(message('queued'))

    engine.clear()

    expect(engine.getMetrics()).toMatchObject({ pendingDepth: 0, visible: 0 })
    expect(renderer.frames.at(-1)?.unmounts).toEqual(['visible'])
    expect(renderer.destroyed).toBe(false)
    expect(clock.pendingTaskCount()).toBe(0)

    expect(engine.push(message('fresh'))).toEqual({ accepted: true })
    clock.advanceBy(16)
    expect(renderer.frames.at(-1)?.mounts[0]?.message.id).toBe('fresh')
  })

  it('can retry pause after frame cancellation fails', () => {
    const clock = new ThrowingCancelClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })
    engine.push(message('pause-retry'))

    expect(() => engine.pause()).toThrow('cancel failed')
    expect(renderer.paused).toBe(false)
    expect(() => engine.pause()).not.toThrow()
    expect(renderer.paused).toBe(true)

    engine.destroy()
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

  it('destroys the renderer even when frame cancellation fails', () => {
    const clock = new ThrowingCancelClock()
    const renderer = new RecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('destroy-after-cancel-failure'))

    expect(() => engine.destroy()).toThrow(DanmakuRendererError)
    expect(clock.cancelCalls).toBe(1)
    expect(renderer.destroyed).toBe(true)
    expect(() => engine.destroy()).not.toThrow()
    expect(clock.cancelCalls).toBe(2)
  })

  it('becomes unusable after renderer resize fails', () => {
    const renderer = new ThrowingResizeRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer,
      viewport: { width: 640, height: 64 },
    })

    expect(() => engine.resize({ width: 320, height: 64 })).toThrow(DanmakuRendererError)
    expect(() => engine.push(message('after-resize-failure'))).toThrow(DanmakuRendererError)

    engine.destroy()
    expect(renderer.destroyed).toBe(true)
  })

  it('copies renderer measurements without reading slice or an iterator', () => {
    const clock = new FakeClock()
    const renderer = new PoisonedMeasurementCollectionRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('bounded-measurements'))
    clock.advanceBy(16)

    expect(renderer.sliceReads).toBe(0)
    expect(renderer.iteratorReads).toBe(0)
    expect(engine.getMetrics().visible).toBe(1)
  })

  it('rejects an unsafe measurement length before reading an entry', () => {
    const clock = new FakeClock()
    let entryReads = 0
    const renderer = new RecordingRenderer()
    renderer.measure = (): readonly DanmakuMeasurement[] =>
      new Proxy<DanmakuMeasurement[]>([{ id: 'unsafe-length', width: 120, height: 24 }], {
        get(target, property, receiver): unknown {
          if (property === 'length') {
            return 0.5
          }
          if (property === '0') {
            entryReads += 1
          }
          return Reflect.get(target, property, receiver)
        },
      })
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('unsafe-length'))
    clock.advanceBy(16)

    expect(entryReads).toBe(0)
    expect(() => engine.getMetrics()).toThrow(DanmakuRendererError)
  })

  it('contains hostile measurement getter failures inside the renderer boundary', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    renderer.measure = (): readonly DanmakuMeasurement[] => {
      const measurement = { id: 'hostile', width: 120, height: 24 }
      Object.defineProperty(measurement, 'id', {
        get(): never {
          throw new Error('https://media.invalid/live.m3u8?token=secret')
        },
      })
      return [measurement]
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 640, height: 64 },
    })

    engine.push(message('hostile-measurement'))
    clock.advanceBy(16)

    expect(() => engine.getMetrics()).toThrow(DanmakuRendererError)
    try {
      engine.getMetrics()
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
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
