import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSION,
  InvalidOverlayConfigurationError,
  InvalidOverlayEventError,
  OverlayCleanupError,
  OverlaySchedulingError,
  createOverlayEngine,
  createSafeOverlayRenderer,
  type OverlayBudgetCoordinator,
  type OverlayBudgetGrant,
  type OverlayBudgetMetrics,
  type OverlayBudgetRegistration,
  type OverlayInstanceStateUpdate,
  type OverlayPresentation,
  type OverlayRenderer,
  type RealtimeOverlayEvent,
} from '../../src/overlay/index.js'
import type { TimerHandle } from '../../src/shared/clock.js'
import type { Destroyable } from '../../src/shared/disposable.js'
import { FakeClock } from '../fixtures/fake-clock.js'

class RecordingRenderer implements OverlayRenderer {
  readonly rendered: Array<{ id: string; presentation: OverlayPresentation }> = []
  readonly removed: string[] = []
  destroyCalls = 0

  render(event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable {
    this.rendered.push({ id: event.id, presentation })
    return {
      destroy: (): void => {
        this.removed.push(event.id)
      },
    }
  }

  destroy(): void {
    this.destroyCalls += 1
  }
}

class ReversingClock extends FakeClock {
  private current = 0

  override now(): number {
    return this.current
  }

  setNow(value: number): void {
    this.current = value
  }
}

class FlakyCleanupClock extends FakeClock {
  clearCalls = 0

  override clearTimeout(handle: TimerHandle): void {
    this.clearCalls += 1
    if (this.clearCalls === 1) {
      throw new Error('timer cleanup failed')
    }
    super.clearTimeout(handle)
  }
}

class FailingScheduleClock extends FakeClock {
  override setTimeout(): TimerHandle {
    throw new Error('timer scheduling failed')
  }
}

class FlakyCleanupRenderer extends RecordingRenderer {
  handleDestroyCalls = 0

  override render(event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable {
    const handle = super.render(event, presentation)
    return {
      destroy: (): void => {
        this.handleDestroyCalls += 1
        if (this.handleDestroyCalls === 1) {
          throw new Error('render handle cleanup failed')
        }
        handle.destroy()
      },
    }
  }

  override destroy(): void {
    super.destroy()
    if (this.destroyCalls === 1) {
      throw new Error('renderer cleanup failed')
    }
  }
}

class FlakyDetachedHandleRenderer extends RecordingRenderer {
  handleDestroyCalls = 0

  override render(event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable {
    super.render(event, presentation)
    return {
      destroy: (): void => {
        this.handleDestroyCalls += 1
        if (this.handleDestroyCalls === 1) {
          throw new Error('detached handle cleanup failed')
        }
        this.removed.push(event.id)
      },
    }
  }
}

class FlakyCleanupCoordinator implements OverlayBudgetCoordinator {
  grantDestroyCalls = 0
  registrationDestroyCalls = 0
  unsubscribeCalls = 0

  register(): OverlayBudgetRegistration {
    return {
      update(): void {},
      destroy: (): void => {
        this.registrationDestroyCalls += 1
        if (this.registrationDestroyCalls === 1) {
          throw new Error('registration cleanup failed')
        }
      },
    }
  }

  request(): OverlayBudgetGrant {
    return {
      presentation: 'full',
      subscribe: () => {
        return (): void => {
          this.unsubscribeCalls += 1
          if (this.unsubscribeCalls === 1) {
            throw new Error('grant unsubscribe failed')
          }
        }
      },
      destroy: (): void => {
        this.grantDestroyCalls += 1
        if (this.grantDestroyCalls === 1) {
          throw new Error('grant cleanup failed')
        }
      },
    }
  }

  getMetrics(): OverlayBudgetMetrics {
    return {
      requests: 0,
      fullGranted: 0,
      compactGranted: 0,
      suppressed: 0,
      promoted: 0,
      downgraded: 0,
      released: 0,
      registeredInstances: 1,
      activeCards: 1,
      activeFull: 1,
      activeHighCost: 0,
    }
  }

