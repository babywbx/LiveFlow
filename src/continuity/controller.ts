import { createSystemClock, type Clock, type TimerHandle } from '../shared/clock.js'
import { CONTRACT_VERSION } from '../shared/contract.js'
import { createDiagnosticEmitter, type DiagnosticEmitter } from '../shared/diagnostic-emitter.js'
import type { EngineHooks } from '../shared/diagnostics.js'
import {
  CapacityExceededError,
  ContractVersionMismatchError,
  InvalidPlaybackMetricsError,
  LiveFlowError,
  PreparedSourceGenerationMismatchError,
  SourceTransitionError,
} from '../shared/errors.js'
import { validatePlaybackMetrics } from './metrics.js'
import { resolveContinuityPolicy } from './policy.js'
import {
  INITIAL_CONTINUITY_STATE,
  reduceContinuityState,
  type ContinuityMachineEvent,
  type ContinuityMachineState,
} from './state-machine.js'
import type {
  ContinuityController,
  ContinuityPolicy,
  ContinuityRecoveryReason,
  ContinuityRecoveryRequestListener,
  ContinuitySnapshot,
  ContinuitySnapshotListener,
  LivePlayerAdapter,
  LiveSource,
  PlaybackEvent,
  PlaybackMetrics,
  PreparedSource,
} from './types.js'

export interface ContinuityControllerOptions extends EngineHooks {
  readonly adapter: LivePlayerAdapter
  readonly contractVersion: number
  readonly clock?: Clock
  readonly policy?: Partial<ContinuityPolicy>
  readonly onRecoveryRequest?: ContinuityRecoveryRequestListener
}

export function createContinuityController(
  options: ContinuityControllerOptions,
): ContinuityController {
  if (options.contractVersion !== CONTRACT_VERSION) {
    throw new ContractVersionMismatchError(CONTRACT_VERSION, options.contractVersion)
  }

  const clock = options.clock ?? createSystemClock()
  return new DefaultContinuityController(
    options.adapter,
    clock,
    resolveContinuityPolicy(options.policy),
    options.onRecoveryRequest,
    createDiagnosticEmitter(options, clock),
  )
}

class DefaultContinuityController implements ContinuityController {
  private static readonly HARD_LATENCY_CONFIRMATION_SAMPLES = 4
  private static readonly MAX_SNAPSHOT_LISTENERS = 32
  private static readonly METRICS_SAMPLE_INTERVAL_MS = 500
  private static readonly MIN_CATCHUP_BUFFER_SECONDS = 1
  private static readonly RATE_CHANGE_COOLDOWN_MS = 1_000
  private static readonly STALL_DEBOUNCE_MS = 400

  private machine: ContinuityMachineState = INITIAL_CONTINUITY_STATE
  private readonly listeners = new Set<ContinuitySnapshotListener>()
  private readonly unsubscribeAdapter: () => void
  private destroyPromise: Promise<void> | null = null
  private monitorTimer: TimerHandle | null = null
  private recoveryTimer: TimerHandle | null = null
  private sourceTimeoutTimer: TimerHandle | null = null
  private pendingRecoveryReason: ContinuityRecoveryReason | null = null
  private lastRecoveryAt: number | null = null
  private hardLatencySamples = 0
  private appliedPlaybackRate = 1
  private lastPlaybackRateChangeAt: number | null = null

  constructor(
    private readonly adapter: LivePlayerAdapter,
    private readonly clock: Clock,
    private readonly policy: ContinuityPolicy,
    private readonly onRecoveryRequest: ContinuityRecoveryRequestListener | undefined,
    private readonly diagnostics: DiagnosticEmitter,
  ) {
    this.unsubscribeAdapter = this.adapter.subscribe((event) => {
      this.handlePlaybackEvent(event)
    })
  }

