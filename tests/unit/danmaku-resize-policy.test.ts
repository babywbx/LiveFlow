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

  it('keeps same-lane scrolling messages after their spacing changes', () => {
    const clock = new FakeClock()
    const unmounts: string[] = []
    const renderer: Parameters<typeof createDanmakuEngine>[0]['renderer'] = {
      measure: (messages) =>
        messages.map((message) => ({
          id: message.id,
          width: message.id === 'trailing' ? 200 : 50,
          height: 20,
        })),
      render(frame): void {
        unmounts.push(...frame.unmounts)
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
      policy: { laneHeight: 32, laneGap: 12, scrollDurationMs: 4_000 },
    })

    engine.push({ id: 'leading', receivedAt: 0, text: 'leading', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)
    engine.push({ id: 'trailing', receivedAt: 0, text: 'trailing', mode: 'scroll', priority: 0 })
    clock.advanceBy(1_600)

    expect(engine.getMetrics().visible).toBe(2)
    engine.resize({ width: 400, height: 32 })
    expect(engine.getMetrics().visible).toBe(2)
    expect(unmounts).toEqual([])

    engine.destroy()
  })

  it('preserves the overlap guard when the viewport shrinks', () => {
    const clock = new FakeClock()
    const positions = new Map<string, number>()
    const unmounts: string[] = []
    const renderer: Parameters<typeof createDanmakuEngine>[0]['renderer'] = {
      measure: (messages) =>
        messages.map((message) => ({
          id: message.id,
          width: message.id === 'trailing' ? 280 : 100,
          height: 20,
        })),
      render(frame): void {
        for (const mount of frame.mounts) positions.set(mount.message.id, mount.x)
        for (const update of frame.updates) positions.set(update.id, update.x)
        unmounts.push(...frame.unmounts)
      },
      resize: () => {},
      setPaused: () => {},
      destroy: () => {},
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 2_560, height: 32 },
      policy: {
        laneHeight: 32,
        laneGap: 20,
        scrollDurationMs: 4_000,
        scrollOverlapStartRatio: 0.82,
      },
    })

    engine.push({ id: 'leading', receivedAt: 0, text: 'leading', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)
    engine.push({ id: 'trailing', receivedAt: 0, text: 'trailing', mode: 'scroll', priority: 0 })
    clock.advanceBy(400)
    expect(engine.getMetrics().visible).toBe(2)

    engine.resize({ width: 400, height: 32 }, { scrollOverlapStartRatio: 0.65 })
    const leadingX = readPosition(positions, 'leading')
    const trailingX = readPosition(positions, 'trailing')
    const leadingSpeed = 500 / 4_000
    const trailingSpeed = 680 / 4_000
    const guardX = 400 * (1 - 0.65)
    const gapAtGuard =
      trailingX -
      (leadingX + 100) -
      ((trailingX - guardX) * (trailingSpeed - leadingSpeed)) / trailingSpeed

    expect(engine.getMetrics().visible).toBe(2)
    expect(unmounts).toEqual([])
    expect(gapAtGuard).toBeGreaterThanOrEqual(20 - Number.EPSILON)
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

  it('keeps scrolling progress through viewport size changes', () => {
    const clock = new FakeClock()
    const positions = new Map<string, number>()
    const renderer: Parameters<typeof createDanmakuEngine>[0]['renderer'] = {
      measure: (messages) => messages.map((message) => ({ id: message.id, width: 50, height: 20 })),
      render(frame): void {
        for (const mount of frame.mounts) positions.set(mount.message.id, mount.x)
        for (const update of frame.updates) positions.set(update.id, update.x)
      },
      resize: () => {},
      setPaused: () => {},
      destroy: () => {},
    }
    const engine = createDanmakuEngine({
      contractVersion: CONTRACT_VERSION,
      renderer,
      clock,
      viewport: { width: 600, height: 32 },
      policy: { laneHeight: 32, scrollDurationMs: 8_000 },
    })

    engine.push({ id: 'a', receivedAt: 0, text: 'a', mode: 'scroll', priority: 0 })
    clock.advanceBy(2_992)
    const before = readPosition(positions, 'a')
    const progressBefore = (600 - before) / 650

    for (const [width, duration] of [
      [800, 9_000],
      [1_200, 11_000],
      [2_000, 17_000],
      [400, 8_000],
    ] as const) {
      engine.resize({ width, height: 32 }, { scrollDurationMs: duration })
      const after = readPosition(positions, 'a')
      const progressAfter = (width - after) / (width + 50)
      expect(progressAfter).toBeCloseTo(progressBefore, 6)
    }
    engine.destroy()
  })

  it('keeps duration jitter stable through resize and can return to pixels per second', () => {
    const clock = new FakeClock()
    const positions = new Map<string, number>()
    const renderer: Parameters<typeof createDanmakuEngine>[0]['renderer'] = {
      measure: (messages) => messages.map((message) => ({ id: message.id, width: 50, height: 20 })),
      render(frame): void {
        for (const mount of frame.mounts) positions.set(mount.message.id, mount.x)
        for (const update of frame.updates) positions.set(update.id, update.x)
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
      policy: { scrollDurationMs: 4_000, scrollDurationJitterMs: 1_000 },
    })

    engine.push({ id: 'a', receivedAt: 0, text: 'a', mode: 'scroll', priority: 0 })
    clock.advanceBy(16)
    const firstStart = readPosition(positions, 'a')
    clock.advanceBy(512)
    const firstDistance = firstStart - readPosition(positions, 'a')

    engine.resize({ width: 400, height: 32 }, { laneGap: 8 })
    const secondStart = readPosition(positions, 'a')
    clock.advanceBy(512)
    const secondDistance = secondStart - readPosition(positions, 'a')

    expect(secondDistance).toBeCloseTo(firstDistance, 6)

    engine.resize(
      { width: 400, height: 32 },
      { scrollDurationMs: null, scrollDurationJitterMs: null, scrollPixelsPerSecond: 100 },
    )
    const before = readPosition(positions, 'a')
    clock.advanceBy(1_008)

    expect(before - readPosition(positions, 'a')).toBeCloseTo(100.8, 6)
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
    clock.advanceBy(1_008)
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
    expect(scrollAfterResize.x - scrollAfterResume.x).toBeGreaterThan(0)
    expect(scrollAfterResize.x - scrollAfterResume.x).toBeLessThan(5)

    engine.destroy()
  })
})
