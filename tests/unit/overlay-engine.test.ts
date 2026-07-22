import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSION,
  InvalidOverlayConfigurationError,
  InvalidOverlayEventError,
  createOverlayEngine,
  type OverlayPresentation,
  type OverlayRenderer,
  type RealtimeOverlayEvent,
} from '../../src/overlay/index.js'
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
})
