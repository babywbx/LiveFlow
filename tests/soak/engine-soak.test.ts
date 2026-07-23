import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSION } from '../../src/index.js'
import {
  createDanmakuEngine,
  DEFAULT_DANMAKU_LIMITS,
  type DanmakuMeasurement,
  type DanmakuMessage,
  type DanmakuRenderFrame,
  type DanmakuRenderer,
  type DanmakuViewport,
} from '../../src/danmaku/index.js'
import {
  createOverlayBudgetCoordinator,
  createOverlayEngine,
  DEFAULT_OVERLAY_LIMITS,
  type OverlayPresentation,
  type OverlayRenderer,
  type RealtimeOverlayEvent,
} from '../../src/overlay/index.js'
import type { Destroyable } from '../../src/shared/disposable.js'
import { FakeClock } from '../fixtures/fake-clock.js'

const requestedDurationMs = Number.parseInt(process.env.SOAK_DURATION_MS ?? '300000', 10)
const totalDurationMs =
  Number.isFinite(requestedDurationMs) && requestedDurationMs > 0 ? requestedDurationMs : 300_000
const realTime = process.env.SOAK_REALTIME === 'true'
const stepMs = 250

class SoakDanmakuRenderer implements DanmakuRenderer {
  private readonly mounted = new Set<string>()
  maxMounted = 0
  frames = 0
  destroyed = false

  measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[] {
    return messages.map((message) => ({
      id: message.id,
      width: 120 + (message.text.length % 12) * 5,
      height: 24,
    }))
  }

  render(frame: DanmakuRenderFrame): void {
    this.frames += 1
    for (const id of frame.unmounts) {
      this.mounted.delete(id)
    }
    for (const item of frame.mounts) {
      this.mounted.add(item.message.id)
    }
    this.maxMounted = Math.max(this.maxMounted, this.mounted.size)
  }

  resize(_viewport: DanmakuViewport): void {}

  setPaused(_paused: boolean): void {}

  destroy(): void {
    this.destroyed = true
    this.mounted.clear()
  }

  mountedCount(): number {
    return this.mounted.size
  }
}

class SoakOverlayRenderer implements OverlayRenderer {
  active = 0
  maxActive = 0
  destroyed = false

  render(_event: RealtimeOverlayEvent, _presentation: OverlayPresentation): Destroyable {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    let released = false
    return {
      destroy: (): void => {
        if (released) {
          return
        }
        released = true
        this.active -= 1
      },
    }
  }

  destroy(): void {
    this.destroyed = true
  }
}

interface ProfileSummary {
  readonly instances: number
  readonly simulatedDurationMs: number
  readonly danmakuReceived: number
  readonly danmakuDropped: number
  readonly overlayReceived: number
  readonly overlayDropped: number
  readonly peakHeapBytes: number
}

describe('synthetic long-running engines', () => {
  it('keeps four and nine instance profiles bounded through stable, burst, and extreme input', async () => {
    const profileDurationMs = Math.max(stepMs, Math.floor(totalDurationMs / 2))
    const four = await runProfile(4, profileDurationMs)
    const nine = await runProfile(9, profileDurationMs)

    console.log(JSON.stringify({ kind: 'liveflow-soak', realTime, profiles: [four, nine] }))

    expect(four.instances).toBe(4)
    expect(nine.instances).toBe(9)
    expect(four.danmakuDropped).toBeGreaterThan(0)
    expect(nine.danmakuDropped).toBeGreaterThan(0)
    expect(four.overlayDropped).toBeGreaterThan(0)
    expect(nine.overlayDropped).toBeGreaterThan(0)
  })
})