  destroy(): void {}
}

const EMPTY_BUDGET_METRICS: OverlayBudgetMetrics = {
  requests: 0,
  fullGranted: 0,
  compactGranted: 0,
  suppressed: 0,
  promoted: 0,
  downgraded: 0,
  released: 0,
  registeredInstances: 0,
  activeCards: 0,
  activeFull: 0,
  activeHighCost: 0,
}

interface FakeOverlayElement {
  textContent: string | null
  append(...children: FakeOverlayElement[]): void
  remove(): void
  setAttribute(name: string, value: string): void
}

function createFakeOverlayElement(removeFailures = 0): FakeOverlayElement {
  return {
    textContent: null,
    append(): void {},
    remove(): void {
      if (removeFailures > 0) {
        removeFailures -= 1
        throw new Error('remove failed')
      }
    },
    setAttribute(): void {},
  }
}

function isOverlayContainer(value: unknown): value is HTMLElement {
  return (
    typeof value === 'object' && value !== null && 'ownerDocument' in value && 'append' in value
  )
}

function event(
  id: string,
  priority: number,
  receivedAt = 0,
  dedupeKey?: string,
): RealtimeOverlayEvent {
  const base = {
    id,
    kind: 'gift',
    receivedAt,
    priority,
    durationMs: 1_000,
    nodes: [{ type: 'text', role: 'body', text: `message-${id}` }] as const,
  }
  return dedupeKey === undefined ? base : { ...base, dedupeKey }
}

describe('realtime overlay', () => {
  it('rejects malformed structured events at the public seam', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
    })

    expect(() =>
      overlay.submit({
        id: '',
        kind: 'gift',
        receivedAt: 0,
        priority: 1,
        durationMs: 1_000,
        nodes: [],
      }),
    ).toThrow(InvalidOverlayEventError)
    expect(overlay.getMetrics().received).toBe(1)
  })

  it('rolls back its renderer when coordinator registration fails', () => {
    const renderer = new RecordingRenderer()
    const coordinator: OverlayBudgetCoordinator = {
      register(): never {
        throw new Error('https://budget.test/register?token=secret')
      },
      request(): OverlayBudgetGrant {
        throw new Error('request not expected')
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    let creationError: unknown

    try {
      createOverlayEngine({
        contractVersion: CONTRACT_VERSION,
        instanceId: 'primary',
        clock: new FakeClock(),
        coordinator,
        defaultRenderer: renderer,
      })
    } catch (error) {
      creationError = error
    }

    expect(creationError).toBeInstanceOf(InvalidOverlayConfigurationError)
    expect(String(creationError)).not.toContain('secret')
    expect(renderer.destroyCalls).toBe(1)
  })

  it('does not expose errors thrown by hostile event getters', () => {
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      defaultRenderer: new RecordingRenderer(),
    })
    const hostile = event('hostile', 1)
    Object.defineProperty(hostile, 'id', {
      get(): never {
        throw new Error('https://media.test/live.m3u8?token=secret')
      },
    })

    expect(() => overlay.submit(hostile)).toThrow(InvalidOverlayEventError)
    try {
      overlay.submit(hostile)
    } catch (error) {
      expect(String(error)).not.toContain('secret')
    }
    overlay.destroy()
  })

  it('parses bounded node arrays without calling an overridden map method', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
    })
    const nodes = [{ type: 'text', role: 'body', text: 'safe' }]
    let mapCalls = 0
    Object.defineProperty(nodes, 'map', {
      value(): never {
        mapCalls += 1
        throw new Error('overridden map called')
      },
    })

