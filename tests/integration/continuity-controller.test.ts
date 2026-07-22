import { describe, expect, it } from 'vitest'

import { createContinuityController } from '../../src/continuity/index.js'
import {
  CONTRACT_VERSION,
  CapacityExceededError,
  ContractVersionMismatchError,
  PreparedSourceGenerationMismatchError,
  SourceTransitionError,
} from '../../src/index.js'
import { FakeClock } from '../fixtures/fake-clock.js'
import { FakePlayerAdapter } from '../fixtures/fake-player-adapter.js'

describe('continuity controller', () => {
  it('keeps a source warming until its first frame is visible', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })

    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 1,
    })

    adapter.emit({ type: 'first-frame', generation: 1 })

    expect(controller.getSnapshot()).toMatchObject({
      state: 'playing',
      generation: 1,
    })

    await controller.destroy()
  })

  it('uses a gentle playback rate only while the live edge is too far away', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        targetLatencySeconds: 2,
        softCatchupThresholdSeconds: 0.6,
        catchupRate: 1.04,
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 12,
      bufferedAheadSeconds: 3,
      liveEdgeDistanceSeconds: 3,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    clock.advanceBy(500)

    expect(adapter.playbackRate()).toBe(1.04)

    adapter.setMetrics({
      currentTimeSeconds: 13,
      bufferedAheadSeconds: 2,
      liveEdgeDistanceSeconds: 2,
      playbackRate: 1.04,
      stalledSince: null,
      droppedFrames: null,
    })

    clock.advanceBy(500)

    expect(adapter.playbackRate()).toBe(1.04)

    clock.advanceBy(500)

    expect(adapter.playbackRate()).toBe(1)

    await controller.destroy()
  })

  it('stops catchup immediately when forward buffer becomes unsafe', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 5,
      bufferedAheadSeconds: 3,
      liveEdgeDistanceSeconds: 3,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })
    clock.advanceBy(500)
    expect(adapter.playbackRate()).toBe(1.04)

    adapter.setMetrics({
      currentTimeSeconds: 6,
      bufferedAheadSeconds: 0,
      liveEdgeDistanceSeconds: 3,
      playbackRate: 1.04,
      stalledSince: null,
      droppedFrames: null,
    })
    clock.advanceBy(500)

    expect(adapter.playbackRate()).toBe(1)

    await controller.destroy()
  })

  it('debounces stalls and bounds automatic recovery requests', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const recoveryAttempts: number[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        recoveryCooldownMs: 1_000,
        maxAutomaticRecoveries: 2,
      },
      onRecoveryRequest: (request) => {
        recoveryAttempts.push(request.attempt)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })

    expect(controller.getSnapshot().state).toBe('degraded')

    clock.advanceBy(399)
    expect(recoveryAttempts).toEqual([])

    clock.advanceBy(1)
    expect(recoveryAttempts).toEqual([1])
    expect(controller.getSnapshot()).toMatchObject({
      state: 'recovering',
      automaticRecoveryCount: 1,
    })

    adapter.emit({ type: 'playing', generation: 1 })
    adapter.emit({ type: 'stalled', generation: 1 })
    clock.advanceBy(1_000)

    expect(recoveryAttempts).toEqual([1, 2])

    adapter.emit({ type: 'playing', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(1_000)

    expect(recoveryAttempts).toEqual([1, 2])
    expect(controller.getSnapshot()).toMatchObject({
      state: 'waiting-reopen',
      automaticRecoveryCount: 2,
    })

    await controller.destroy()
  })

  it('preserves the recovery limit across replacement source generations', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const attempts: number[] = []
    const sourceChanges: Promise<void>[] = []
    let controller: ReturnType<typeof createContinuityController> | null = null

    controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        maxAutomaticRecoveries: 2,
        recoveryCooldownMs: 1,
        sourceWarmupTimeoutMs: 1_000,
      },
      onRecoveryRequest: (request) => {
        attempts.push(request.attempt)
        if (controller === null) {
          throw new Error('Controller is not initialized.')
        }
        sourceChanges.push(
          controller.setSource({
            url: `https://media.example/recovery-${String(request.attempt)}.flv`,
            kind: 'flv',
          }),
        )
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)

    const firstSourceChange = sourceChanges[0]
    if (firstSourceChange === undefined) {
      throw new Error('Expected the first recovery source change.')
    }
    await firstSourceChange
    expect(controller.getSnapshot()).toMatchObject({
      generation: 2,
      automaticRecoveryCount: 1,
    })

    clock.advanceBy(1_000)
    const secondSourceChange = sourceChanges[1]
    if (secondSourceChange === undefined) {
      throw new Error('Expected the second recovery source change.')
    }
    await secondSourceChange
    expect(controller.getSnapshot()).toMatchObject({
      generation: 3,
      automaticRecoveryCount: 2,
    })

    clock.advanceBy(1_000)

    expect(attempts).toEqual([1, 2])
    expect(controller.getSnapshot()).toMatchObject({
      state: 'waiting-reopen',
      generation: 3,
      automaticRecoveryCount: 2,
    })

    await controller.destroy()
  })

  it('requests recovery only after excessive live-edge distance persists', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        hardResyncThresholdSeconds: 8,
      },
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 20,
      bufferedAheadSeconds: 10,
      liveEdgeDistanceSeconds: 9,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    clock.advanceBy(1_500)

    expect(reasons).toEqual([])
    expect(adapter.playbackRate()).toBe(1.04)

    clock.advanceBy(500)

    expect(reasons).toEqual(['latency'])
    expect(adapter.playbackRate()).toBe(1)
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
  })

  it('still recovers excessive latency when forward buffer is low', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 5,
      bufferedAheadSeconds: 0.5,
      liveEdgeDistanceSeconds: 30,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    clock.advanceBy(2_000)

    expect(reasons).toEqual(['latency'])
    expect(adapter.playbackRate()).toBe(1)

    await controller.destroy()
  })

  it('recovers a committed source that never renders its first frame', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        sourceWarmupTimeoutMs: 2_000,
      },
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })

    clock.advanceBy(1_999)

    expect(reasons).toEqual([])
    expect(controller.getSnapshot().state).toBe('warming')

    clock.advanceBy(1)

    expect(reasons).toEqual(['source-timeout'])
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('reports preparation failures without exposing the media URL', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPrepare(new Error('transport failed'))

    const sourceChange = controller.setSource({
      url: 'https://media.example/live.flv?token=secret',
      kind: 'flv',
    })

    await expect(sourceChange).rejects.toMatchObject({
      name: 'SourceTransitionError',
      code: 'source-prepare-failed',
      phase: 'prepare',
      generation: 1,
    })
    await expect(sourceChange).rejects.toBeInstanceOf(SourceTransitionError)
    await expect(sourceChange).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('secret'),
    )
    await expect(sourceChange).rejects.not.toHaveProperty('cause')
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
  })

  it('distinguishes playback startup failure from source commit failure', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.failNextPlay(new Error('autoplay was denied'))

    await expect(
      controller.setSource({
        url: 'https://media.example/live.flv',
        kind: 'flv',
      }),
    ).rejects.toMatchObject({
      code: 'source-play-failed',
      phase: 'play',
      generation: 1,
    })

    await controller.destroy()
  })

  it('rejects a prepared source labeled with the wrong generation', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.overrideNextPreparedGeneration(99)

    await expect(
      controller.setSource({
        url: 'https://media.example/live.flv',
        kind: 'flv',
      }),
    ).rejects.toBeInstanceOf(PreparedSourceGenerationMismatchError)
    expect(adapter.wasDiscarded(99)).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      state: 'recovering',
      generation: 1,
    })

    await controller.destroy()
  })

  it('ignores and diagnoses events from an obsolete media generation', async () => {
    const adapter = new FakePlayerAdapter()
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })

    await controller.setSource({
      url: 'https://media.example/first.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })

    await controller.setSource({
      url: 'https://media.example/second.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'waiting', generation: 1 })

    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 2,
    })
    expect(diagnostics).toContain('stale-playback-event')

    await controller.destroy()
  })

  it('turns a recoverable playback error into a bounded recovery request', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({
      type: 'error',
      generation: 1,
      code: 'media-network',
      recoverable: true,
    })
    clock.advanceBy(0)

    expect(reasons).toEqual(['playback-error'])
    expect(controller.getSnapshot().state).toBe('recovering')
    expect(adapter.playbackRate()).toBe(1)

    await controller.destroy()
  })

  it('provides a browser clock when callers do not need time control', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })

    expect(controller.getSnapshot().state).toBe('playing')

    await controller.destroy()
  })

  it('does not accept a first-frame event before the source is prepared', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    const sourceChange = controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })

    expect(controller.getSnapshot().state).toBe('resolving')

    await sourceChange
    expect(controller.getSnapshot().state).toBe('warming')

    clock.advanceBy(8_000)
    expect(reasons).toEqual(['source-timeout'])

    await controller.destroy()
  })

  it('turns a metrics sampling failure into an explicit recovery', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.failNextMetrics(new Error('metrics unavailable'))

    expect(() => {
      clock.advanceBy(500)
    }).not.toThrow()
    expect(reasons).toEqual(['playback-error'])
    expect(diagnostics).toContain('metrics-sample-failed')
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
  })

  it('rejects non-finite playback metrics instead of treating them as healthy', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 5,
      bufferedAheadSeconds: 2,
      liveEdgeDistanceSeconds: Number.NaN,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })

    expect(() => {
      clock.advanceBy(500)
    }).not.toThrow()
    expect(reasons).toEqual(['playback-error'])
    expect(diagnostics).toContain('invalid-playback-metrics')
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
  })

  it('rejects a caller compiled against a different contract version', () => {
    const adapter = new FakePlayerAdapter()

    expect(() => {
      createContinuityController({
        adapter,
        contractVersion: CONTRACT_VERSION + 1,
        clock: new FakeClock(),
      })
    }).toThrow(ContractVersionMismatchError)
  })

  it('bounds the number of live snapshot subscriptions', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    const unsubscribers: Array<() => void> = []

    for (let index = 0; index < 32; index += 1) {
      unsubscribers.push(controller.subscribe(() => {}))
    }

    expect(() => {
      controller.subscribe(() => {})
    }).toThrow(CapacityExceededError)

    unsubscribers[0]?.()
    expect(() => {
      controller.subscribe(() => {})
    }).not.toThrow()

    await controller.destroy()
  })

  it('surfaces a failed recovery callback and stops retrying it', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: () => {
        throw new Error('caller failed')
      },
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)

    expect(controller.getSnapshot().state).toBe('waiting-reopen')
    expect(diagnostics).toContain('recovery-listener-failed')

    await controller.destroy()
  })

  it('times out and discards a source that never finishes preparing', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    adapter.deferPreparations()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        sourceWarmupTimeoutMs: 1_000,
      },
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    const sourceChange = controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })

    clock.advanceBy(1_000)

    expect(reasons).toEqual(['source-timeout'])
    expect(controller.getSnapshot().state).toBe('recovering')

    adapter.resolvePreparation(1)
    await sourceChange
    expect(adapter.wasDiscarded(1)).toBe(true)

    await controller.destroy()
  })

  it('finishes resource cleanup when an adapter cleanup step fails', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 5,
      bufferedAheadSeconds: 3,
      liveEdgeDistanceSeconds: 3,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })
    clock.advanceBy(500)
    adapter.failNextPlaybackRate(new Error('rate reset failed'))

    await expect(controller.destroy()).rejects.toMatchObject({
      code: 'controller-cleanup-failed',
    })
    expect(adapter.isDestroyed()).toBe(true)
    expect(clock.pendingTaskCount()).toBe(0)
    expect(controller.getSnapshot().state).toBe('stopped')
  })

  it('recovers when the active live media unexpectedly ends', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'ended', generation: 1 })
    clock.advanceBy(0)

    expect(reasons).toEqual(['playback-error'])
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
  })

  it('recovers when sampled metrics show a sustained stall', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const reasons: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onRecoveryRequest: (request) => {
        reasons.push(request.reason)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 5,
      bufferedAheadSeconds: 2,
      liveEdgeDistanceSeconds: 2,
      playbackRate: 1,
      stalledSince: 0,
      droppedFrames: null,
    })

    clock.advanceBy(500)

    expect(reasons).toEqual(['stall'])
    expect(controller.getSnapshot().state).toBe('recovering')

    await controller.destroy()
  })

  it('keeps the recovery cooldown after playback briefly resumes', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const attempts: number[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        recoveryCooldownMs: 1_000,
      },
      onRecoveryRequest: (request) => {
        attempts.push(request.attempt)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })

    clock.advanceBy(400)
    expect(attempts).toEqual([1])

    clock.advanceBy(600)
    expect(attempts).toEqual([1, 2])

    await controller.destroy()
  })

  it('diagnoses catchup and bounded recovery decisions', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        maxAutomaticRecoveries: 1,
        recoveryCooldownMs: 500,
      },
      onRecoveryRequest: () => {},
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.setMetrics({
      currentTimeSeconds: 5,
      bufferedAheadSeconds: 3,
      liveEdgeDistanceSeconds: 3,
      playbackRate: 1,
      stalledSince: null,
      droppedFrames: null,
    })
    clock.advanceBy(500)
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(400)
    adapter.emit({ type: 'playing', generation: 1 })
    adapter.emit({ type: 'waiting', generation: 1 })
    clock.advanceBy(500)

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        'catchup-started',
        'stall-detected',
        'recovery-requested',
        'recovery-exhausted',
      ]),
    )

    await controller.destroy()
  })

  it('does not remain recovering without a recovery listener', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const diagnostics: string[] = []
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      onDiagnostic: (event) => {
        diagnostics.push(event.code)
      },
    })

    await controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    adapter.emit({ type: 'first-frame', generation: 1 })
    adapter.emit({ type: 'ended', generation: 1 })
    clock.advanceBy(0)

    expect(controller.getSnapshot().state).toBe('waiting-reopen')
    expect(diagnostics).toContain('recovery-listener-missing')

    await controller.destroy()
  })

  it('discards an obsolete asynchronous preparation without changing the new generation', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })
    adapter.deferPreparations()

    const firstChange = controller.setSource({
      url: 'https://media.example/first.flv',
      kind: 'flv',
    })
    const secondChange = controller.setSource({
      url: 'https://media.example/second.flv',
      kind: 'flv',
    })

    adapter.resolvePreparation(1)
    await firstChange
    expect(adapter.wasDiscarded(1)).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      state: 'resolving',
      generation: 2,
    })

    adapter.resolvePreparation(2)
    await secondChange
    adapter.emit({ type: 'first-frame', generation: 1 })
    expect(controller.getSnapshot().state).toBe('warming')

    adapter.emit({ type: 'first-frame', generation: 2 })
    expect(controller.getSnapshot().state).toBe('playing')

    await controller.destroy()
  })

  it('destroys the adapter exactly once across repeated calls', async () => {
    const adapter = new FakePlayerAdapter()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock: new FakeClock(),
    })

    const firstDestroy = controller.destroy()
    const secondDestroy = controller.destroy()

    expect(secondDestroy).toBe(firstDestroy)
    await firstDestroy
    expect(adapter.destroyCallCount()).toBe(1)
    expect(controller.getSnapshot().state).toBe('stopped')
  })

  it('discards a playback start that finishes after its source timeout', async () => {
    const adapter = new FakePlayerAdapter()
    const clock = new FakeClock()
    const playStarted = adapter.deferPlaybackStart()
    const controller = createContinuityController({
      adapter,
      contractVersion: CONTRACT_VERSION,
      clock,
      policy: {
        sourceWarmupTimeoutMs: 1_000,
      },
      onRecoveryRequest: () => {},
    })

    const sourceChange = controller.setSource({
      url: 'https://media.example/live.flv',
      kind: 'flv',
    })
    await playStarted

    clock.advanceBy(1_000)
    expect(controller.getSnapshot().state).toBe('recovering')

    adapter.resolvePlaybackStart()
    await sourceChange

    expect(adapter.wasDiscarded(1)).toBe(true)

    await controller.destroy()
  })
})
