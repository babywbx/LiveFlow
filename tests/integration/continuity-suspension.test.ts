import { describe, expect, it } from 'vitest'

import { createContinuityController } from '../../src/continuity/index.js'
import type { PageActivitySource } from '../../src/continuity/index.js'
import { CONTRACT_VERSION, SourceTransitionError } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

const SOURCE = { url: 'https://media.example/live.flv', kind: 'flv' }

function namedError(name: string): Error {
  const error = new Error(`${name} raised by the browser`)
  error.name = name
  return error
}

class FakePageActivity implements PageActivitySource {
  private hidden = true
  private readonly listeners = new Set<(hidden: boolean) => void>()

  isHidden(): boolean {
    return this.hidden
  }

  subscribe(listener: (hidden: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  reveal(): void {
    this.hidden = false
    for (const listener of this.listeners) listener(false)
  }
}

describe('continuity suspension', () => {
  it('treats a power-save abort as suspension rather than a source failure', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(namedError('AbortError'))

    await controller.setSource(SOURCE)

    expect(controller.getSnapshot()).toMatchObject({
      state: 'suspended',
      suspension: { reason: 'browser-suspended', generation: 1 },
    })

    await controller.destroy()
  })

  it('reports a blocked autoplay separately so the caller can ask for a gesture', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(namedError('NotAllowedError'))

    await controller.setSource(SOURCE)

    expect(controller.getSnapshot().suspension?.reason).toBe('autoplay-blocked')

    await controller.destroy()
  })

  it('still fails loudly when playback breaks for any other reason', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    const cause = namedError('NotSupportedError')
    adapter.failNextPlay(cause)

    await expect(controller.setSource(SOURCE)).rejects.toThrow(SourceTransitionError)
    expect(controller.getSnapshot().state).not.toBe('suspended')

    await controller.destroy()
  })

  it('carries the browser error name without leaking its message', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    const failure = namedError('NotSupportedError')
    failure.message = 'https://media.example/live.flv?token=secret rejected'
    adapter.failNextPlay(failure)

    const thrown = await controller.setSource(SOURCE).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(SourceTransitionError)
    expect(thrown).toMatchObject({ reason: 'NotSupportedError' })
    expect(thrown).not.toHaveProperty('cause')
    expect(JSON.stringify(thrown instanceof Error ? thrown.message : '')).not.toContain('secret')

    await controller.destroy()
  })

  it('resumes playback by itself once the page becomes visible again', async () => {
    const adapter = new FakePlayerAdapter()
    const pageActivity = new FakePageActivity()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      pageActivity,
    })
    adapter.failNextPlay(namedError('AbortError'))

    await controller.setSource(SOURCE)
    expect(controller.getSnapshot().state).toBe('suspended')
    expect(pageActivity.listenerCount).toBe(1)

    pageActivity.reveal()
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getSnapshot()).toMatchObject({ state: 'playing', suspension: null })
    expect(pageActivity.listenerCount).toBe(0)

    await controller.destroy()
  })

  it('resumes on an explicit caller gesture without a page activity source', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(namedError('NotAllowedError'))

    await controller.setSource(SOURCE)
    expect(controller.getSnapshot().state).toBe('suspended')

    await controller.resume()

    expect(controller.getSnapshot()).toMatchObject({ state: 'playing', suspension: null })

    await controller.destroy()
  })
})

describe('playback health', () => {
  it('stamps a healthy streak only while playback is actually playing', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
    })

    await controller.setSource(SOURCE)
    expect(controller.getSnapshot().healthySince).toBeNull()

    clock.advanceBy(1_000)
    adapter.emit({ type: 'first-frame', generation: 1 })
    const healthySince = controller.getSnapshot().healthySince
    expect(healthySince).toBe(clock.now())

    adapter.emit({ type: 'stalled', generation: 1 })
    expect(controller.getSnapshot().healthySince).toBeNull()

    await controller.destroy()
  })
})