    expect(overlay.submit({ ...event('bounded-nodes', 1), nodes })).toEqual({
      status: 'displayed',
    })
    expect(mapCalls).toBe(0)
    overlay.destroy()
  })

  it('rejects a node proxy with a fractional length', () => {
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      defaultRenderer: new RecordingRenderer(),
    })
    const nodes = new Proxy([...event('fractional-nodes', 1).nodes], {
      get(target, property, receiver): unknown {
        return property === 'length' ? 0.5 : Reflect.get(target, property, receiver)
      },
    })

    expect(() => overlay.submit({ ...event('fractional-nodes', 1), nodes })).toThrow(
      InvalidOverlayEventError,
    )
    overlay.destroy()
  })

  it('keeps the pending queue bounded and preserves higher-priority events', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
      limits: { maxPending: 2 },
    })

    expect(overlay.submit(event('visible', 10)).status).toBe('displayed')
    expect(overlay.submit(event('low', 1)).status).toBe('queued')
    expect(overlay.submit(event('middle', 2)).status).toBe('queued')
    expect(overlay.submit(event('high', 9)).status).toBe('queued')
    expect(overlay.getMetrics()).toMatchObject({ pendingDepth: 2, dropped: 1 })

    clock.advanceBy(1_000)
    expect(renderer.rendered.map((item) => item.id)).toEqual(['visible', 'high'])
  })

  it('deduplicates within the configured window and accepts the key afterwards', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
      limits: { dedupeWindowMs: 2_000 },
    })

    expect(overlay.submit(event('first', 1, 0, 'same')).status).toBe('displayed')
    expect(overlay.submit(event('duplicate', 9, 0, 'same')).status).toBe('deduped')
    clock.advanceBy(2_001)
    expect(overlay.submit(event('later', 1, 2_001, 'same')).status).toBe('displayed')
    expect(overlay.getMetrics().deduped).toBe(1)
  })

  it('expires historical events instead of replaying the backlog', () => {
    const clock = new FakeClock()
    clock.advanceBy(5_000)
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
      limits: { maxEventLifetimeMs: 2_000 },
    })

    expect(overlay.submit(event('old', 100, 0)).status).toBe('expired')
    expect(renderer.rendered).toEqual([])
    expect(overlay.getMetrics().expired).toBe(1)
  })

  it('uses only bounded timers and destroys every active resource exactly once', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
    })

    overlay.submit(event('visible', 1))
    expect(clock.pendingTaskCount()).toBe(1)

    overlay.destroy()
    overlay.destroy()

    expect(clock.pendingTaskCount()).toBe(0)
    expect(renderer.removed).toEqual(['visible'])
    expect(renderer.destroyCalls).toBe(1)
  })

  it('retries every cleanup phase before destroying its owners', () => {
    const clock = new FlakyCleanupClock()
    const renderer = new FlakyCleanupRenderer()
    const coordinator = new FlakyCleanupCoordinator()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      coordinator,
      defaultRenderer: renderer,
    })

    overlay.submit(event('retry-cleanup', 1))

    expect(() => overlay.destroy()).toThrow(OverlayCleanupError)
    expect(clock.pendingTaskCount()).toBe(1)
    expect(renderer.handleDestroyCalls).toBe(1)
    expect(renderer.destroyCalls).toBe(0)
    expect(coordinator.unsubscribeCalls).toBe(1)
    expect(coordinator.grantDestroyCalls).toBe(1)
    expect(coordinator.registrationDestroyCalls).toBe(0)

    expect(() => overlay.destroy()).toThrow(OverlayCleanupError)
    expect(clock.pendingTaskCount()).toBe(0)
    expect(renderer.handleDestroyCalls).toBe(2)
    expect(renderer.destroyCalls).toBe(1)
    expect(coordinator.unsubscribeCalls).toBe(2)
    expect(coordinator.grantDestroyCalls).toBe(2)
    expect(coordinator.registrationDestroyCalls).toBe(1)
    expect(overlay.getMetrics().visible).toBe(0)

    expect(() => overlay.destroy()).not.toThrow()
    expect(renderer.destroyCalls).toBe(2)
    expect(coordinator.registrationDestroyCalls).toBe(2)

    overlay.destroy()
    expect(renderer.destroyCalls).toBe(2)
  })

  it('drops request failures as typed errors without retaining dedupe state', () => {
    let requestCalls = 0
    const errors: Error[] = []
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return { update(): void {}, destroy(): void {} }
      },
      request(): never {
        requestCalls += 1
        throw new Error('https://budget.test/request?token=secret')
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: new RecordingRenderer(),
      onError: (error): void => {
        errors.push(error)
      },
    })

    expect(overlay.submit(event('request-failure', 1))).toEqual({ status: 'dropped' })
    expect(overlay.submit(event('request-failure', 1))).toEqual({ status: 'dropped' })
    expect(requestCalls).toBe(2)
    expect(errors).toHaveLength(2)
    expect(errors.every((error) => error instanceof OverlaySchedulingError)).toBe(true)
    expect(errors.map(String).join(' ')).not.toContain('secret')
    expect(overlay.getMetrics().deduped).toBe(0)
    overlay.destroy()
  })

  it('limits one drain turn when budget requests submit synchronously', () => {
    let requestCalls = 0
    let submitReentrant = (): void => {}
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return { update(): void {}, destroy(): void {} }
      },
      request(): OverlayBudgetGrant {
        requestCalls += 1
        if (requestCalls <= 4) {
          submitReentrant()
        }
        return {
          presentation: 'suppressed',
          subscribe(): () => void {
            return (): void => {}
          },
          destroy(): void {},
        }
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: new RecordingRenderer(),
    })
    submitReentrant = (): void => {
      overlay.submit(event(`reentrant-${String(requestCalls)}`, 1))
    }

    expect(overlay.submit(event('seed', 1))).toEqual({ status: 'dropped' })
    expect(requestCalls).toBe(1)
    expect(overlay.getMetrics().pendingDepth).toBe(1)

    submitReentrant = (): void => {}
    expect(overlay.submit(event('flush', 1))).toEqual({ status: 'dropped' })
    expect(requestCalls).toBe(3)
    expect(overlay.getMetrics().pendingDepth).toBe(0)
    overlay.destroy()
  })

  it('does not publish a grant returned after synchronous destroy', () => {
    let destroyOverlay = (): void => {}
    let grantDestroyCalls = 0
    let registrationDestroyCalls = 0
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return {
          update(): void {},
          destroy(): void {
            registrationDestroyCalls += 1
          },
        }
      },
      request(): OverlayBudgetGrant {
        destroyOverlay()
        return {
          presentation: 'full',
          subscribe(): () => void {
            return (): void => {}
          },
          destroy(): void {
            grantDestroyCalls += 1
          },
        }
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: renderer,
    })
    destroyOverlay = (): void => {
      overlay.destroy()
    }

    expect(overlay.submit(event('destroy-in-request', 1))).toEqual({ status: 'dropped' })
    expect(grantDestroyCalls).toBe(1)
    expect(renderer.rendered).toEqual([])
    expect(renderer.destroyCalls).toBe(1)
    expect(registrationDestroyCalls).toBe(1)
    expect(overlay.getMetrics().visible).toBe(0)
  })

  it('cleans a render handle before its owner after synchronous destroy', () => {
    let destroyOverlay = (): void => {}
    let rendererDestroyed = false
    let registrationDestroyed = false
    let handleDestroyCalls = 0
    let grantDestroyCalls = 0
    const renderer: OverlayRenderer = {
      render(): Destroyable {
        destroyOverlay()
        return {
          destroy(): void {
            handleDestroyCalls += 1
            if (rendererDestroyed) {
              throw new Error('renderer owner destroyed first')
            }
          },
        }
      },
      destroy(): void {
        rendererDestroyed = true
      },
    }
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return {
          update(): void {},
          destroy(): void {
            registrationDestroyed = true
          },
        }
      },
      request(): OverlayBudgetGrant {
        return {
          presentation: 'full',
          subscribe(): () => void {
            return (): void => {}
          },
          destroy(): void {
            grantDestroyCalls += 1
            if (registrationDestroyed) {
              throw new Error('registration owner destroyed first')
            }
          },
        }
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: renderer,
    })
    destroyOverlay = (): void => {
      overlay.destroy()
    }

    expect(overlay.submit(event('destroy-in-render', 1))).toEqual({ status: 'dropped' })
    expect(handleDestroyCalls).toBe(1)
    expect(grantDestroyCalls).toBe(1)
    expect(rendererDestroyed).toBe(true)
    expect(registrationDestroyed).toBe(true)
    expect(overlay.getMetrics().visible).toBe(0)
  })

  it('defers owner cleanup until synchronous subscribe returns', () => {
    let destroyOverlay = (): void => {}
    let registrationDestroyed = false
    let unsubscribeCalls = 0
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return {
          update(): void {},
          destroy(): void {
            registrationDestroyed = true
          },
        }
      },
      request(): OverlayBudgetGrant {
        return {
          presentation: 'full',
          subscribe(): () => void {
            destroyOverlay()
            return (): void => {
              unsubscribeCalls += 1
              if (registrationDestroyed) {
                throw new Error('registration owner destroyed first')
              }
            }
          },
          destroy(): void {},
        }
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: new RecordingRenderer(),
    })
    destroyOverlay = (): void => {
      overlay.destroy()
    }

    expect(overlay.submit(event('destroy-in-subscribe', 1))).toEqual({ status: 'dropped' })
    expect(unsubscribeCalls).toBe(1)
    expect(registrationDestroyed).toBe(true)
    expect(overlay.getMetrics().visible).toBe(0)
    expect(() => overlay.destroy()).not.toThrow()
    expect(unsubscribeCalls).toBe(1)
  })

  it('cleans grants whose presentation getter fails and allows a retry', () => {
    let grantDestroyCalls = 0
    let requestCalls = 0
    const errors: Error[] = []
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return { update(): void {}, destroy(): void {} }
      },
      request(): OverlayBudgetGrant {
        requestCalls += 1
        if (requestCalls > 1) {
          const grant: OverlayBudgetGrant = {
            presentation: 'full',
            subscribe(): () => void {
              return (): void => {}
            },
            destroy(): void {
              grantDestroyCalls += 1
            },
          }
          return new Proxy(grant, {
            get(target, property, receiver): unknown {
              return property === 'presentation'
                ? 'invalid-presentation'
                : Reflect.get(target, property, receiver)
            },
          })
        }
        return {
          get presentation(): OverlayPresentation {
            throw new Error('https://budget.test/presentation?token=secret')
          },
          subscribe(): () => void {
            return (): void => {}
          },
          destroy(): void {
            grantDestroyCalls += 1
          },
        }
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: new RecordingRenderer(),
      onError: (error): void => {
        errors.push(error)
      },
    })

    expect(overlay.submit(event('presentation-failure', 1))).toEqual({ status: 'dropped' })
    expect(overlay.submit(event('presentation-failure', 1))).toEqual({ status: 'dropped' })
    expect(grantDestroyCalls).toBe(2)
    expect(errors).toHaveLength(2)
    expect(errors.every((error) => error instanceof OverlaySchedulingError)).toBe(true)
    expect(errors.map(String).join(' ')).not.toContain('secret')
    expect(overlay.getMetrics().deduped).toBe(0)
    overlay.destroy()
  })

  it('owns an unsubscribe returned after a synchronous invalid presentation', () => {
    let grantDestroyCalls = 0
    let unsubscribeCalls = 0
    const errors: Error[] = []
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return { update(): void {}, destroy(): void {} }
      },
      request(): OverlayBudgetGrant {
        return {
          presentation: 'full',
          subscribe(listener): () => void {
            const invalidatingListener = new Proxy(listener, {
              apply(target, thisArgument): unknown {
                return Reflect.apply(target, thisArgument, ['invalid-presentation'])
              },
            })
            invalidatingListener('full')
            return (): void => {
              unsubscribeCalls += 1
              if (unsubscribeCalls === 1) {
                throw new Error('unsubscribe failed')
              }
            }
          },
          destroy(): void {
            grantDestroyCalls += 1
          },
        }
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: renderer,
      onError: (error): void => {
        errors.push(error)
      },
    })

    expect(overlay.submit(event('sync-invalid', 1))).toEqual({ status: 'dropped' })
    expect(grantDestroyCalls).toBe(1)
    expect(unsubscribeCalls).toBe(1)
    expect(renderer.removed).toEqual(['sync-invalid'])
    expect(errors.some((error) => error instanceof OverlaySchedulingError)).toBe(true)

    expect(() => overlay.destroy()).not.toThrow()
    expect(unsubscribeCalls).toBe(2)
  })

  it('commits instance state only after a typed registration update succeeds', () => {
    let updateCalls = 0
    const successfulUpdates: OverlayInstanceStateUpdate[] = []
    const coordinator: OverlayBudgetCoordinator = {
      register(): OverlayBudgetRegistration {
        return {
          update(state): void {
            updateCalls += 1
            if (updateCalls === 1) {
              throw new Error('https://budget.test/update?token=secret')
            }
            successfulUpdates.push(state)
          },
          destroy(): void {},
        }
      },
      request(): OverlayBudgetGrant {
        throw new Error('request not expected')
      },
      getMetrics(): OverlayBudgetMetrics {
        return EMPTY_BUDGET_METRICS
      },
      destroy(): void {},
    }
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FakeClock(),
      coordinator,
      defaultRenderer: new RecordingRenderer(),
    })

    let updateError: unknown
    try {
      overlay.updateInstance({ weight: 2 })
    } catch (error) {
      updateError = error
    }
    expect(updateError).toBeInstanceOf(InvalidOverlayConfigurationError)
    expect(String(updateError)).not.toContain('secret')
    overlay.updateInstance({ focused: true })

    expect(successfulUpdates).toEqual([{ weight: 1, focused: true, visible: true }])
    overlay.destroy()
  })

  it('retries an unscheduled render handle before draining later submissions', () => {
    const renderer = new FlakyDetachedHandleRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock: new FailingScheduleClock(),
      defaultRenderer: renderer,
    })

    expect(overlay.submit(event('unscheduled', 1))).toEqual({ status: 'dropped' })
    expect(renderer.handleDestroyCalls).toBe(1)

    expect(overlay.submit(event('after-cleanup', 1))).toEqual({ status: 'dropped' })
    expect(renderer.handleDestroyCalls).toBe(3)
    expect(renderer.removed).toEqual(['unscheduled', 'after-cleanup'])

    expect(() => overlay.destroy()).not.toThrow()
    expect(renderer.handleDestroyCalls).toBe(3)
  })

  it('selects a registered kind renderer and keeps the safe fallback separate', () => {
    const clock = new FakeClock()
    const fallback = new RecordingRenderer()
    const giftRenderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: fallback,
    })
    const registration = overlay.registerRenderer('gift', giftRenderer)

    overlay.submit(event('gift-event', 1))
    clock.advanceBy(1_000)
    overlay.submit({ ...event('custom-event', 1, 1_000), kind: 'custom' })

    expect(giftRenderer.rendered.map((item) => item.id)).toEqual(['gift-event'])
    expect(fallback.rendered.map((item) => item.id)).toEqual(['custom-event'])

    registration.destroy()
    registration.destroy()
    expect(giftRenderer.destroyCalls).toBe(0)
    overlay.destroy()
    expect(giftRenderer.destroyCalls).toBe(1)
  })

  it('drops new dedupe keys when the bounded history is saturated', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
      limits: { maxDedupeEntries: 2 },
    })

    expect(overlay.submit(event('first', 1)).status).toBe('displayed')
    expect(overlay.submit(event('second', 1)).status).toBe('queued')
    expect(overlay.submit(event('third', 100)).status).toBe('dropped')
    expect(overlay.getMetrics()).toMatchObject({
      accepted: 2,
      dropped: 1,
      pendingDepth: 1,
    })
  })

  it('rate-limits overlay diagnostics and ignores diagnostic callback failures', () => {
    const clock = new FakeClock()
    const renderer = new RecordingRenderer()
    const codes: string[] = []
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
      onDiagnostic(diagnostic): void {
        codes.push(diagnostic.code)
        throw new Error('diagnostic sink failed')
      },
    })

    overlay.submit(event('first', 1, 0, 'same'))
    expect(overlay.submit(event('second', 1, 0, 'same')).status).toBe('deduped')
    expect(overlay.submit(event('third', 1, 0, 'same')).status).toBe('deduped')

    expect(codes).toEqual(['overlay-event-deduped'])
    expect(overlay.getMetrics().deduped).toBe(2)
  })

  it('rejects a custom clock that moves backwards', () => {
    const clock = new ReversingClock()
    const renderer = new RecordingRenderer()
    const overlay = createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'primary',
      clock,
      defaultRenderer: renderer,
    })

    clock.setNow(10)
    overlay.submit(event('first', 1, 10))
    clock.setNow(9)

    expect(() => overlay.submit(event('second', 1, 9))).toThrow(InvalidOverlayConfigurationError)
    overlay.destroy()
  })

  it('retries safe renderer node removal after a failure', () => {
    const root = createFakeOverlayElement(1)
    let created = 0
    const container = {
      ownerDocument: {
        baseURI: 'https://example.test/',
        createElement(): FakeOverlayElement {
          created += 1
          return created === 1 ? root : createFakeOverlayElement()
        },
      },
      append(): void {},
    }
    if (!isOverlayContainer(container)) {
      throw new Error('invalid overlay container')
    }
    const renderer = createSafeOverlayRenderer(container)
    const handle = renderer.render(event('safe-renderer-retry', 1), 'compact')

    expect(() => handle.destroy()).toThrow('remove failed')
    expect(() => handle.destroy()).not.toThrow()
    expect(() => handle.destroy()).not.toThrow()
  })
})
