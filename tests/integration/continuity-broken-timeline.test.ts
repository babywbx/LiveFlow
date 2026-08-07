import { describe, expect, it } from 'vitest'

import { createContinuityController } from '../../src/continuity/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

const SOURCE = { url: 'https://media.example/live.flv', kind: 'flv' } as const
const SAMPLE_INTERVAL_MS = 500
const ROLLOVER_SECONDS = 4_294_967.296

describe('continuity broken timeline', () => {
  it('ignores a live edge distance no real stream can produce', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const codes: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
      onDiagnostic: (event) => {
        codes.push(event.code)
      },
    })

    await controller.setSource(SOURCE)
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 302,
      bufferedAheadSeconds: ROLLOVER_SECONDS,
      liveEdgeDistanceSeconds: ROLLOVER_SECONDS,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    clock.advanceBy(SAMPLE_INTERVAL_MS * 12)

    expect(reasons).toEqual([])
    expect(adapter.seeks()).toEqual([])
    expect(adapter.playbackRate()).toBe(1)
    expect(controller.getSnapshot().state).toBe('playing')
    expect(codes).toContain('implausible-live-edge')

    await controller.destroy()
  })

  it('still resyncs a stream that is merely far behind', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: { maxStallSeeksPerSource: 0 },
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource(SOURCE)
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 302,
      bufferedAheadSeconds: 40,
      liveEdgeDistanceSeconds: 45,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    clock.advanceBy(SAMPLE_INTERVAL_MS * 12)

    expect(reasons).toEqual(['latency'])

    await controller.destroy()
  })

  it('releases a warming source that failed before the warmup timeout', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: { sourceWarmupTimeoutMs: 8_000 },
      onRecoveryRequest: () => {},
    })

    await controller.setSource(SOURCE)
    adapter.emit({ type: 'first-frame', generation: 1 })
    await controller.setSource(SOURCE)

    adapter.emit({ type: 'error', generation: 2, code: 'network', recoverable: true })
    expect(controller.getSnapshot().state).toBe('degraded')
    expect(adapter.wasDiscarded(2)).toBe(false)

    clock.advanceBy(8_000)

    expect(adapter.wasDiscarded(2)).toBe(true)
    expect(adapter.hasLiveResource(2)).toBe(false)

    await controller.destroy()
  })
})