  async setSource(source: LiveSource): Promise<void> {
    this.ensureActive()
    this.cancelMonitoring()
    this.cancelRecovery()
    this.cancelSourceTimeout()
    this.hardLatencySamples = 0
    this.applyPlaybackRate(1, true)
    const generation = this.machine.generation + 1
    this.transition({ type: 'source-requested', generation })
    this.scheduleSourceTimeout(generation)

    let prepared: PreparedSource
    try {
      prepared = await this.adapter.prepare(source, generation)
    } catch {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      throw new SourceTransitionError('prepare', generation)
    }

    if (prepared.generation !== generation) {
      await this.discardPrepared(prepared, generation)
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      throw new PreparedSourceGenerationMismatchError(generation, prepared.generation)
    }

    if (!this.isCurrentGeneration(generation) || this.machine.state !== 'resolving') {
      await this.discardPrepared(prepared, generation)
      return
    }

    this.transition({ type: 'source-prepared', generation })

    try {
      await this.adapter.commit(prepared, generation)
    } catch {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      throw new SourceTransitionError('commit', generation)
    }

    if (!this.isPreparedSourceUsable(generation)) {
      await this.discardPrepared(prepared, generation)
      return
    }
    if (this.hasStartedPlayback(generation)) {
      return
    }

    try {
      await this.adapter.play()
    } catch {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      throw new SourceTransitionError('play', generation)
    }

    if (!this.isPreparedSourceUsable(generation)) {
      await this.discardPrepared(prepared, generation)
    }
  }

  getSnapshot(): ContinuitySnapshot {
    return {
      state: this.machine.state,
      generation: this.machine.generation,
      automaticRecoveryCount: this.machine.automaticRecoveryCount,
    }
  }

  subscribe(listener: ContinuitySnapshotListener): () => void {
    this.ensureActive()
    if (
      !this.listeners.has(listener) &&
      this.listeners.size >= DefaultContinuityController.MAX_SNAPSHOT_LISTENERS
    ) {
      throw new CapacityExceededError(
        'continuity-snapshot-listeners',
        DefaultContinuityController.MAX_SNAPSHOT_LISTENERS,
      )
    }

    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise !== null) {
      return this.destroyPromise
    }

