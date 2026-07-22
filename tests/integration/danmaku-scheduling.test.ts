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
