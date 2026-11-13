import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSION, type DiagnosticEvent } from '../../src/index.js'
import {
  createDanmakuEngine,
  InvalidDanmakuMessageError,
  type DanmakuEngine,
  type DanmakuEngineOptions,
  type DanmakuMeasurement,
  type DanmakuMessage,
  type DanmakuPolicy,
  type DanmakuRenderFrame,
  type DanmakuRenderPosition,
  type DanmakuRenderer,
} from '../../src/danmaku/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'

const SETTLE_MS = 320

class StackRenderer implements DanmakuRenderer {
  readonly frames: DanmakuRenderFrame[] = []
  readonly heights = new Map<string, number>()

  measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[] {
    return messages.map((message) => ({
      id: message.id,
      width: 100,
      height: this.heights.get(message.id) ?? 20,
    }))
  }

  render(frame: DanmakuRenderFrame): void {
    this.frames.push(frame)
  }

  resize(): void {}

  setPaused(): void {}

  destroy(): void {}

  rows(): Map<string, DanmakuRenderPosition> {
    const rows = new Map<string, DanmakuRenderPosition>()
    for (const frame of this.frames) {
      for (const id of frame.unmounts) rows.delete(id)
      for (const item of frame.mounts) {
        rows.set(item.message.id, { id: item.message.id, x: item.x, y: item.y })
      }
      for (const update of frame.updates) rows.set(update.id, update)
    }
    return rows
  }

  unmounted(): string[] {
    return this.frames.flatMap((frame) => frame.unmounts)
  }
}

interface StackFixture {
  readonly clock: FakeClock
  readonly renderer: StackRenderer
  readonly engine: DanmakuEngine
  show(id: string): void
}

function message(id: string): DanmakuMessage {
  return { id, receivedAt: 0, text: `message ${id}`, mode: 'scroll', priority: 0 }
}

function createStack(
  height: number,
  policy: Partial<DanmakuPolicy> = {},
  options: Partial<DanmakuEngineOptions> = {},
): StackFixture {
  const clock = new FakeClock()
  const renderer = new StackRenderer()
  const engine = createDanmakuEngine({
    contractVersion: CONTRACT_VERSION,
    clock,
    renderer,
    layout: 'stack',
    viewport: { width: 200, height },
    policy: { stackGap: 4, stackGlideMs: 300, ...policy },
    ...options,
  })
  return {
    clock,
    renderer,
    engine,
    show(id: string): void {
      engine.push(message(id))
      clock.advanceBy(SETTLE_MS)
    },
  }
}

