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
  sanitizeErrorName,
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
  PageActivitySource,
  PlaybackEvent,
  PlaybackMetrics,
  PlaybackSuspension,
  PlaybackSuspensionReason,
  PreparedSource,
} from './types.js'

type PreparedCleanupTrigger = 'commit' | 'destroy' | 'play' | 'source-timeout' | 'superseded'

export interface ContinuityControllerOptions extends EngineHooks {
  readonly adapter: LivePlayerAdapter
  readonly contractVersion: number
  readonly clock?: Clock
  readonly policy?: Partial<ContinuityPolicy>
  readonly onRecoveryRequest?: ContinuityRecoveryRequestListener
  readonly pageActivity?: PageActivitySource
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
    options.pageActivity,
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
  private warmingPrepared: PreparedSource | null = null
  private lastRecoveryAt: number | null = null
  private lastRecoveryGeneration: number | null = null
  private hardLatencySamples = 0
  private stallSeeks = 0
  private outstandingRecoveries = 0
  private appliedPlaybackRate = 1
  private lastPlaybackRateChangeAt: number | null = null
  private healthySince: number | null = null
  private suspension: PlaybackSuspension | null = null
  private unsubscribePageActivity: (() => void) | null = null
  private resumeFlight: Promise<void> | null = null

  constructor(
    private readonly adapter: LivePlayerAdapter,
    private readonly clock: Clock,
    private readonly policy: ContinuityPolicy,
    private readonly onRecoveryRequest: ContinuityRecoveryRequestListener | undefined,
    private readonly diagnostics: DiagnosticEmitter,
    private readonly pageActivity?: PageActivitySource,
  ) {
    this.unsubscribeAdapter = this.adapter.subscribe((event) => {
      this.handlePlaybackEvent(event)
    })
  }

