import { describe, expect, it } from 'vitest'

import {
  createContinuityController,
  type ContinuityController,
  type ContinuityRecoveryRequest,
} from '../../src/continuity/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

const SOURCE = { url: 'https://media.example/live.flv', kind: 'flv' } as const
const STALL_DEBOUNCE_MS = 400

interface Harness {
  readonly adapter: FakePlayerAdapter
  readonly clock: FakeClock
  readonly controller: ContinuityController
  readonly requests: ContinuityRecoveryRequest[]
}

function createHarness(
  onRequest?: (controller: () => ContinuityController, request: ContinuityRecoveryRequest) => void,
): Harness {
  const adapter = new FakePlayerAdapter()
  const clock = new FakeClock()
  const requests: ContinuityRecoveryRequest[] = []
  const controller = createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
    clock,
    policy: { maxAutomaticRecoveries: 4, maxStallSeeksPerSource: 0 },
    onRecoveryRequest: (request) => {
      requests.push(request)
      onRequest?.(() => controller, request)
    },
  })

  return { adapter, clock, controller, requests }
}

async function playFirstSource(harness: Harness): Promise<void> {
  await harness.controller.setSource(SOURCE)
  harness.adapter.emit({ type: 'first-frame', generation: 1 })
}

function stallUntilRecoveryRequest(harness: Harness): void {
  harness.adapter.emit({ type: 'waiting', generation: 1 })
  harness.clock.advanceBy(STALL_DEBOUNCE_MS)
}

describe('continuity recovery cancellation', () => {
  it('gives the recovery budget back when the caller declines the request', async () => {
    const harness = createHarness()
    await playFirstSource(harness)
    stallUntilRecoveryRequest(harness)

    expect(harness.requests).toHaveLength(1)
    expect(harness.controller.getSnapshot().automaticRecoveryCount).toBe(1)

    harness.controller.cancelRecovery(1)

    expect(harness.controller.getSnapshot().automaticRecoveryCount).toBe(0)

    await harness.controller.destroy()
  })

  it('keeps declined recoveries from exhausting a stream that keeps healing itself', async () => {
    const harness = createHarness()
    await playFirstSource(harness)

    for (let round = 0; round < 6; round += 1) {
      harness.adapter.emit({ type: 'playing', generation: 1 })
      stallUntilRecoveryRequest(harness)
      harness.controller.cancelRecovery(1)
    }

    expect(harness.requests).toHaveLength(6)
    expect(harness.controller.getSnapshot().state).not.toBe('waiting-reopen')
    expect(harness.controller.getSnapshot().automaticRecoveryCount).toBe(0)

    await harness.controller.destroy()
  })

  it('releases the cooldown so the next failure is handled immediately', async () => {
    const harness = createHarness()
    await playFirstSource(harness)
    stallUntilRecoveryRequest(harness)
    harness.controller.cancelRecovery(1)

    stallUntilRecoveryRequest(harness)

    expect(harness.requests).toHaveLength(2)

    await harness.controller.destroy()
  })

  it('drops a recovery that was scheduled but never delivered', async () => {
    const harness = createHarness()
    await playFirstSource(harness)

    harness.adapter.emit({ type: 'waiting', generation: 1 })
    harness.controller.cancelRecovery(1)
    harness.clock.advanceBy(STALL_DEBOUNCE_MS)

    expect(harness.requests).toEqual([])
    expect(harness.controller.getSnapshot().automaticRecoveryCount).toBe(0)

    await harness.controller.destroy()
  })

  it('ignores a cancellation aimed at a superseded generation', async () => {
    const harness = createHarness()
    await playFirstSource(harness)
    stallUntilRecoveryRequest(harness)

    harness.controller.cancelRecovery(99)

    expect(harness.controller.getSnapshot().automaticRecoveryCount).toBe(1)

    await harness.controller.destroy()
  })

  it('accepts a cancellation raised from inside the recovery listener', async () => {
    const harness = createHarness((controller, request) => {
      controller().cancelRecovery(request.generation)
    })
    await playFirstSource(harness)
    stallUntilRecoveryRequest(harness)

    expect(harness.requests).toHaveLength(1)
    expect(harness.controller.getSnapshot().automaticRecoveryCount).toBe(0)

    await harness.controller.destroy()
  })

  it('stays silent once the controller is destroyed', async () => {
    const harness = createHarness()
    await playFirstSource(harness)
    stallUntilRecoveryRequest(harness)
    await harness.controller.destroy()

    expect(() => {
      harness.controller.cancelRecovery(1)
    }).not.toThrow()
  })
})