async function runProfile(instances: number, durationMs: number): Promise<ProfileSummary> {
  const clock = new FakeClock()
  const coordinator = createOverlayBudgetCoordinator({
    maxInstances: instances,
    maxActiveCards: Math.min(instances, 3),
    maxFullCards: 1,
    maxHighCostAnimations: 1,
  })
  const renderers = Array.from({ length: instances }, () => ({
    danmaku: new SoakDanmakuRenderer(),
    overlay: new SoakOverlayRenderer(),
  }))
  const engines = renderers.map((renderer, index) => ({
    danmaku: createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer: renderer.danmaku,
      viewport: { width: 640, height: 180 },
    }),
    overlay: createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: `soak-${String(instances)}-${String(index)}`,
      instanceState: {
        weight: instances - index,
        focused: index === 0,
        visible: true,
      },
      clock,
      coordinator,
      defaultRenderer: renderer.overlay,
    }),
  }))
  const startingHeapBytes = process.memoryUsage().heapUsed
  let peakHeapBytes = startingHeapBytes
  let sequence = 0

  try {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += stepMs) {
      const phase = Math.floor(elapsedMs / 10_000) % 3
      const messageCount = phase === 0 ? 2 : phase === 1 ? 24 : 80
      for (const [instanceIndex, engine] of engines.entries()) {
        for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
          sequence += 1
          engine.danmaku.push(
            syntheticMessage(
              `d-${String(instances)}-${String(instanceIndex)}-${String(sequence)}`,
              clock.now(),
              messageIndex,
            ),
          )
        }
        for (let eventIndex = 0; eventIndex < 6; eventIndex += 1) {
          sequence += 1
          engine.overlay.submit(
            syntheticOverlayEvent(
              `o-${String(instances)}-${String(instanceIndex)}-${String(sequence)}`,
              clock.now(),
              eventIndex,
            ),
          )
        }
      }

      clock.advanceBy(stepMs)
      assertRuntimeBounds(engines, coordinator)
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
      if (realTime) {
        await delay(stepMs)
      } else if (elapsedMs % 30_000 === 0) {
        await delay(0)
      }
    }

    const danmakuMetrics = engines.map((engine) => engine.danmaku.getMetrics())
    const overlayMetrics = engines.map((engine) => engine.overlay.getMetrics())
    const heapGrowthBytes = process.memoryUsage().heapUsed - startingHeapBytes
    expect(heapGrowthBytes).toBeLessThan(192 * 1024 * 1024)

    return {
      instances,
      simulatedDurationMs: durationMs,
      danmakuReceived: sum(danmakuMetrics.map((metrics) => metrics.received)),
      danmakuDropped: sum(danmakuMetrics.map((metrics) => metrics.dropped)),
      overlayReceived: sum(overlayMetrics.map((metrics) => metrics.received)),
      overlayDropped: sum(overlayMetrics.map((metrics) => metrics.dropped)),
      peakHeapBytes,
    }
  } finally {
    for (const engine of engines) {
      engine.danmaku.destroy()
      engine.overlay.destroy()
    }
    coordinator.destroy()

    expect(clock.pendingTaskCount()).toBe(0)
    expect(coordinator.getMetrics()).toMatchObject({
      registeredInstances: 0,
      activeCards: 0,
      activeFull: 0,
      activeHighCost: 0,
    })
    for (const renderer of renderers) {
      expect(renderer.danmaku.destroyed).toBe(true)
      expect(renderer.danmaku.mountedCount()).toBe(0)
      expect(renderer.overlay.destroyed).toBe(true)
      expect(renderer.overlay.active).toBe(0)
    }
  }
}

function syntheticMessage(id: string, receivedAt: number, index: number): DanmakuMessage {
  return {
    id,
    receivedAt,
    text: `Synthetic bounded message ${String(index % 17)}`,
    mode: index % 11 === 0 ? 'top' : 'scroll',
    priority: index % 9 === 0 ? 90 : 10,
    identities: [{ kind: 'badge', label: `Level ${String((index % 20) + 1)}` }],
  }
}

function syntheticOverlayEvent(
  id: string,
  receivedAt: number,
  index: number,
): RealtimeOverlayEvent {
  return {
    id,
    dedupeKey: id,
    kind: 'soak',
    receivedAt,
    priority: index === 0 ? 90 : 10,
    durationMs: 1_000,
    nodes: [{ type: 'text', role: 'message', text: 'Synthetic bounded event' }],
  }
}

function assertRuntimeBounds(
  engines: ReadonlyArray<{
    readonly danmaku: ReturnType<typeof createDanmakuEngine>
    readonly overlay: ReturnType<typeof createOverlayEngine>
  }>,
  coordinator: ReturnType<typeof createOverlayBudgetCoordinator>,
): void {
  for (const engine of engines) {
    const danmaku = engine.danmaku.getMetrics()
    const overlay = engine.overlay.getMetrics()
    expect(danmaku.pendingDepth).toBeLessThanOrEqual(DEFAULT_DANMAKU_LIMITS.maxPending)
    expect(danmaku.visible).toBeLessThanOrEqual(DEFAULT_DANMAKU_LIMITS.maxVisible)
    expect(overlay.pendingDepth).toBeLessThanOrEqual(DEFAULT_OVERLAY_LIMITS.maxPending)
    expect(overlay.visible).toBeLessThanOrEqual(DEFAULT_OVERLAY_LIMITS.maxVisible)
  }
  const budget = coordinator.getMetrics()
  expect(budget.registeredInstances).toBeLessThanOrEqual(engines.length)
  expect(budget.activeCards).toBeLessThanOrEqual(Math.min(engines.length, 3))
  expect(budget.activeFull).toBeLessThanOrEqual(1)
  expect(budget.activeHighCost).toBeLessThanOrEqual(1)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
