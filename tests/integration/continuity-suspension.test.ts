import { describe, expect, it } from 'vitest'

import { createContinuityController } from '../../src/continuity/index.js'
import type { PageActivitySource } from '../../src/continuity/index.js'
import { CONTRACT_VERSION, LiveFlowError, SourceTransitionError } from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

const SOURCE = { url: 'https://media.example/live.flv', kind: 'flv' }

function namedError(name: string): Error {
  const error = new Error(`${name} raised by the browser`)
  error.name = name
  return error
}

function foreignLiveFlowError(code: string): LiveFlowError {
  const error = new LiveFlowError(code, 'Sanitized adapter rejection.')
  Object.setPrototypeOf(error, Error.prototype)
  return error
}

class FakePageActivity implements PageActivitySource {
  private hidden = true
  private readonly listeners = new Set<(hidden: boolean) => void>()
  private visibilityError: Error | null = null
  private subscribeHook: (() => void) | null = null
  private unsubscribeFailures = 0

  isHidden(): boolean {
    if (this.visibilityError !== null) {
      const error = this.visibilityError
      this.visibilityError = null
      throw error
    }
    return this.hidden
  }

  subscribe(listener: (hidden: boolean) => void): () => void {
    this.listeners.add(listener)
    const subscribeHook = this.subscribeHook
    this.subscribeHook = null
    subscribeHook?.()
    return () => {
      if (this.unsubscribeFailures > 0) {
        this.unsubscribeFailures -= 1
        throw new Error('Synthetic page activity unsubscribe failure.')
      }
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

  failNextVisibilityCheck(error: Error): void {
    this.visibilityError = error
  }

  failNextUnsubscribe(): void {
    this.unsubscribeFailures += 1
  }

  onNextSubscribe(callback: () => void): void {
    this.subscribeHook = callback
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

  it.each([
    ['media-play-browser-suspended', 'browser-suspended'],
    ['media-play-autoplay-blocked', 'autoplay-blocked'],
  ] as const)('recognizes the adapter rejection code %s', async (code, reason) => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(foreignLiveFlowError(code))

    await controller.setSource(SOURCE)

    expect(controller.getSnapshot().suspension?.reason).toBe(reason)

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

  it('treats a hostile error name getter as unknown', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    const failure = new Error('Safe outer message.')
    let reads = 0
    Object.defineProperty(failure, 'name', {
      get(): string {
        reads += 1
        throw new Error('https://media.example/live.flv?token=secret')
      },
    })
    adapter.failNextPlay(failure)

    const thrown = await controller.setSource(SOURCE).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SourceTransitionError)
    expect(thrown).toMatchObject({ reason: 'unknown' })
    expect(JSON.stringify(thrown)).not.toContain('secret')
    expect(reads).toBe(1)

    await controller.destroy()
  })

  it('redacts an unrecognized alphabetic error name', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    const secret = 'PrivateCredential'
    adapter.failNextPlay(namedError(secret))

    const thrown = await controller.setSource(SOURCE).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SourceTransitionError)
    expect(thrown).toMatchObject({ reason: 'unknown' })
    expect(JSON.stringify(thrown)).not.toContain(secret)

    await controller.destroy()
  })

  it('rolls back a page activity subscription when visibility cannot be read', async () => {
    const adapter = new FakePlayerAdapter()
    const pageActivity = new FakePageActivity()
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      pageActivity,
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })
    pageActivity.failNextVisibilityCheck(new Error('Synthetic visibility failure.'))
    adapter.failNextPlay(namedError('AbortError'))

    await controller.setSource(SOURCE)

    expect(controller.getSnapshot().state).toBe('suspended')
    expect(pageActivity.listenerCount).toBe(0)
    expect(diagnostics).toContain('page-activity-subscribe-failed')

    await controller.resume()
    adapter.emit({ type: 'first-frame', generation: 1 })
    expect(controller.getSnapshot()).toMatchObject({ state: 'playing', suspension: null })

