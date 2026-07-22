import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSION,
  createOverlayBudgetCoordinator,
  createOverlayEngine,
  type OverlayPresentation,
  type OverlayRenderer,
  type RealtimeOverlayEvent,
} from '../../src/overlay/index.js'
import type { Destroyable } from '../../src/shared/disposable.js'
import { FakeClock } from '../fixtures/fake-clock.js'

class PresentationRecorder implements OverlayRenderer {
  readonly presentations: OverlayPresentation[] = []

  render(_event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable {
    this.presentations.push(presentation)
    return { destroy(): void {} }
  }

  destroy(): void {}
}

function syntheticEvent(index: number): RealtimeOverlayEvent {
  return {
    id: `event-${String(index)}`,
    kind: 'milestone',
    receivedAt: 0,
    priority: index,
    durationMs: 1_000,
    nodes: [
      { type: 'identity', identity: { kind: 'member', label: `Member ${String(index)}` } },
      { type: 'text', role: 'body', text: 'Synthetic milestone' },
    ],
  }
}

describe('multi-instance realtime overlay', () => {
  it('keeps nine simultaneous instances within the shared global budget', () => {
    const clock = new FakeClock()
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 9,
      maxActiveCards: 3,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    const overlays = Array.from({ length: 9 }, (_, index) => {
      const renderer = new PresentationRecorder()
      return {
        renderer,
        overlay: createOverlayEngine({
          contractVersion: CONTRACT_VERSION,
          instanceId: `view-${String(index)}`,
          instanceState: {
            weight: 9 - index,
            focused: index === 0,
            visible: true,
          },
          clock,
          coordinator,
          defaultRenderer: renderer,
        }),
      }
    })

    for (const [index, item] of overlays.entries()) {
      item.overlay.submit(syntheticEvent(index))
    }

    expect(coordinator.getMetrics()).toMatchObject({
      registeredInstances: 9,
      activeCards: 3,
      activeFull: 1,
      activeHighCost: 0,
    })
    expect(overlays.map((item) => item.renderer.presentations[0] ?? 'suppressed')).toEqual([
      'full',
      'compact',
      'compact',
      'suppressed',
      'suppressed',
      'suppressed',
      'suppressed',
      'suppressed',
      'suppressed',
    ])

    for (const item of overlays) {
      item.overlay.destroy()
    }
    expect(coordinator.getMetrics()).toMatchObject({
      registeredInstances: 0,
      activeCards: 0,
      activeFull: 0,
    })
  })

  it('rerenders active cards when focus and visibility reallocate presentations', () => {
    const clock = new FakeClock()
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 2,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    const firstRenderer = new PresentationRecorder()
    const secondRenderer = new PresentationRecorder()
    const first = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'first',
      instanceState: { weight: 1, focused: true, visible: true },
      clock,
      coordinator,
      defaultRenderer: firstRenderer,
    })
    const second = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'second',
      instanceState: { weight: 2, focused: false, visible: true },
      clock,
      coordinator,
      defaultRenderer: secondRenderer,
    })
    first.submit(syntheticEvent(1))
    second.submit(syntheticEvent(2))

    first.updateInstance({ focused: false })
    second.updateInstance({ focused: true })
    expect(firstRenderer.presentations).toEqual(['full', 'compact'])
    expect(secondRenderer.presentations).toEqual(['compact', 'full'])

    second.updateInstance({ visible: false })
    expect(firstRenderer.presentations).toEqual(['full', 'compact', 'full'])
    expect(second.getMetrics().visible).toBe(0)
    expect(coordinator.getMetrics()).toMatchObject({ activeCards: 1, activeFull: 1 })
  })
})
