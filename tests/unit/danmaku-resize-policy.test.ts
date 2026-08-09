import { describe, expect, it } from 'vitest'

import { createDanmakuEngine } from '../../src/danmaku/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'

interface Mount {
  readonly id: string
  readonly lane: number
  readonly y: number
}

function readPosition(positions: ReadonlyMap<string, number>, id: string): number {
  const position = positions.get(id)
  if (position === undefined) {
    throw new Error(`Missing position for ${id}.`)
  }
  return position
}

function createRecordingRenderer(height = 20): {
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
      measure: (messages) => messages.map((message) => ({ id: message.id, width: 50, height })),
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

  it('recomputes visible spans and removes collisions after lane height changes', () => {
    const clock = new FakeClock()
    const { mounts, renderer, unmounts } = createRecordingRenderer(40)
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 400, height: 80 },
      policy: { laneHeight: 40 },
    })
    const fixedMessage = (id: string) => ({
      id,
      receivedAt: 0,
      text: id,
      mode: 'top' as const,
      priority: 0,
    })

    engine.push(fixedMessage('a'))
    engine.push(fixedMessage('b'))
    clock.advanceBy(16)
    expect(mounts.map((mount) => mount.lane)).toEqual([0, 1])

    engine.resize({ width: 400, height: 80 }, { laneHeight: 20 })
    expect(unmounts).toEqual(['b'])

    engine.push(fixedMessage('c'))
    clock.advanceBy(16)
    expect(mounts.at(-1)).toMatchObject({ id: 'c', lane: 2, y: 40 })

    engine.destroy()
  })

  it('rebases every scrolling item to the new speed', () => {
    const clock = new FakeClock()
    const positions = new Map<string, number>()
    const renderer: Parameters<typeof createDanmakuEngine>[0]['renderer'] = {
      measure: (messages) =>
        messages.map((message) => ({
          id: message.id,
          width: message.id === 'wide' ? 200 : 50,
          height: 20,
        })),
      render(frame): void {
        for (const mount of frame.mounts) {
          positions.set(mount.message.id, mount.x)
        }
        for (const update of frame.updates) {
          positions.set(update.id, update.x)
        }
      },
      resize: () => {},
      setPaused: () => {},
      destroy: () => {},
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 400, height: 32 },
      policy: { laneHeight: 32, laneGap: 12, scrollPixelsPerSecond: 100 },
    })

    engine.push({ id: 'wide', receivedAt: 0, text: 'wide', mode: 'scroll', priority: 0 })
    clock.advanceBy(2_200)
    engine.push({ id: 'narrow', receivedAt: 0, text: 'narrow', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)

    engine.resize(
      { width: 800, height: 32 },
      { laneHeight: 32, laneGap: 12, scrollPixelsPerSecond: 200 },
    )
    clock.advanceBy(16)
    const wideBefore = readPosition(positions, 'wide')
    const narrowBefore = readPosition(positions, 'narrow')

    clock.advanceBy(1_000)
    const wideDistance = wideBefore - readPosition(positions, 'wide')
    const narrowDistance = narrowBefore - readPosition(positions, 'narrow')

    expect(wideDistance).toBeGreaterThan(190)
    expect(wideDistance).toBeCloseTo(narrowDistance, 6)

    engine.destroy()
  })

  it('keeps paused motion frozen and publishes resized positions', () => {
    const clock = new FakeClock()
    const positions = new Map<string, { readonly x: number; readonly y: number }>()
    const renderer: Parameters<typeof createDanmakuEngine>[0]['renderer'] = {
      measure: (messages) => messages.map((message) => ({ id: message.id, width: 50, height: 20 })),
      render(frame): void {
        for (const mount of frame.mounts) {
          positions.set(mount.message.id, { x: mount.x, y: mount.y })
        }
        for (const update of frame.updates) {
          positions.set(update.id, { x: update.x, y: update.y })
        }
      },
      resize: () => {},
      setPaused: () => {},
      destroy: () => {},
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 400, height: 96 },
      policy: { laneHeight: 32, scrollPixelsPerSecond: 100 },
    })

    engine.push({ id: 'scroll', receivedAt: 0, text: 'scroll', mode: 'scroll', priority: 0 })
    engine.push({ id: 'bottom', receivedAt: 0, text: 'bottom', mode: 'bottom', priority: 0 })
    clock.advanceBy(1_000)
    engine.pause()
    const scrollBefore = positions.get('scroll')
    if (scrollBefore === undefined) {
      throw new Error('Missing paused scroll position.')
    }

    clock.advanceBy(5_000)
    engine.resize({ width: 800, height: 160 }, { laneHeight: 16 })
    const scrollAfterResize = positions.get('scroll')
    const bottomAfterResize = positions.get('bottom')
    if (scrollAfterResize === undefined || bottomAfterResize === undefined) {
      throw new Error('Missing resized positions.')
    }
    expect(Math.abs(scrollAfterResize.x - scrollBefore.x)).toBeLessThan(3)
    expect(bottomAfterResize.y).toBe(32)

    engine.resume()
    clock.advanceBy(16)
    const scrollAfterResume = positions.get('scroll')
    if (scrollAfterResume === undefined) {
      throw new Error('Missing resumed scroll position.')
    }
    expect(scrollBefore.x - scrollAfterResume.x).toBeGreaterThan(0)
    expect(scrollBefore.x - scrollAfterResume.x).toBeLessThan(5)

    engine.destroy()
  })
})