    await controller.destroy()
  })

  it('retries page activity cleanup after destroy rejects', async () => {
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
    pageActivity.failNextUnsubscribe()

    const firstDestroy = await controller.destroy().catch((error: unknown) => error)

    expect(firstDestroy).toBeInstanceOf(LiveFlowError)
    expect(firstDestroy).toMatchObject({ code: 'controller-cleanup-failed' })
    expect(pageActivity.listenerCount).toBe(1)

    await controller.destroy()
    expect(pageActivity.listenerCount).toBe(0)
    expect(adapter.destroyCallCount()).toBe(2)
  })

  it('keeps a failed suspension cleanup owned while advancing the source', async () => {
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
    pageActivity.failNextUnsubscribe()

    await controller.setSource(SOURCE)

    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 2,
      suspension: null,
    })
    expect(pageActivity.listenerCount).toBe(1)

    await controller.destroy()
    expect(pageActivity.listenerCount).toBe(0)
  })

  it('accepts a first frame when page activity cleanup fails once', async () => {
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
    pageActivity.failNextUnsubscribe()

    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'playing', generation: 1 })

    expect(controller.getSnapshot()).toMatchObject({ state: 'playing', suspension: null })
    expect(pageActivity.listenerCount).toBe(1)

    await controller.destroy()
    expect(pageActivity.listenerCount).toBe(0)
  })

  it('ignores a browser rejection that arrives after the source timeout', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const pageActivity = new FakePageActivity()
    const playStarted = adapter.deferPlaybackStart()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      pageActivity,
      policy: { sourceWarmupTimeoutMs: 1_000 },
      onRecoveryRequest: () => {},
    })

    const sourceChange = controller.setSource(SOURCE)
    await playStarted
    clock.advanceBy(1_000)
    adapter.rejectPlaybackStart(namedError('AbortError'))
    await sourceChange

    expect(controller.getSnapshot()).toMatchObject({ state: 'recovering', suspension: null })
    expect(pageActivity.listenerCount).toBe(0)

    await controller.destroy()
  })

  it('does not watch page activity after a suspension listener replaces the source', async () => {
    const adapter = new FakePlayerAdapter()
    const pageActivity = new FakePageActivity()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      pageActivity,
    })
    const replacements: Promise<void>[] = []
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'suspended') {
        replacements.push(
          controller.setSource({ url: 'https://media.example/replacement.flv', kind: 'flv' }),
        )
      }
    })
    adapter.failNextPlay(namedError('AbortError'))

    await controller.setSource(SOURCE)
    await Promise.all(replacements)

    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 2,
      suspension: null,
    })
    expect(pageActivity.listenerCount).toBe(0)

    await controller.destroy()
  })

  it('releases a page activity subscription that synchronously replaces the source', async () => {
    const adapter = new FakePlayerAdapter()
    const pageActivity = new FakePageActivity()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      pageActivity,
    })
    const replacements: Promise<void>[] = []
    pageActivity.onNextSubscribe(() => {
      replacements.push(
        controller.setSource({
          url: 'https://media.example/replacement.flv',
          kind: 'flv',
        }),
      )
    })
    adapter.failNextPlay(namedError('AbortError'))

    await controller.setSource(SOURCE)
    await Promise.all(replacements)

    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 2,
      suspension: null,
    })
    expect(pageActivity.listenerCount).toBe(0)

    await controller.destroy()
  })

  it('does not let cleanup diagnostics restore an older generation', async () => {
    const adapter = new FakePlayerAdapter()
    const pageActivity = new FakePageActivity()
    const replacements: Promise<void>[] = []
    const controllerReference: {
      current: ReturnType<typeof createContinuityController> | null
    } = { current: null }
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      pageActivity,
      onDiagnostic: (diagnostic) => {
        const currentController = controllerReference.current
        if (diagnostic.code === 'page-activity-unsubscribe-failed' && currentController !== null) {
          replacements.push(
            currentController.setSource({
              url: 'https://media.example/replacement.flv',
              kind: 'flv',
            }),
          )
        }
      },
    })
    controllerReference.current = controller
    adapter.failNextPlay(namedError('AbortError'))
    await controller.setSource(SOURCE)
    pageActivity.failNextUnsubscribe()

    adapter.emit({ type: 'first-frame', generation: 1 })
    await Promise.all(replacements)

    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 2,
      suspension: null,
    })
    expect(pageActivity.listenerCount).toBe(0)

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

    expect(controller.getSnapshot()).toMatchObject({
      state: 'suspended',
      healthySince: null,
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
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

    expect(controller.getSnapshot()).toMatchObject({
      state: 'suspended',
      healthySince: null,
    })
    adapter.emit({ type: 'playing', generation: 1 })
    expect(controller.getSnapshot().state).toBe('suspended')
    adapter.emit({ type: 'first-frame', generation: 1 })
    expect(controller.getSnapshot()).toMatchObject({ state: 'playing', suspension: null })

    await controller.destroy()
  })

  it('retries immediately when page activity is already visible', async () => {
    const adapter = new FakePlayerAdapter()
    const pageActivity = new FakePageActivity()
    const retryStarted = adapter.deferPlaybackStart()
    pageActivity.reveal()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      pageActivity,
    })
    adapter.failNextPlay(namedError('AbortError'))

    await controller.setSource(SOURCE)
    await retryStarted
    adapter.resolvePlaybackStart()
    await Promise.resolve()

    expect(controller.getSnapshot().state).toBe('suspended')
    adapter.emit({ type: 'first-frame', generation: 1 })
    expect(controller.getSnapshot().state).toBe('playing')

    await controller.destroy()
  })

  it('rejects a non-browser resume failure without leaking its message', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(namedError('NotAllowedError'))
    await controller.setSource(SOURCE)
    const failure = namedError('NotSupportedError')
    failure.message = 'https://media.example/live.flv?token=secret rejected'
    adapter.failNextPlay(failure)

    const thrown = await controller.resume().catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SourceTransitionError)
    expect(thrown).toMatchObject({ phase: 'play', generation: 1, reason: 'NotSupportedError' })
    expect(JSON.stringify(thrown)).not.toContain('secret')
    expect(controller.getSnapshot().state).toBe('suspended')

    await controller.destroy()
  })

  it('recovers explicitly when an automatic resume hits a media failure', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const pageActivity = new FakePageActivity()
    const diagnostics: string[] = []
    const recoveries: string[] = []
    let resolveFailure = (): void => {}
    const failureObserved = new Promise<void>((resolve) => {
      resolveFailure = resolve
    })
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      pageActivity,
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
        if (event.code === 'playback-resume-failed') {
          resolveFailure()
        }
      },
      onRecoveryRequest: (request) => {
        recoveries.push(request.reason)
      },
    })
    adapter.failNextPlay(namedError('AbortError'))
    await controller.setSource(SOURCE)
    adapter.failNextPlay(namedError('NotSupportedError'))

    pageActivity.reveal()
    await failureObserved

    expect(controller.getSnapshot()).toMatchObject({ state: 'degraded', suspension: null })
    expect(diagnostics).toContain('playback-resume-failed')
    clock.advanceBy(0)
    expect(recoveries).toEqual(['playback-error'])

    await controller.destroy()
  })

  it('keeps an old resume promise from clearing a newer suspension', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(namedError('NotAllowedError'))
    await controller.setSource(SOURCE)
    const oldResumeStarted = adapter.deferPlaybackStart()
    const oldResume = controller.resume()
    await oldResumeStarted
    adapter.failNextPlay(namedError('NotAllowedError'))

    await controller.setSource({ url: 'https://media.example/new.flv', kind: 'flv' })
    adapter.resolvePlaybackStart()
    await oldResume

    expect(controller.getSnapshot()).toMatchObject({
      state: 'suspended',
      generation: 2,
      suspension: { reason: 'autoplay-blocked', generation: 2 },
    })

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
