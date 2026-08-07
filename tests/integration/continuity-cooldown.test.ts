import { describe, expect, it } from 'vitest'

import { createContinuityController } from '../../src/continuity/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

const SOURCE = { url: 'https://media.example/live.flv', kind: 'flv' } as const

describe('continuity recovery cooldown', () => {
  it('lets a source that recovered ask again without waiting out the cooldown', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: { recoveryCooldownMs: 30_000, maxStallSeeksPerSource: 0 },
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource(SOURCE)
    adapter.emit({ type: 'first-frame', generation: 1 })

    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)
    expect(reasons).toEqual(['stall'])

    await controller.setSource(SOURCE)
    adapter.emit({ type: 'first-frame', generation: 2 })
    expect(controller.getSnapshot().state).toBe('playing')

    adapter.emit({ type: 'waiting', generation: 2 })
    clock.advanceBy(400)

    expect(reasons).toEqual(['stall', 'stall'])

    await controller.destroy()
  })

  it('still throttles a source that keeps failing before it ever plays', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: { recoveryCooldownMs: 30_000, maxStallSeeksPerSource: 0 },
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource(SOURCE)
    adapter.emit({ type: 'first-frame', generation: 1 })

    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)
    expect(reasons).toEqual(['stall'])

    adapter.emit({ type: 'playing', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)

    expect(reasons).toEqual(['stall'])

    await controller.destroy()
  })
})
