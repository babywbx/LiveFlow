import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSION } from '../../src/index.js'
import {
  createDanmakuEngine,
  type DanmakuMeasurement,
  type DanmakuMessage,
  type DanmakuRenderFrame,
  type DanmakuRenderer,
  type DanmakuViewport,
} from '../../src/danmaku/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'

class SizedRenderer implements DanmakuRenderer {
  readonly frames: DanmakuRenderFrame[] = []
  readonly positions = new Map<string, number>()
  viewport: DanmakuViewport = { width: 0, height: 0 }

  measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[] {
    return messages.map((message) => ({
      id: message.id,
      width: message.id === 'wide' ? 280 : 100,
      height: 24,
    }))
  }

  render(frame: DanmakuRenderFrame): void {
    this.frames.push(frame)
    for (const item of frame.mounts) this.positions.set(item.message.id, item.x)
    for (const item of frame.updates) this.positions.set(item.id, item.x)
    for (const id of frame.unmounts) this.positions.delete(id)
  }

  resize(viewport: DanmakuViewport): void {
    this.viewport = viewport
  }

  setPaused(): void {}

  destroy(): void {}
}

function message(id: string, mode: DanmakuMessage['mode'] = 'scroll'): DanmakuMessage {
  return {
    id,
    receivedAt: 0,
    text: id,
    mode,
    priority: 0,
  }
}

function position(renderer: SizedRenderer, id: string): number {
  const value = renderer.positions.get(id)
  if (value === undefined) throw new Error(`Missing position for ${id}.`)
  return value
}