  async setSource(source: LiveSource): Promise<void> {
    this.ensureActive()
    const supersededPrepared = this.takeWarmingPrepared()
    if (supersededPrepared !== null) {
      void this.discardAfterTransitionFailure(
        supersededPrepared,
        supersededPrepared.generation,
        'superseded',
      )
    }
    this.cancelMonitoring()
    this.clearPendingRecovery()
    this.cancelSourceTimeout()
    this.hardLatencySamples = 0
    this.stallSeeks = 0
    this.outstandingRecoveries = 0
    this.applyPlaybackRateForSourceChange()
    const generation = this.machine.generation + 1
    this.transition({ type: 'source-requested', generation })
    this.scheduleSourceTimeout(generation)

    let prepared: PreparedSource
    try {
      prepared = await this.adapter.prepare(source, generation)
    } catch (error) {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      throw new SourceTransitionError('prepare', generation, sanitizeErrorName(error))
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

    this.warmingPrepared = prepared
    this.transition({ type: 'source-prepared', generation })

    try {
      await this.adapter.commit(prepared, generation)
    } catch (error) {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      const failedPrepared = this.takeWarmingPrepared(generation)
      if (failedPrepared !== null) {
        await this.discardAfterTransitionFailure(failedPrepared, generation, 'commit')
      }
      throw new SourceTransitionError('commit', generation, sanitizeErrorName(error))
    }

    if (!this.isPreparedSourceUsable(generation)) {
      await this.discardTrackedPrepared(prepared, generation)
      return
    }
    if (this.hasStartedPlayback(generation)) {
      return
    }

    try {
      await this.adapter.play()
    } catch (error) {
      const reason = this.classifyPlayRejection(error)
      if (reason !== null) {
        this.enterSuspension(generation, reason)
        return
      }
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition({ type: 'source-failed', generation })
      const failedPrepared = this.takeWarmingPrepared(generation)
      if (failedPrepared !== null) {
        await this.discardAfterTransitionFailure(failedPrepared, generation, 'play')
      }
      throw new SourceTransitionError('play', generation, sanitizeErrorName(error))
    }

    if (!this.isPreparedSourceUsable(generation)) {
      await this.discardTrackedPrepared(prepared, generation)
    }
  }

  async resume(): Promise<void> {
    this.ensureActive()
    if (this.suspension === null) {
      return
    }
    await this.retrySuspendedPlay()
  }

  cancelRecovery(generation: number): void {
    if (!this.isCurrentGeneration(generation)) {
      return
    }

    this.clearPendingRecovery()
    if (this.outstandingRecoveries === 0) {
      return
    }

    this.outstandingRecoveries -= 1
    this.lastRecoveryAt = null
    this.lastRecoveryGeneration = null
    this.transition({ type: 'recovery-cancelled', generation })
    this.diagnostics.emit({
      scope: 'continuity',
      code: 'recovery-cancelled',
      level: 'info',
      generation,
      detail: {
        attempts: this.machine.automaticRecoveryCount,
      },
    })
  }

  private classifyPlayRejection(error: unknown): PlaybackSuspensionReason | null {
    if (!(error instanceof Error)) {
      return null
    }
    if (error.name === 'NotAllowedError') {
      return 'autoplay-blocked'
    }
    // Chrome aborts muted video-only playback when the page is not visible.
    if (error.name === 'AbortError') {
      return 'browser-suspended'
    }
    return null
  }

  private enterSuspension(generation: number, reason: PlaybackSuspensionReason): void {
    if (!this.isCurrentGeneration(generation)) {
      return
    }
    this.cancelSourceTimeout()
    this.suspension = { reason, generation }
    this.diagnostics.emit({
      scope: 'continuity',
      code: 'playback-suspended',
      level: 'warn',
      detail: { reason, generation },
    })
    this.transition({ type: 'playback-suspended', generation })
    this.watchPageActivity()
  }

  private watchPageActivity(): void {
    if (this.pageActivity === undefined || this.unsubscribePageActivity !== null) {
      return
    }
    this.unsubscribePageActivity = this.pageActivity.subscribe((hidden) => {
      if (hidden || this.suspension === null) {
        return
      }
      void this.retrySuspendedPlay()
    })
  }

  private async retrySuspendedPlay(): Promise<void> {
    const suspension = this.suspension
    if (suspension === null || this.destroyPromise !== null) {
      return
    }
    if (!this.isCurrentGeneration(suspension.generation)) {
      this.clearSuspension()
      return
    }
    if (this.resumeFlight !== null) {
      await this.resumeFlight
      return
    }
    const flight = this.adapter
      .play()
      .then(() => {
        this.clearSuspension()
        this.transition({ type: 'playback-resumed', generation: suspension.generation })
      })
      .catch(() => {
        // Still refused: stay suspended and wait for the next visibility or resume call.
      })
      .finally(() => {
        if (this.resumeFlight === flight) {
          this.resumeFlight = null
        }
      })
    this.resumeFlight = flight
    await flight
  }

  private clearSuspension(): void {
    this.suspension = null
    if (this.unsubscribePageActivity !== null) {
      const unsubscribe = this.unsubscribePageActivity
      this.unsubscribePageActivity = null
      unsubscribe()
    }
  }

  getSnapshot(): ContinuitySnapshot {
    return {
      state: this.machine.state,
      generation: this.machine.generation,
      automaticRecoveryCount: this.machine.automaticRecoveryCount,
      healthySince: this.healthySince,
      suspension: this.suspension,
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
      this.clearSuspension()
    })
    attempt(() => {
      this.cancelMonitoring()
    })
    attempt(() => {
      this.clearPendingRecovery()
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

    const warmingPrepared = this.takeWarmingPrepared()
    if (warmingPrepared !== null) {
      try {
        await this.discardPrepared(warmingPrepared, warmingPrepared.generation)
      } catch {
        cleanupFailed = true
      }
    }

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
        // A recovery that produced a new playing source must not throttle the next, unrelated one.
        if (
          this.lastRecoveryGeneration !== null &&
          event.generation > this.lastRecoveryGeneration
        ) {
          this.lastRecoveryAt = null
          this.lastRecoveryGeneration = null
        }
        this.takeWarmingPrepared(event.generation)
        this.cancelSourceTimeout()
        this.scheduleMonitoring()
      }
      return
    }

    if (event.type === 'waiting' || event.type === 'stalled') {
      if (this.machine.state === 'resolving' || this.machine.state === 'warming') {
        return
      }
      this.hardLatencySamples = 0
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
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
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
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
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
      this.cancelMonitoring()
      this.transition({ type: 'playback-degraded', generation: event.generation })
      this.scheduleRecovery('playback-error', 0)
      return
    }

    if (event.type === 'playing' && this.machine.state !== 'warming') {
      this.hardLatencySamples = 0
      this.clearPendingRecovery()
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
    } catch (error) {
      throw new SourceTransitionError('discard', generation, sanitizeErrorName(error))
    }

    this.diagnostics.emit({
      scope: 'continuity',
      code: 'prepared-source-discarded',
      level: 'debug',
      generation,
    })
  }

