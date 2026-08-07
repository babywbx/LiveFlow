import { describe, expect, it } from 'vitest'

import { createDanmakuEngine } from '../../src/danmaku/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'

interface Mount {
  readonly id: string
  readonly lane: number
  readonly y: number
}

function createRecordingRenderer(): {
  mounts: Mount[]
  unmounts: string[]
  renderer: Parameters<typeof createDanmakuEngine>[0]['renderer']
} {
  const mounts: Mount[] = []
  const unmounts: string[] = []
  return {
    mounts,
    unmounts,
    renderer: {
      measure: (messages) => messages.map((message) => ({ id: message.id, width: 50, height: 20 })),
      render(frame): void {
        for (const item of frame.mounts) {
          mounts.push({ id: item.message.id, lane: item.lane, y: item.y })
        }
        unmounts.push(...frame.unmounts)
      },
      resize: () => {},
      setPaused: () => {},
      destroy: () => {},
    },
  }
}

describe('danmaku engine resize policy', () => {
  it('re-spaces lanes when resize carries a new lane height', () => {
    const clock = new FakeClock()
    const { mounts, renderer } = createRecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 400, height: 300 },
      policy: { laneHeight: 30, laneGap: 4 },
    })

    engine.push({ id: 'a', receivedAt: 0, text: 'a', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)
    const before = mounts.at(-1)
    expect(before).toBeDefined()

    engine.resize({ width: 400, height: 300 }, { laneHeight: 60 })
    engine.push({ id: 'b', receivedAt: 0, text: 'b', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)

    const after = mounts.at(-1)
    expect(after?.id).toBe('b')
    expect(after?.y).toBe((after?.lane ?? 0) * 60)

    engine.destroy()
  })

  it('rejects a lane height that is not a positive number', () => {
    const { renderer } = createRecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock: new FakeClock(),
      viewport: { width: 400, height: 300 },
    })

    expect(() => engine.resize({ width: 400, height: 300 }, { laneHeight: 0 })).toThrow()

    engine.destroy()
  })

  it('keeps the previous policy when resize omits one', () => {
    const clock = new FakeClock()
    const { mounts, renderer } = createRecordingRenderer()
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 400, height: 300 },
      policy: { laneHeight: 40 },
    })

    engine.resize({ width: 400, height: 200 })
    engine.push({ id: 'a', receivedAt: 0, text: 'a', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)

    const mounted = mounts.at(-1)
    expect(mounted?.y).toBe((mounted?.lane ?? 0) * 40)

    engine.destroy()
  })
})