describe('danmaku scheduling', () => {
  it('does not overlap a fixed message with a scrolling message in the same track', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 32 },
      policy: {
        fixedDurationMs: 1_000,
        maxLaneWaitMs: 2_000,
      },
    })

    engine.push(message('fixed', 'top'))
    engine.push(message('scrolling'))
    clock.advanceBy(16)

    expect(renderer.frames.at(-1)?.mounts.map((item) => item.message.id)).toEqual(['fixed'])
    expect(engine.getMetrics().pendingDepth).toBe(1)

    clock.advanceBy(1_008)

    expect(renderer.frames.at(-1)?.mounts.map((item) => item.message.id)).toContain('scrolling')
  })

  it('waits until the previous scrolling tail clears the safe lane gap', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 32 },
      policy: {
        scrollPixelsPerSecond: 100,
        laneGap: 20,
        maxLaneWaitMs: 5_000,
      },
    })

    engine.push(message('wide'))
    engine.push(message('second'))
    clock.advanceBy(16)

    expect(renderer.frames.at(-1)?.mounts.map((item) => item.message.id)).toEqual(['wide'])

    clock.advanceBy(2_800)

    const mountedIds = renderer.frames.flatMap((frame) =>
      frame.mounts.map((item) => item.message.id),
    )
    expect(mountedIds).toEqual(['wide'])

    clock.advanceBy(400)

    expect(renderer.frames.flatMap((frame) => frame.mounts.map((item) => item.message.id))).toEqual(
      ['wide', 'second'],
    )
  })

  it('uses one duration so wider scrolling messages move faster', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 64 },
      limits: { maxMountsPerFrame: 2 },
      policy: { scrollDurationMs: 4_000 },
    })

    engine.push(message('second'))
    engine.push(message('wide'))
    clock.advanceBy(16)
    clock.advanceBy(1_000)

    const narrowTravel = 320 - position(renderer, 'second')
    const wideTravel = 320 - position(renderer, 'wide')
    expect(wideTravel / narrowTravel).toBeCloseTo((320 + 280) / (320 + 100), 6)
    engine.destroy()
  })

  it('adds stable bounded duration jitter from the message id', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 64 },
      limits: { maxMountsPerFrame: 2 },
      policy: { scrollDurationMs: 4_000, scrollDurationJitterMs: 1_000 },
    })

    engine.push(message('a'))
    engine.push(message('b'))
    clock.advanceBy(16)
    clock.advanceBy(1_000)

    const firstDuration = 420_000 / (320 - position(renderer, 'a'))
    const secondDuration = 420_000 / (320 - position(renderer, 'b'))
    expect(firstDuration).toBeGreaterThanOrEqual(4_000)
    expect(firstDuration).toBeLessThan(5_000)
    expect(secondDuration).toBeGreaterThanOrEqual(4_000)
    expect(secondDuration).toBeLessThan(5_000)
    expect(firstDuration).not.toBe(secondDuration)
    engine.destroy()
  })

  it('rejects scroll durations below one millisecond', () => {
    expect(() =>
      createDanmakuEngine({
        contractVersion: CONTRACT_VERSION,
        clock: new FakeClock(),
        renderer: new SizedRenderer(),
        viewport: { width: 320, height: 32 },
        policy: { scrollDurationMs: Number.EPSILON },
      }),
    ).toThrow('policy.scrollDurationMs')
  })

  it('reuses a lane once the leading message has entered with the configured gap', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 32 },
      policy: {
        laneGap: 20,
        scrollDurationMs: 4_000,
        maxLaneWaitMs: 5_000,
      },
    })

    engine.push(message('second'))
    clock.advanceBy(16)
    engine.push(message('wide'))
    clock.advanceBy(1_120)

    expect(renderer.positions.has('wide')).toBe(false)

    clock.advanceBy(32)
    expect(position(renderer, 'wide')).toBe(320)
    engine.destroy()
  })

  it('keeps faster followers apart until the configured overlap window', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 32 },
      policy: {
        laneGap: 20,
        scrollDurationMs: 4_000,
        scrollOverlapStartRatio: 0.8,
        maxLaneWaitMs: 5_000,
      },
    })

    engine.push(message('second'))
    clock.advanceBy(16)
    engine.push(message('wide'))
    clock.advanceBy(1_840)

    expect(renderer.positions.has('wide')).toBe(false)

    clock.advanceBy(48)
    expect(position(renderer, 'wide')).toBe(320)

    clock.advanceBy(1_696)
    expect(position(renderer, 'wide') - (position(renderer, 'second') + 100)).toBeGreaterThan(20)
    expect(position(renderer, 'wide')).toBeGreaterThan(64)

    clock.advanceBy(48)
    expect(position(renderer, 'wide') - (position(renderer, 'second') + 100)).toBeLessThan(20)
    expect(position(renderer, 'wide')).toBeLessThan(64)
    engine.destroy()
  })

  it('does not let measured lane waiters block later candidates', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const measuredBatchSizes: number[] = []
    const baseMeasure = renderer.measure.bind(renderer)
    renderer.measure = (messages): readonly DanmakuMeasurement[] => {
      measuredBatchSizes.push(messages.length)
      return baseMeasure(messages)
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 32 },
      limits: { maxMountsPerFrame: 2 },
      policy: {
        laneGap: 20,
        scrollPixelsPerSecond: 100,
        maxLaneWaitMs: 5_000,
      },
    })

    engine.push(message('leading'))
    clock.advanceBy(16)
    engine.push(message('blocker-a', 'top'))
    engine.push(message('blocker-b', 'top'))
    clock.advanceBy(16)
    clock.advanceBy(1_200)
    engine.push(message('follower'))
    clock.advanceBy(16)

    expect(renderer.frames.at(-1)?.mounts.map((item) => item.message.id)).toContain('follower')
    expect(engine.getMetrics()).toMatchObject({ pendingDepth: 2, visible: 2 })
    expect(Math.max(...measuredBatchSizes)).toBe(2)
    expect(Math.max(...renderer.frames.map((frame) => frame.mounts.length))).toBe(1)
    engine.destroy()
  })

  it('rejects overlap ratios outside the viewport', () => {
    const options = (scrollOverlapStartRatio: number) => ({
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new SizedRenderer(),
      viewport: { width: 320, height: 32 },
      policy: { scrollOverlapStartRatio },
    })

    expect(() => createDanmakuEngine(options(-0.01))).toThrow('policy.scrollOverlapStartRatio')
    expect(() => createDanmakuEngine(options(1.01))).toThrow('policy.scrollOverlapStartRatio')
  })

  it('recalculates tracks on resize and removes items outside the new viewport', () => {
    const clock = new FakeClock()
    const renderer = new SizedRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      clock,
      renderer,
      viewport: { width: 320, height: 64 },
      limits: { maxMountsPerFrame: 2 },
    })

    engine.push(message('top', 'top'))
    engine.push(message('bottom', 'bottom'))
    clock.advanceBy(16)
    engine.resize({ width: 240, height: 32 })

    expect(renderer.viewport).toEqual({ width: 240, height: 32 })
    expect(renderer.frames.at(-1)?.unmounts).toContain('bottom')
    expect(engine.getMetrics().visible).toBe(1)
  })
})