  private async discardTrackedPrepared(
    prepared: PreparedSource,
    generation: number,
  ): Promise<void> {
    if (this.warmingPrepared !== prepared) {
      return
    }

    this.warmingPrepared = null
    await this.discardPrepared(prepared, generation)
  }

  private async discardAfterTransitionFailure(
    prepared: PreparedSource,
    generation: number,
    trigger: PreparedCleanupTrigger,
  ): Promise<void> {
    try {
      await this.discardPrepared(prepared, generation)
    } catch {
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'prepared-source-cleanup-failed',
        level: 'warn',
        generation,
        detail: {
          trigger,
        },
      })
    }
  }

  private takeWarmingPrepared(generation?: number): PreparedSource | null {
    const prepared = this.warmingPrepared
    if (prepared === null || (generation !== undefined && prepared.generation !== generation)) {
      return null
    }

    this.warmingPrepared = null
    return prepared
  }

  private transition(event: ContinuityMachineEvent): void {
    const previous = this.machine
    this.machine = reduceContinuityState(this.machine, event)
    if (this.machine === previous) {
      return
    }

    if (this.machine.state === 'playing') {
      if (previous.state !== 'playing') {
        this.healthySince = this.clock.now()
      }
    } else {
      this.healthySince = null
    }
    if (this.machine.state !== 'suspended' && this.suspension !== null) {
      this.clearSuspension()
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
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
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
      // Reopening a source costs seconds; a stall the seek head can escape costs nothing.
      if (this.tryStallSeek(metrics)) {
        return
      }
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
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

    if (metrics.liveEdgeDistanceSeconds > this.policy.maxPlausibleLiveEdgeSeconds) {
      // A broken timeline, not latency: catching up, seeking and reopening all fail to help.
      this.hardLatencySamples = 0
      this.applyPlaybackRateSafely(1, false)
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'implausible-live-edge',
        level: 'warn',
        generation: this.machine.generation,
      })
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
          if (!this.applyPlaybackRateSafely(this.policy.catchupRate, false)) {
            return
          }
        } else {
          if (!this.applyPlaybackRateSafely(1, true)) {
            return
          }
        }
        return
      }

      this.hardLatencySamples = 0
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
      this.transition({
        type: 'playback-degraded',
        generation: this.machine.generation,
      })
      this.requestRecovery('latency')
      return
    }

    if (metrics.bufferedAheadSeconds < DefaultContinuityController.MIN_CATCHUP_BUFFER_SECONDS) {
      this.hardLatencySamples = 0
      if (!this.applyPlaybackRateSafely(1, true)) {
        return
      }
      return
    }

    this.hardLatencySamples = 0

    if (
      metrics.liveEdgeDistanceSeconds >= catchupBoundary &&
      metrics.liveEdgeDistanceSeconds < this.policy.hardResyncThresholdSeconds &&
      metrics.bufferedAheadSeconds > 0
    ) {
      this.applyPlaybackRateSafely(this.policy.catchupRate, false)
      return
    }

    if (metrics.liveEdgeDistanceSeconds <= this.policy.targetLatencySeconds) {
      this.applyPlaybackRateSafely(1, false)
    }
  }

  private applyPlaybackRateForSourceChange(): void {
    try {
      this.applyPlaybackRate(1, true)
    } catch {
      this.transition({
        type: 'playback-degraded',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'playback-rate-update-failed',
        level: 'warn',
        generation: this.machine.generation,
      })
      this.scheduleRecovery('playback-error', 0)
      throw new LiveFlowError(
        'playback-rate-update-failed',
        'The player rejected a playback-rate update.',
      )
    }
  }

  private applyPlaybackRateSafely(rate: number, immediate: boolean): boolean {
    try {
      this.applyPlaybackRate(rate, immediate)
      return true
    } catch {
      this.cancelMonitoring()
      this.transition({
        type: 'playback-degraded',
        generation: this.machine.generation,
      })
      this.diagnostics.emit({
        scope: 'continuity',
        code: 'playback-rate-update-failed',
        level: 'warn',
        generation: this.machine.generation,
      })
      this.scheduleRecovery('playback-error', 0)
      return false
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
      if (pendingReason === null) {
        return
      }
      if (this.seekPastStall(pendingReason)) {
        this.scheduleRecovery(pendingReason, DefaultContinuityController.STALL_DEBOUNCE_MS)
        return
      }
      this.requestRecovery(pendingReason)
    }, delayMs)
  }

  // A resumed stream cancels this pending recovery on its own 'playing' event.
  private seekPastStall(reason: ContinuityRecoveryReason): boolean {
    if (reason !== 'stall' && reason !== 'latency') {
      return false
    }
    let metrics: PlaybackMetrics
    try {
      metrics = this.adapter.getMetrics()
    } catch {
      return false
    }
    return this.tryStallSeek(metrics)
  }

  private tryStallSeek(metrics: PlaybackMetrics): boolean {
    const seek = this.adapter.seek?.bind(this.adapter)
    if (seek === undefined || this.stallSeeks >= this.policy.maxStallSeeksPerSource) {
      return false
    }

    const gap = metrics.strandedGapSeconds
    let target: number
    if (typeof gap === 'number') {
      if (gap <= 0 || gap > this.policy.maxGapJumpSeconds) return false
      target = metrics.currentTimeSeconds + gap + this.policy.stallNudgeSeconds
    } else if (metrics.bufferedAheadSeconds > this.policy.stallNudgeSeconds) {
      target = metrics.currentTimeSeconds + this.policy.stallNudgeSeconds
    } else {
      return false
    }

    this.stallSeeks += 1
    try {
      seek(target)
    } catch {
      return false
    }
    this.diagnostics.emit({
      scope: 'continuity',
      code: 'stall-seek',
      level: 'info',
      generation: this.machine.generation,
      detail: {
        attempt: this.stallSeeks,
        stranded: typeof gap === 'number',
      },
    })
    return true
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
    this.lastRecoveryGeneration = this.machine.generation
    const countBeforeRequest = this.machine.automaticRecoveryCount
    this.transition({
      type: 'recovery-requested',
      generation: this.machine.generation,
    })
    const counted = this.machine.automaticRecoveryCount > countBeforeRequest
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

    // Count before delivery; the listener may cancel synchronously.
    if (counted) {
      this.outstandingRecoveries += 1
    }

    try {
      this.onRecoveryRequest({
        reason,
        generation: this.machine.generation,
        attempt: this.machine.automaticRecoveryCount,
      })
    } catch {
      if (counted) {
        this.outstandingRecoveries = Math.max(0, this.outstandingRecoveries - 1)
      }
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

  private clearPendingRecovery(): void {
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
      if (!this.isCurrentGeneration(generation)) {
        return
      }

      // The candidate may have failed loudly first; release it whatever the state now is.
      const timedOutPrepared = this.takeWarmingPrepared(generation)
      if (timedOutPrepared !== null) {
        void this.discardAfterTransitionFailure(timedOutPrepared, generation, 'source-timeout')
      }
      if (this.machine.state !== 'resolving' && this.machine.state !== 'warming') {
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
