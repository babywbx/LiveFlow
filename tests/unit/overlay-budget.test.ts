import { describe, expect, it } from 'vitest'

import {
  createOverlayBudgetCoordinator,
  InvalidOverlayConfigurationError,
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

  it('validates idle registrations and uses their latest state for the next grant', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 2,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    coordinator.register({ instanceId: 'visible', weight: 2, focused: false, visible: true })
    const idle = coordinator.register({
      instanceId: 'idle',
      weight: 1,
      focused: false,
      visible: false,
    })
    const first = coordinator.request('visible', { priority: 1, highCost: false })
    expect(() => idle.update({ weight: 0 })).toThrow(InvalidOverlayConfigurationError)
    idle.update({ visible: true, focused: true })
    expect(first.presentation).toBe('full')
    const second = coordinator.request('idle', { priority: 1, highCost: false })
    idle.update({ focused: true })
    expect(second.presentation).toBe('full')
    expect(first.presentation).toBe('compact')
    expect(coordinator.getMetrics().downgraded).toBe(1)
    coordinator.destroy()
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

  it('reconciles a nested focus change before skipping an unchanged update', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 2,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    const first = coordinator.register({
      instanceId: 'a',
      weight: 1,
      focused: false,
      visible: true,
    })
    coordinator.register({ instanceId: 'b', weight: 2, focused: false, visible: true })
    const a = coordinator.request('a', { priority: 1, highCost: false })
    const b = coordinator.request('b', { priority: 1, highCost: false })
    first.update({
      get focused(): boolean {
        first.update({ focused: true })
        return false
      },
    })
    expect([a.presentation, b.presentation]).toEqual(['compact', 'full'])
    coordinator.destroy()
  })

  it('keeps the latest allocation when a promoted grant releases itself', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 2,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    coordinator.register({ instanceId: 'a', weight: 2, focused: false, visible: true })
    const secondary = coordinator.register({
      instanceId: 'b',
      weight: 1,
      focused: false,
      visible: true,
    })
    const first = coordinator.request('a', { priority: 1, highCost: false })
    const second = coordinator.request('b', { priority: 1, highCost: false })
    const updates: OverlayPresentation[] = []
    first.subscribe((presentation) => updates.push(presentation))
    second.subscribe((presentation) => {
      updates.push(presentation)
      if (presentation === 'full') second.destroy()
    })
    secondary.update({ focused: true })
    expect(updates).toEqual(['compact', 'full', 'suppressed', 'full'])
    expect(first.presentation).toBe('full')
    expect(coordinator.getMetrics()).toMatchObject({
      activeCards: 1,
      activeFull: 1,
      released: 1,
      promoted: 2,
      downgraded: 1,
    })
    coordinator.destroy()
  })

  it('releases each grant once when a revocation listener destroys the coordinator', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 1,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    const registration = coordinator.register({
      instanceId: 'only',
      weight: 1,
      focused: false,
      visible: true,
    })
    const first = coordinator.request('only', { priority: 1, highCost: false })
    const second = coordinator.request('only', { priority: 1, highCost: false })
    first.subscribe((presentation) => {
      if (presentation === 'suppressed') coordinator.destroy()
    })
    registration.update({ visible: false })
    expect(second.presentation).toBe('suppressed')
    expect(coordinator.getMetrics()).toMatchObject({ activeCards: 0, released: 2 })
  })

  it('stays within full and animation limits inside presentation callbacks', () => {
    const coordinator = createOverlayBudgetCoordinator({
      maxInstances: 2,
      maxActiveCards: 2,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    coordinator.register({ instanceId: 'a', weight: 2, focused: false, visible: true })
    const secondary = coordinator.register({
      instanceId: 'b',
      weight: 1,
      focused: false,
      visible: true,
    })
    const first = coordinator.request('a', { priority: 1, highCost: true })
    const second = coordinator.request('b', { priority: 1, highCost: true })
    const observations: number[][] = []
    for (const grant of [first, second]) {
      grant.subscribe(() => {
        const { activeFull, activeHighCost } = coordinator.getMetrics()
        observations.push([activeFull, activeHighCost])
      })
    }
    secondary.update({ focused: true })
    expect(observations).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(second.presentation).toBe('full')
    coordinator.destroy()
  })
})