    this.destroyPromise = this.performDestroy()
    return this.destroyPromise
  }

  private async performDestroy(): Promise<void> {
    this.transition({ type: 'destroyed' })
    let cleanupFailed = false
    const attempt = (operation: () => void): void => {
      try {
        operation()
      } catch {
        cleanupFailed = true
      }
    }

    attempt(() => {
      this.cancelMonitoring()
    })
    attempt(() => {
      this.cancelRecovery()
    })
    attempt(() => {
      this.cancelSourceTimeout()
    })
    attempt(() => {
      this.applyPlaybackRate(1, true)
    })
    attempt(() => {
      this.unsubscribeAdapter()
    })
    this.listeners.clear()

    try {
      await this.adapter.destroy()
    } catch {
      cleanupFailed = true
    }

    if (cleanupFailed) {
      throw new LiveFlowError(
        'controller-cleanup-failed',
        'The continuity controller could not release every adapter resource cleanly.',
      )
    }
  }

  private handlePlaybackEvent(event: PlaybackEvent): void {
    if (!this.isCurrentGeneration(event.generation)) {
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'stale-playback-event',
        level: 'debug',
        generation: event.generation,
        detail: {
          currentGeneration: this.machine.generation,
        },
      })
      return
    }

    if (event.type === 'first-frame') {
      const previousState = this.machine.state
      this.hardLatencySamples = 0
      this.transition({ type: 'first-frame', generation: event.generation })
      if (previousState !== this.machine.state && this.machine.state === 'playing') {
        this.cancelSourceTimeout()
        this.scheduleMonitoring()
      }
      return
    }

    if (event.type === 'waiting' || event.type === 'stalled') {
      this.hardLatencySamples = 0
      this.applyPlaybackRate(1, true)
      this.cancelMonitoring()
      this.transition({ type: 'playback-degraded', generation: event.generation })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'stall-detected',
        level: 'info',
        generation: event.generation,
      })
      this.scheduleRecovery('stall', DefaultContinuityController.STALL_DEBOUNCE_MS)
      return
    }

    if (event.type === 'error') {
      this.hardLatencySamples = 0
      this.applyPlaybackRate(1, true)
      this.cancelMonitoring()
      this.transition({ type: 'playback-degraded', generation: event.generation })

      if (event.recoverable) {
        this.scheduleRecovery('playback-error', 0)
      } else {
        this.transition({
          type: 'recovery-exhausted',
          generation: event.generation,
        })
        this.diagnostics.emit({
          scope: 'continuity',
          code: 'nonrecoverable-playback-error',
          level: 'warn',
          generation: event.generation,
        })
      }
      return
    }

    if (event.type === 'ended') {
      this.hardLatencySamples = 0
      this.applyPlaybackRate(1, true)
      this.cancelMonitoring()
      this.transition({ type: 'playback-degraded', generation: event.generation })
      this.scheduleRecovery('playback-error', 0)
      return
    }

    if (event.type === 'playing' && this.machine.state !== 'warming') {
      this.hardLatencySamples = 0
      this.cancelRecovery()
      this.transition({ type: 'playback-resumed', generation: event.generation })
      this.scheduleMonitoring()
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.machine.state !== 'stopped' && generation === this.machine.generation
  }

  private isPreparedSourceUsable(generation: number): boolean {
    return (
      this.isCurrentGeneration(generation) &&
      (this.machine.state === 'warming' || this.machine.state === 'playing')
    )
  }

  private hasStartedPlayback(generation: number): boolean {
    return this.isCurrentGeneration(generation) && this.machine.state === 'playing'
  }

  private async discardPrepared(prepared: PreparedSource, generation: number): Promise<void> {
    try {
      await this.adapter.discard(prepared)
    } catch {
      throw new SourceTransitionError('discard', generation)
    }

    this.diagnostics.emit({
      scope: 'continuity',
      code: 'prepared-source-discarded',
      level: 'debug',
      generation,
    })
  }

  private transition(event: ContinuityMachineEvent): void {
    const previous = this.machine
    this.machine = reduceContinuityState(this.machine, event)
    if (this.machine === previous) {
      return
    }

    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        continue
      }
    }
  }

  private ensureActive(): void {
    if (this.machine.state === 'stopped') {
      throw new LiveFlowError('controller-destroyed', 'The continuity controller is destroyed.')
    }
  }

  private scheduleMonitoring(): void {
    if (this.monitorTimer !== null || this.machine.state !== 'playing') {
      return
    }

    this.monitorTimer = this.clock.setTimeout(() => {
      this.monitorTimer = null
      this.samplePlayback()
      this.scheduleMonitoring()
    }, DefaultContinuityController.METRICS_SAMPLE_INTERVAL_MS)
  }

  private cancelMonitoring(): void {
    if (this.monitorTimer === null) {
      return
    }

    const timer = this.monitorTimer
    this.monitorTimer = null
    this.clock.clearTimeout(timer)
  }

  private samplePlayback(): void {
    if (this.machine.state !== 'playing') {
      return
    }

    let metrics: PlaybackMetrics
    try {
      metrics = this.adapter.getMetrics()
      validatePlaybackMetrics(metrics, this.clock.now())
    } catch (error) {
      this.applyPlaybackRate(1, true)
      this.transition({
        type: 'playback-degraded',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code:
          error instanceof InvalidPlaybackMetricsError
            ? 'invalid-playback-metrics'
            : 'metrics-sample-failed',
        level: 'warn',
        generation: this.machine.generation,
      })
      this.scheduleRecovery('playback-error', 0)
      return
    }

    const catchupBoundary =
      this.policy.targetLatencySeconds + this.policy.softCatchupThresholdSeconds

    if (
      metrics.stalledSince !== null &&
      this.clock.now() - metrics.stalledSince >= DefaultContinuityController.STALL_DEBOUNCE_MS
    ) {
      this.applyPlaybackRate(1, true)
      this.transition({
        type: 'playback-degraded',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'stall-detected',
        level: 'info',
        generation: this.machine.generation,
      })
      this.scheduleRecovery('stall', 0)
      return
    }

    if (metrics.liveEdgeDistanceSeconds >= this.policy.hardResyncThresholdSeconds) {
      this.hardLatencySamples = Math.min(
        this.hardLatencySamples + 1,
        DefaultContinuityController.HARD_LATENCY_CONFIRMATION_SAMPLES,
      )

      if (this.hardLatencySamples < DefaultContinuityController.HARD_LATENCY_CONFIRMATION_SAMPLES) {
        if (
          metrics.bufferedAheadSeconds >= DefaultContinuityController.MIN_CATCHUP_BUFFER_SECONDS
        ) {
          this.applyPlaybackRate(this.policy.catchupRate, false)
        } else {
          this.applyPlaybackRate(1, true)
        }
        return
      }

      this.hardLatencySamples = 0
      this.applyPlaybackRate(1, true)
      this.transition({
        type: 'playback-degraded',
        generation: this.machine.generation,
      })
      this.requestRecovery('latency')
      return
    }

    if (metrics.bufferedAheadSeconds < DefaultContinuityController.MIN_CATCHUP_BUFFER_SECONDS) {
      this.hardLatencySamples = 0
      this.applyPlaybackRate(1, true)
      return
    }

    this.hardLatencySamples = 0

    if (
      metrics.liveEdgeDistanceSeconds >= catchupBoundary &&
      metrics.liveEdgeDistanceSeconds < this.policy.hardResyncThresholdSeconds &&
      metrics.bufferedAheadSeconds > 0
    ) {
      this.applyPlaybackRate(this.policy.catchupRate, false)
      return
    }

    if (metrics.liveEdgeDistanceSeconds <= this.policy.targetLatencySeconds) {
      this.applyPlaybackRate(1, false)
    }
  }

  private applyPlaybackRate(rate: number, immediate: boolean): void {
    if (rate === this.appliedPlaybackRate) {
      return
    }

    if (this.lastPlaybackRateChangeAt !== null && !immediate) {
      const elapsed = this.clock.now() - this.lastPlaybackRateChangeAt
      if (elapsed < DefaultContinuityController.RATE_CHANGE_COOLDOWN_MS) {
        return
      }
    }

    const previousRate = this.appliedPlaybackRate
    this.adapter.setPlaybackRate(rate)
    this.appliedPlaybackRate = rate
    this.lastPlaybackRateChangeAt = this.clock.now()
    this.diagnostics.emit({
      scope: 'continuity',
      code: rate > 1 ? 'catchup-started' : 'catchup-stopped',
      level: 'info',
      generation: this.machine.generation,
      detail: {
        previousRate,
        rate,
      },
    })
  }

  private scheduleRecovery(reason: ContinuityRecoveryReason, delayMs: number): void {
    if (this.recoveryTimer !== null) {
      return
    }

    this.pendingRecoveryReason = reason
    this.recoveryTimer = this.clock.setTimeout(() => {
      this.recoveryTimer = null
      const pendingReason = this.pendingRecoveryReason
      this.pendingRecoveryReason = null
      if (pendingReason !== null) {
        this.requestRecovery(pendingReason)
      }
    }, delayMs)
  }

  private requestRecovery(reason: ContinuityRecoveryReason): void {
    if (this.machine.state === 'stopped' || this.machine.state === 'playing') {
      return
    }

    if (this.machine.automaticRecoveryCount >= this.policy.maxAutomaticRecoveries) {
      this.transition({
        type: 'recovery-exhausted',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'recovery-exhausted',
        level: 'warn',
        generation: this.machine.generation,
        detail: {
          attempts: this.machine.automaticRecoveryCount,
        },
      })
      return
    }

    if (this.lastRecoveryAt !== null) {
      const elapsed = this.clock.now() - this.lastRecoveryAt
      if (elapsed < this.policy.recoveryCooldownMs) {
        this.scheduleRecovery(reason, this.policy.recoveryCooldownMs - elapsed)
        return
      }
    }

    this.lastRecoveryAt = this.clock.now()
    this.transition({
      type: 'recovery-requested',
      generation: this.machine.generation,
    })
    this.diagnostics.emit({
      scope: 'continuity',
      code: 'recovery-requested',
      level: 'info',
      generation: this.machine.generation,
      detail: {
        attempt: this.machine.automaticRecoveryCount,
        reason,
      },
    })

    if (this.onRecoveryRequest === undefined) {
      this.transition({
        type: 'recovery-exhausted',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'recovery-listener-missing',
        level: 'warn',
        generation: this.machine.generation,
      })
      return
    }

    try {
      this.onRecoveryRequest({
        reason,
        generation: this.machine.generation,
        attempt: this.machine.automaticRecoveryCount,
      })
    } catch {
      this.transition({
        type: 'recovery-exhausted',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'recovery-listener-failed',
        level: 'warn',
        generation: this.machine.generation,
      })
      return
    }
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer !== null) {
      const timer = this.recoveryTimer
      this.recoveryTimer = null
      this.clock.clearTimeout(timer)
    }
    this.pendingRecoveryReason = null
  }

  private scheduleSourceTimeout(generation: number): void {
    if (
      (this.machine.state !== 'resolving' && this.machine.state !== 'warming') ||
      this.sourceTimeoutTimer !== null
    ) {
      return
    }

    this.sourceTimeoutTimer = this.clock.setTimeout(() => {
      this.sourceTimeoutTimer = null
      if (
        !this.isCurrentGeneration(generation) ||
        (this.machine.state !== 'resolving' && this.machine.state !== 'warming')
      ) {
        return
      }

      this.transition({
        type: 'playback-degraded',
        generation,
      })
      this.requestRecovery('source-timeout')
    }, this.policy.sourceWarmupTimeoutMs)
  }

  private cancelSourceTimeout(): void {
    if (this.sourceTimeoutTimer === null) {
      return
    }

    const timer = this.sourceTimeoutTimer
    this.sourceTimeoutTimer = null
    this.clock.clearTimeout(timer)
  }
}
