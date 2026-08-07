import { describe, expect, it } from 'vitest'

import { createContinuityController } from '../../src/continuity/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

const SOURCE = { url: 'https://media.example/live.flv', kind: 'flv' } as const
const STALL_DEBOUNCE_MS = 400

interface Harness {
  adapter: FakePlayerAdapter
  clock: FakeClock
  reasons: string[]
  controller: ReturnType<typeof createContinuityController>
}

async function startPlaying(policy?: { maxStallSeeksPerSource?: number }): Promise<Harness> {
  const adapter = new FakePlayerAdapter()
  const clock = new FakeClock()
  const reasons: string[] = []
  const controller = createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
    clock,
    ...(policy === undefined ? {} : { policy }),
    onRecoveryRequest: (request) => {
      reasons.push(request.reason)
    },
  })
  await controller.setSource(SOURCE)
  adapter.emit({ type: 'first-frame', generation: 1 })
  return { adapter, clock, reasons, controller }
}

describe('continuity stall seek', () => {
  it('jumps past a buffer hole instead of reopening the source', async () => {
    const { adapter, clock, reasons, controller } = await startPlaying()
    adapter.setMetrics({
      currentTimeSeconds: 100,
      bufferedAheadSeconds: 0,
      liveEdgeDistanceSeconds: 9.25,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
      strandedGapSeconds: 4.97,
    })

    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(STALL_DEBOUNCE_MS)

    expect(adapter.seeks()).toEqual([105.07])
    expect(reasons).toEqual([])

    adapter.emit({ type: 'playing', generation: 1 })
    expect(controller.getSnapshot().state).toBe('playing')

    await controller.destroy()
  })

  it('nudges a stream frozen inside its own buffered range', async () => {
    const { adapter, clock, reasons, controller } = await startPlaying()
    adapter.setMetrics({
      currentTimeSeconds: 40,
      bufferedAheadSeconds: 6,
      liveEdgeDistanceSeconds: 6,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(STALL_DEBOUNCE_MS)

    expect(adapter.seeks()).toEqual([40.1])
    expect(reasons).toEqual([])

    await controller.destroy()
  })

  it('reopens the source once the seek budget for this source is spent', async () => {
    const { adapter, clock, reasons, controller } = await startPlaying({
      maxStallSeeksPerSource: 2,
    })
    adapter.setMetrics({
      currentTimeSeconds: 10,
      bufferedAheadSeconds: 5,
      liveEdgeDistanceSeconds: 5,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(STALL_DEBOUNCE_MS)
    clock.advanceBy(STALL_DEBOUNCE_MS)
    expect(adapter.seeks()).toHaveLength(2)
    expect(reasons).toEqual([])

    clock.advanceBy(STALL_DEBOUNCE_MS)
    expect(adapter.seeks()).toHaveLength(2)
    expect(reasons).toEqual(['stall'])

    await controller.destroy()
  })

  it('leaves a stream with nothing buffered ahead to the recovery path', async () => {
    const { adapter, clock, reasons, controller } = await startPlaying()
    adapter.setMetrics({
      currentTimeSeconds: 10,
      bufferedAheadSeconds: 0,
      liveEdgeDistanceSeconds: 0,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(STALL_DEBOUNCE_MS)

    expect(adapter.seeks()).toEqual([])
    expect(reasons).toEqual(['stall'])

    await controller.destroy()
  })

  it('does not seek for a playback error', async () => {
    const { adapter, clock, reasons, controller } = await startPlaying()
    adapter.setMetrics({
      currentTimeSeconds: 10,
      bufferedAheadSeconds: 5,
      liveEdgeDistanceSeconds: 5,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    adapter.emit({ type: 'error', generation: 1, code: 'media', recoverable: true })
    clock.advanceBy(STALL_DEBOUNCE_MS)

    expect(adapter.seeks()).toEqual([])
    expect(reasons).toEqual(['playback-error'])

    await controller.destroy()
  })
})