describe('danmaku stack layout', () => {
  it('slides a new row in from the bottom edge and glides older rows up', () => {
    const { clock, renderer, engine } = createStack(100)

    engine.push(message('a'))
    clock.advanceBy(16)
    expect(renderer.rows().get('a')).toEqual({ id: 'a', x: 0, y: 100, restY: 80 })

    clock.advanceBy(SETTLE_MS)
    expect(renderer.rows().get('a')).toEqual({ id: 'a', x: 0, y: 80, restY: 80 })
    expect(clock.pendingTaskCount()).toBe(0)

    engine.push(message('b'))
    clock.advanceBy(16)
    expect(renderer.rows().get('a')).toEqual({ id: 'a', x: 0, y: 80, restY: 56 })
    expect(renderer.rows().get('b')).toEqual({ id: 'b', x: 0, y: 104, restY: 80 })

    clock.advanceBy(144)
    const gliding = renderer.rows().get('a')?.y ?? 0
    expect(gliding).toBeGreaterThan(56)
    expect(gliding).toBeLessThan(80)

    clock.advanceBy(SETTLE_MS)
    expect(renderer.rows().get('a')?.y).toBe(56)
    expect(renderer.rows().get('b')?.y).toBe(80)
    expect(engine.getMetrics()).toMatchObject({ visible: 2, displayed: 2, dropped: 0 })
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('places rows at their rest position when the glide is disabled', () => {
    const { clock, renderer, engine } = createStack(100, { stackGlideMs: 0 })

    engine.push(message('a'))
    clock.advanceBy(16)

    expect(renderer.rows().get('a')).toEqual({ id: 'a', x: 0, y: 80, restY: 80 })
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('unmounts a row only after it has left the top edge', () => {
    const { renderer, engine, show } = createStack(50)

    show('a')
    show('b')
    show('c')
    expect(renderer.unmounted()).toEqual([])
    expect(renderer.rows().get('a')?.restY).toBe(-18)

    show('d')
    expect(renderer.unmounted()).toEqual(['a'])
    expect([...renderer.rows().keys()]).toEqual(['b', 'c', 'd'])
    expect(renderer.rows().get('b')?.y).toBe(-18)
    expect(engine.getMetrics().visible).toBe(3)
  })

  it('evicts the oldest row instead of stalling at visible capacity', () => {
    const { clock, renderer, engine } = createStack(
      500,
      {},
      { limits: { maxVisible: 2, maxPoolSize: 2 } },
    )

    engine.push(message('a'))
    engine.push(message('b'))
    engine.push(message('c'))
    clock.advanceBy(SETTLE_MS * 2)

    expect(renderer.unmounted()).toEqual(['a'])
    expect([...renderer.rows().keys()]).toEqual(['b', 'c'])
    expect(renderer.rows().get('b')?.y).toBe(456)
    expect(renderer.rows().get('c')?.y).toBe(480)
    for (const frame of renderer.frames) {
      const mounted = new Set(frame.mounts.map((item) => item.message.id))
      expect(frame.unmounts.filter((id) => mounted.has(id))).toEqual([])
    }
    expect(engine.getMetrics()).toMatchObject({ visible: 2, displayed: 3, dropped: 0 })
  })

  it('fills from the top and hugs the right edge for a top-right anchor', () => {
    const { clock, renderer, engine, show } = createStack(100, { stackAnchor: 'top-right' })

    engine.push(message('a'))
    clock.advanceBy(16)
    expect(renderer.rows().get('a')).toEqual({ id: 'a', x: 100, y: 0, restY: 0 })
    expect(clock.pendingTaskCount()).toBe(0)

    show('b')
    show('c')
    show('d')
    expect(renderer.rows().get('d')?.y).toBe(72)

    engine.push(message('e'))
    clock.advanceBy(16)
    expect(renderer.rows().get('e')).toEqual({ id: 'e', x: 100, y: 96, restY: 80 })
    clock.advanceBy(SETTLE_MS)
    expect(renderer.rows().get('a')?.y).toBe(-16)
    expect(renderer.rows().get('e')?.y).toBe(80)

    show('f')
    expect(renderer.unmounted()).toEqual(['a'])
    expect(renderer.rows().get('b')?.y).toBe(-16)
    expect(renderer.rows().get('f')?.y).toBe(80)
  })

  it('does not consume the glide while paused', () => {
    const { clock, renderer, engine, show } = createStack(100)

    show('a')
    engine.push(message('b'))
    clock.advanceBy(16)
    engine.pause()
    clock.advanceBy(1_000)
    engine.resume()
    clock.advanceBy(16)

    expect(renderer.rows().get('b')?.y).toBeGreaterThan(100)

    clock.advanceBy(SETTLE_MS)
    expect(renderer.rows().get('b')?.y).toBe(80)
  })

  it('follows a resized viewport and applies a new gap to later rows', () => {
    const { renderer, engine, show } = createStack(100)

    show('a')
    show('b')
    engine.resize({ width: 200, height: 60 })
    expect(renderer.rows().get('a')?.y).toBe(16)
    expect(renderer.rows().get('b')?.y).toBe(40)

    engine.resize({ width: 200, height: 60 }, { stackGap: 10 })
    expect(renderer.rows().get('a')?.y).toBe(16)
    expect(renderer.rows().get('b')?.y).toBe(40)

    show('c')
    expect(renderer.rows().get('b')?.y).toBe(10)
    expect(renderer.rows().get('c')?.y).toBe(40)
    expect(engine.getMetrics()).toMatchObject({ visible: 3, dropped: 0 })
  })

  it('uses measured heights for wrapped rows', () => {
    const { renderer, show } = createStack(100)

    renderer.heights.set('tall', 44)
    show('a')
    show('tall')
    show('b')

    expect(renderer.rows().get('a')?.y).toBe(8)
    expect(renderer.rows().get('tall')?.y).toBe(32)
    expect(renderer.rows().get('b')?.y).toBe(80)
  })

  it('rejects an unknown layout and invalid stack policy values', () => {
    const base: DanmakuEngineOptions = {
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      renderer: new StackRenderer(),
      viewport: { width: 200, height: 100 },
    }
    const unknownLayout = { ...base }
    Reflect.set(unknownLayout, 'layout', 'grid')
    const unknownAnchor: Partial<DanmakuPolicy> = {}
    Reflect.set(unknownAnchor, 'stackAnchor', 'center')

    expect(() => createDanmakuEngine(unknownLayout)).toThrow('layout')
    expect(() => createDanmakuEngine({ ...base, policy: unknownAnchor })).toThrow(
      'policy.stackAnchor',
    )
    expect(() => createDanmakuEngine({ ...base, policy: { stackGap: -1 } })).toThrow(
      'policy.stackGap',
    )
    expect(() => createDanmakuEngine({ ...base, policy: { stackGlideMs: Number.NaN } })).toThrow(
      'policy.stackGlideMs',
    )
  })
})

describe('danmaku sender fields', () => {
  it('keeps a normalized sender colour and avatar key', () => {
    const { clock, renderer, engine } = createStack(100)

    engine.push({
      ...message('a'),
      sender: { displayName: 'viewer', color: '#ABC', avatarKey: 'avatar:1' },
    })
    clock.advanceBy(16)

    expect(renderer.frames[0]?.mounts[0]?.message.sender).toEqual({
      displayName: 'viewer',
      color: '#aabbcc',
      avatarKey: 'avatar:1',
    })
  })

  it('discards an unsupported sender colour with a diagnostic', () => {
    const diagnostics: DiagnosticEvent[] = []
    const { clock, renderer, engine } = createStack(
      100,
      {},
      {
        onDiagnostic: (event): void => {
          diagnostics.push(event)
        },
      },
    )

    engine.push({ ...message('a'), sender: { displayName: 'viewer', color: 'red' } })
    clock.advanceBy(16)

    expect(renderer.frames[0]?.mounts[0]?.message.sender).toEqual({ displayName: 'viewer' })
    expect(diagnostics.map((event) => event.code)).toEqual(['color-discarded'])
  })

  it('rejects an oversized avatar key', () => {
    const { engine } = createStack(100)

    expect(() => engine.push({ ...message('a'), sender: { avatarKey: 'k'.repeat(161) } })).toThrow(
      InvalidDanmakuMessageError,
    )
  })
})
