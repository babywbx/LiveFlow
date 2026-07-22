import { describe, expect, it } from 'vitest'

import {
  createOverlayBudgetCoordinator,
  type OverlayPresentation,
} from '../../src/overlay/index.js'

describe('overlay budget coordinator', () => {
  it('grants full, compact, and suppressed presentations from explicit instance state', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 3,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    const focused = coordinator.register({
      instanceId: 'focused',
      weight: 1,
      focused: true,
      visible: true,
    })
    coordinator.register({
      instanceId: 'secondary',
      weight: 1,
      focused: false,
      visible: true,
    })
    coordinator.register({
      instanceId: 'hidden',
      weight: 10,
      focused: false,
      visible: false,
    })

    const full = coordinator.request('focused', { priority: 1, highCost: true })
    const compact = coordinator.request('secondary', { priority: 1, highCost: true })
    const suppressed = coordinator.request('hidden', { priority: 100, highCost: false })

    expect(full.presentation).toBe('full')
    expect(compact.presentation).toBe('compact')
    expect(suppressed.presentation).toBe('suppressed')
    expect(coordinator.getMetrics()).toMatchObject({
      activeCards: 2,
      activeFull: 1,
      activeHighCost: 1,
      fullGranted: 1,
      compactGranted: 1,
      suppressed: 1,
    })

    focused.destroy()
    expect(full.presentation).toBe('suppressed')
    expect(coordinator.getMetrics()).toMatchObject({
      activeCards: 1,
      registeredInstances: 2,
      released: 1,
    })
  })

  it('rebalances active grants when focus and visibility change', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 2,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    const first = coordinator.register({
      instanceId: 'first',
      weight: 1,
      focused: true,
      visible: true,
    })
    const second = coordinator.register({
      instanceId: 'second',
      weight: 2,
      focused: false,
      visible: true,
    })
    const firstGrant = coordinator.request('first', { priority: 1, highCost: false })
    const secondGrant = coordinator.request('second', { priority: 1, highCost: false })
    const transitions: OverlayPresentation[] = []
    secondGrant.subscribe((presentation) => {
      transitions.push(presentation)
    })

    first.update({ focused: false })
    second.update({ focused: true })
    expect(firstGrant.presentation).toBe('compact')
    expect(secondGrant.presentation).toBe('full')
    expect(transitions).toEqual(['full'])
    expect(coordinator.getMetrics()).toMatchObject({ promoted: 1, downgraded: 1 })

    second.update({ visible: false })
    expect(secondGrant.presentation).toBe('suppressed')
    expect(firstGrant.presentation).toBe('full')
    expect(coordinator.getMetrics().activeCards).toBe(1)
  })

  it('releases grants and registrations idempotently on destroy', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 1,
      maxActiveCards: 1,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    coordinator.register({
      instanceId: 'only',
      weight: 1,
      focused: true,
      visible: true,
    })
    const grant = coordinator.request('only', { priority: 1, highCost: true })

    grant.destroy()
    grant.destroy()
    coordinator.destroy()
    coordinator.destroy()

    expect(coordinator.getMetrics()).toMatchObject({
      activeCards: 0,
      activeFull: 0,
      activeHighCost: 0,
      registeredInstances: 0,
      released: 1,
    })
  })
})
