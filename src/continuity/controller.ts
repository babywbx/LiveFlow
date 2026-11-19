import {
  createSystemTimerClock,
  type Clock,
  type TimerClock,
  type TimerHandle,
} from '../shared/clock.js'
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

const HARD_LATENCY_CONFIRMATION_SAMPLES = 4
const MAX_SNAPSHOT_LISTENERS = 32
const METRICS_SAMPLE_INTERVAL_MS = 500
const MIN_CATCHUP_BUFFER_SECONDS = 1
const RATE_CHANGE_COOLDOWN_MS = 1_000
const STALL_DEBOUNCE_MS = 400

type PreparedCleanupTrigger = 'commit' | 'destroy' | 'play' | 'source-timeout' | 'superseded'
type SeekRecoveryResult = 'failed' | 'recovered' | 'seeked'

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

  const clock = options.clock ?? createSystemTimerClock()
  return new DefaultContinuityController(
    options.adapter,
    clock,
    resolveContinuityPolicy(options.policy),
    options.onRecoveryRequest,
    createDiagnosticEmitter('continuity', options, clock),
    options.pageActivity,
  )
}

class DefaultContinuityController implements ContinuityController {
  private machine: ContinuityMachineState = INITIAL_CONTINUITY_STATE
  private readonly listeners = new Set<ContinuitySnapshotListener>()
  private readonly unsubscribeAdapter: () => void
  private adapterUnsubscribed = false
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
  private readyGeneration: number | null = null

  constructor(
    private readonly adapter: LivePlayerAdapter,
    private readonly clock: TimerClock,
    private readonly policy: ContinuityPolicy,
    private readonly onRecoveryRequest: ContinuityRecoveryRequestListener | undefined,
    private readonly emitDiagnostic: DiagnosticEmitter,
    private readonly pageActivity?: PageActivitySource,
  ) {
    this.unsubscribeAdapter = this.adapter.subscribe((event) => {
      this.handlePlaybackEvent(event)
    })
  }

  async setSource(source: LiveSource): Promise<void> {
    this.ensureActive()
    this.clearSuspension()
    this.resumeFlight = null
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
    this.readyGeneration = null
    this.transition('source-requested', generation)
    this.scheduleSourceTimeout(generation)

    let prepared: PreparedSource
    try {
      prepared = await this.adapter.prepare(source, generation)
    } catch (error) {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition('source-failed', generation)
      throw new SourceTransitionError('prepare', generation, sanitizeErrorName(error))
    }

    if (prepared.generation !== generation) {
      await this.discardPrepared(prepared, generation)
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition('source-failed', generation)
      throw new PreparedSourceGenerationMismatchError(generation, prepared.generation)
    }

    if (!this.isCurrentGeneration(generation) || this.machine.state !== 'resolving') {
      await this.discardPrepared(prepared, generation)
      return
    }

    this.warmingPrepared = prepared
    this.transition('source-prepared', generation)

    try {
      await this.adapter.commit(prepared, generation)
    } catch (error) {
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition('source-failed', generation)
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
      const errorName = sanitizeErrorName(error)
      const reason = this.classifyPlayRejection(error, errorName)
      if (reason !== null) {
        this.enterSuspension(generation, reason)
        return
      }
      if (this.isCurrentGeneration(generation)) {
        this.cancelSourceTimeout()
      }
      this.transition('source-failed', generation)
      const failedPrepared = this.takeWarmingPrepared(generation)
      if (failedPrepared !== null) {
        await this.discardAfterTransitionFailure(failedPrepared, generation, 'play')
      }
      throw new SourceTransitionError('play', generation, errorName)
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

    if (this.outstandingRecoveries === 0) {
      return
    }

    this.clearPendingRecovery()
    this.outstandingRecoveries -= 1
    this.lastRecoveryAt = null
    this.lastRecoveryGeneration = null
    this.transition('recovery-cancelled', generation)
    this.emitDiagnostic('recovery-cancelled', 'info', generation, {
      attempts: this.machine.automaticRecoveryCount,
    })
  }

  private classifyPlayRejection(
    error: unknown,
    errorName: string,
  ): PlaybackSuspensionReason | null {
    try {
      if (typeof error === 'object' && error !== null) {
        const code: unknown = Reflect.get(error, 'code')
        if (code === 'media-play-autoplay-blocked') {
          return 'autoplay-blocked'
        }
        if (code === 'media-play-browser-suspended') {
          return 'browser-suspended'
        }
      }
    } catch {
      return null
    }
    if (errorName === 'NotAllowedError') {
      return 'autoplay-blocked'
    }
    // Chrome aborts muted video-only playback when the page is not visible.
    if (errorName === 'AbortError') {
      return 'browser-suspended'
    }
    return null
  }

  private enterSuspension(generation: number, reason: PlaybackSuspensionReason): void {
    if (!this.isCurrentGeneration(generation)) {
      return
    }
    // Unbuffered blocked sources may be dead; keep the deadline.
    if (
      reason !== 'autoplay-blocked' ||
      this.machine.state !== 'warming' ||
      this.readyGeneration === generation
    ) {
      this.cancelSourceTimeout()
    }
    const previousSuspension = this.suspension
    const suspension: PlaybackSuspension = { reason, generation }
    this.suspension = suspension
    if (!this.transition('playback-suspended', generation)) {
      if (this.suspension === suspension) {
        this.suspension = previousSuspension
      }
      return
    }
    this.emitDiagnostic('playback-suspended', 'warn', undefined, { reason, generation })
    this.watchPageActivity(suspension)
  }

  private watchPageActivity(expectedSuspension: PlaybackSuspension): void {
    if (
      this.suspension !== expectedSuspension ||
      this.pageActivity === undefined ||
      this.unsubscribePageActivity !== null
    ) {
      return
    }
    const pageActivity = this.pageActivity
    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = pageActivity.subscribe((hidden) => {
        if (hidden || this.suspension === null) {
          return
        }
        this.retrySuspendedPlayFromPageActivity()
      })
      if (this.suspension !== expectedSuspension) {
        try {
          unsubscribe()
        } catch {
          this.unsubscribePageActivity = unsubscribe
          this.emitDiagnostic('page-activity-unsubscribe-failed', 'warn', this.machine.generation)
        }
        return
      }
      this.unsubscribePageActivity = unsubscribe
      const hidden = pageActivity.isHidden()
      if (this.suspension !== expectedSuspension) {
        this.releasePageActivitySubscription()
        return
      }
      if (!hidden) {
        this.retrySuspendedPlayFromPageActivity()
      }
    } catch {
      if (unsubscribe !== null) {
        try {
          unsubscribe()
          this.unsubscribePageActivity = null
        } catch {
          this.unsubscribePageActivity = unsubscribe
        }
      }
      this.emitDiagnostic('page-activity-subscribe-failed', 'warn', this.machine.generation)
    }
  }

  private retrySuspendedPlayFromPageActivity(): void {
    const suspension = this.suspension
    void this.retrySuspendedPlay().catch(() => {
      if (suspension === null || this.suspension !== suspension) {
        return
      }
      this.clearSuspension()
      if (!this.transition('playback-degraded', suspension.generation)) {
        return
      }
      this.emitDiagnostic('playback-resume-failed', 'warn', suspension.generation)
      this.scheduleRecovery('playback-error', 0, suspension.generation)
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
    let resumed = false
    const flight = this.adapter.play().then(
      () => {
        resumed = true
      },
      (error: unknown) => {
        const errorName = sanitizeErrorName(error)
        if (this.classifyPlayRejection(error, errorName) === null) {
          throw new SourceTransitionError('play', suspension.generation, errorName)
        }
      },
    )
    const trackedFlight = flight.finally(() => {
      if (this.resumeFlight === trackedFlight) {
        this.resumeFlight = null
      }
    })
    this.resumeFlight = trackedFlight
    await trackedFlight
    if (
      !resumed ||
      this.suspension !== suspension ||
      this.machine.state !== 'suspended' ||
      !this.isCurrentGeneration(suspension.generation)
    ) {
      return
    }
    this.clearPendingRecovery()
    this.cancelSourceTimeout()
    this.transition('playback-resumed', suspension.generation)
    this.scheduleMonitoring()
  }

  private clearSuspension(): void {
    this.suspension = null
    try {
      this.releasePageActivitySubscription()
    } catch {
      this.emitDiagnostic('page-activity-unsubscribe-failed', 'warn', this.machine.generation)
    }
  }

  private releasePageActivitySubscription(): void {
    if (this.unsubscribePageActivity !== null) {
      const unsubscribe = this.unsubscribePageActivity
      try {
        unsubscribe()
      } catch {
        throw new LiveFlowError(
          'page-activity-unsubscribe-failed',
          'Could not unsubscribe from page activity changes.',
        )
      }
      this.unsubscribePageActivity = null
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
    if (!this.listeners.has(listener) && this.listeners.size >= MAX_SNAPSHOT_LISTENERS) {
      throw new CapacityExceededError('continuity-snapshot-listeners', MAX_SNAPSHOT_LISTENERS)
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

    const flight = Promise.resolve().then(() => this.performDestroy())
    this.destroyPromise = flight
    void flight.then(
      () => {
        if (this.destroyPromise === flight) {
          this.destroyPromise = null
        }
      },
      () => {
        if (this.destroyPromise === flight) {
          this.destroyPromise = null
        }
      },
    )
    return flight
  }

  private async performDestroy(): Promise<void> {
    this.transition('destroyed', this.machine.generation)
    let cleanupFailed = false
    const attempt = (operation: () => void): void => {
      try {
        operation()
      } catch {
        cleanupFailed = true
      }
    }

    this.suspension = null
    attempt(() => {
      this.releasePageActivitySubscription()
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
    if (!this.adapterUnsubscribed) {
      attempt(() => {
        this.unsubscribeAdapter()
        this.adapterUnsubscribed = true
      })
    }
    this.listeners.clear()

    const warmingPrepared = this.warmingPrepared
    if (warmingPrepared !== null) {
      try {
        await this.discardPrepared(warmingPrepared, warmingPrepared.generation)
        if (this.warmingPrepared === warmingPrepared) {
          this.warmingPrepared = null
        }
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
      this.emitDiagnostic('stale-playback-event', 'debug', event.generation, {
        currentGeneration: this.machine.generation,
      })
      return
    }

    if (event.type === 'ready') {
      this.readyGeneration = event.generation
      if (this.machine.state === 'suspended') {
        this.cancelSourceTimeout()
      }
      return
    }

    if (event.type === 'first-frame') {
      const previousState = this.machine.state
      this.hardLatencySamples = 0
      this.transition('first-frame', event.generation)
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

    if (event.type === 'playing') {
      if (this.machine.state !== 'warming') {
        this.hardLatencySamples = 0
        this.clearPendingRecovery()
        this.transition('playback-resumed', event.generation)
        this.scheduleMonitoring()
      }
      return
    }

    const stalled = event.type === 'waiting' || event.type === 'stalled'
    if (stalled && (this.machine.state === 'resolving' || this.machine.state === 'warming')) {
      return
    }
    if (!stalled && event.type !== 'error' && event.type !== 'ended') {
      return
    }
    this.hardLatencySamples = 0
    if (!this.applyPlaybackRateSafely(1, true, event.generation)) {
      return
    }
    this.cancelMonitoring()
    if (
      !this.transition('playback-degraded', event.generation) &&
      this.machine.state === 'suspended'
    ) {
      return
    }

    if (stalled) {
      this.emitDiagnostic('stall-detected', 'info', event.generation)
      this.scheduleRecovery('stall', STALL_DEBOUNCE_MS, event.generation)
    } else if (event.type === 'error' && !event.recoverable) {
      this.transition('recovery-exhausted', event.generation)
      this.emitDiagnostic('nonrecoverable-playback-error', 'warn', event.generation)
    } else {
      this.scheduleRecovery('playback-error', 0, event.generation)
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

    this.emitDiagnostic('prepared-source-discarded', 'debug', generation)
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
      this.emitDiagnostic('prepared-source-cleanup-failed', 'warn', generation, {
        trigger,
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

  private transition(event: ContinuityMachineEvent, generation: number): boolean {
    const previous = this.machine
    const next = reduceContinuityState(this.machine, event, generation)
    if (next === previous) {
      return false
    }
    this.machine = next
    if (event !== 'destroyed' && next.state !== 'suspended' && this.suspension !== null) {
      this.clearSuspension()
    }
    if (this.machine !== next) {
      return true
    }

    if (this.machine.state === 'playing') {
      if (previous.state !== 'playing') {
        this.healthySince = this.clock.now()
      }
    } else {
      this.healthySince = null
    }
    if (this.listeners.size === 0) {
      return true
    }
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        continue
      }
    }
    return true
  }

  private ensureActive(): void {
    if (this.machine.state === 'stopped' || this.destroyPromise !== null) {
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
    }, METRICS_SAMPLE_INTERVAL_MS)
  }

  private cancelMonitoring(): void {
    if (this.monitorTimer === null) {
      return
    }

    const timer = this.monitorTimer
    this.clock.clearTimeout(timer)
    this.monitorTimer = null
  }

  private samplePlayback(): void {
    if (this.machine.state !== 'playing') {
      return
    }

    const generation = this.machine.generation
    let metrics: PlaybackMetrics
    let sampledAt: number
    try {
      metrics = this.adapter.getMetrics()
      sampledAt = this.clock.now()
      validatePlaybackMetrics(metrics, sampledAt)
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        return
      }
      if (!this.applyPlaybackRateSafely(1, true, generation)) {
        return
      }
      this.transition('playback-degraded', generation)
      if (!this.isCurrentGeneration(generation)) {
        return
      }
      this.emitDiagnostic(
        error instanceof InvalidPlaybackMetricsError
          ? 'invalid-playback-metrics'
          : 'metrics-sample-failed',
        'warn',
        generation,
      )
      this.scheduleRecovery('playback-error', 0, generation)
      return
    }
    if (!this.isCurrentGeneration(generation) || this.machine.state !== 'playing') {
      return
    }

    if (metrics.stalledSince !== null && sampledAt - metrics.stalledSince >= STALL_DEBOUNCE_MS) {
      // Reopening a source costs seconds; a stall the seek head can escape costs nothing.
      if (this.tryStallSeek(metrics, generation)) {
        return
      }
      if (!this.applyPlaybackRateSafely(1, true, generation)) {
        return
      }
      this.transition('playback-degraded', generation)
      if (!this.isCurrentGeneration(generation)) {
        return
      }
      this.emitDiagnostic('stall-detected', 'info', generation)
      this.scheduleRecovery('stall', 0, generation)
      return
    }

    if (metrics.liveEdgeDistanceSeconds > this.policy.maxPlausibleLiveEdgeSeconds) {
      // A broken timeline, not latency: catching up, seeking and reopening all fail to help.
      this.hardLatencySamples = 0
      this.applyPlaybackRateSafely(1, false, generation)
      this.emitDiagnostic('implausible-live-edge', 'warn', generation)
      return
    }

    if (metrics.liveEdgeDistanceSeconds >= this.policy.hardResyncThresholdSeconds) {
      this.hardLatencySamples += 1

      if (this.hardLatencySamples < HARD_LATENCY_CONFIRMATION_SAMPLES) {
        if (metrics.bufferedAheadSeconds >= MIN_CATCHUP_BUFFER_SECONDS) {
          this.applyPlaybackRateSafely(this.policy.catchupRate, false, generation)
        } else {
          this.applyPlaybackRateSafely(1, true, generation)
        }
        return
      }

      this.hardLatencySamples = 0
      if (!this.applyPlaybackRateSafely(1, true, generation)) {
        return
      }
      this.transition('playback-degraded', generation)
      this.scheduleRecovery('latency', 0, generation)
      return
    }

    this.hardLatencySamples = 0
    if (metrics.bufferedAheadSeconds < MIN_CATCHUP_BUFFER_SECONDS) {
      this.applyPlaybackRateSafely(1, true, generation)
      return
    }

    const catchupBoundary =
      this.policy.targetLatencySeconds + this.policy.softCatchupThresholdSeconds
    if (metrics.liveEdgeDistanceSeconds >= catchupBoundary) {
      this.applyPlaybackRateSafely(this.policy.catchupRate, false, generation)
      return
    }

    if (metrics.liveEdgeDistanceSeconds <= this.policy.targetLatencySeconds) {
      this.applyPlaybackRateSafely(1, false, generation)
    }
  }

  private applyPlaybackRateForSourceChange(): void {
    const generation = this.machine.generation
    try {
      this.applyPlaybackRate(1, true)
    } catch {
      this.transition('playback-degraded', generation)
      this.emitDiagnostic('playback-rate-update-failed', 'warn', generation)
      this.scheduleRecovery('playback-error', 0, generation)
      throw new LiveFlowError(
        'playback-rate-update-failed',
        'The player rejected a playback-rate update.',
      )
    }
  }

  private applyPlaybackRateSafely(rate: number, immediate: boolean, generation: number): boolean {
    try {
      this.applyPlaybackRate(rate, immediate)
      return this.isCurrentGeneration(generation)
    } catch {
      if (!this.isCurrentGeneration(generation)) {
        return false
      }
      this.cancelMonitoring()
      this.transition('playback-degraded', generation)
      if (!this.isCurrentGeneration(generation)) {
        return false
      }
      this.emitDiagnostic('playback-rate-update-failed', 'warn', generation)
      this.scheduleRecovery('playback-error', 0, generation)
      return false
    }
  }

  private applyPlaybackRate(rate: number, immediate: boolean): void {
    if (rate === this.appliedPlaybackRate) {
      return
    }

    if (this.lastPlaybackRateChangeAt !== null && !immediate) {
      const elapsed = this.clock.now() - this.lastPlaybackRateChangeAt
      if (elapsed < RATE_CHANGE_COOLDOWN_MS) {
        return
      }
    }

    const previousRate = this.appliedPlaybackRate
    this.adapter.setPlaybackRate(rate)
    this.appliedPlaybackRate = rate
    this.lastPlaybackRateChangeAt = this.clock.now()
    this.emitDiagnostic(
      rate > 1 ? 'catchup-started' : 'catchup-stopped',
      'info',
      this.machine.generation,
      {
        previousRate,
        rate,
      },
    )
  }

  private scheduleRecovery(
    reason: ContinuityRecoveryReason,
    delayMs: number,
    generation: number,
  ): void {
    if (!this.isCurrentGeneration(generation) || this.recoveryTimer !== null) {
      return
    }

    this.pendingRecoveryReason = reason
    this.recoveryTimer = this.clock.setTimeout(() => {
      this.recoveryTimer = null
      const pendingReason = this.pendingRecoveryReason
      this.pendingRecoveryReason = null
      if (pendingReason === null || !this.isCurrentGeneration(generation)) {
        return
      }
      const seekResult = this.seekPastStall(pendingReason, generation)
      if (seekResult === 'recovered') {
        return
      }
      if (seekResult === 'seeked') {
        this.scheduleRecovery(pendingReason, STALL_DEBOUNCE_MS, generation)
        return
      }
      this.requestRecovery(pendingReason, generation)
    }, delayMs)
  }

  // A resumed stream cancels this pending recovery on its own 'playing' event.
  private seekPastStall(reason: ContinuityRecoveryReason, generation: number): SeekRecoveryResult {
    if (!this.isCurrentGeneration(generation) || (reason !== 'stall' && reason !== 'latency')) {
      return 'failed'
    }
    let metrics: PlaybackMetrics
    try {
      metrics = this.adapter.getMetrics()
      validatePlaybackMetrics(metrics, this.clock.now())
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        return 'recovered'
      }
      this.emitDiagnostic(
        error instanceof InvalidPlaybackMetricsError
          ? 'invalid-playback-metrics'
          : 'metrics-sample-failed',
        'warn',
        generation,
      )
      return 'failed'
    }
    if (!this.isCurrentGeneration(generation)) {
      return 'recovered'
    }
    if (
      reason === 'latency' &&
      metrics.liveEdgeDistanceSeconds < this.policy.hardResyncThresholdSeconds
    ) {
      this.hardLatencySamples = 0
      this.transition('playback-resumed', generation)
      if (this.isCurrentGeneration(generation) && this.machine.state === 'playing') {
        this.scheduleMonitoring()
        return 'recovered'
      }
    }
    return this.tryStallSeek(metrics, generation) ? 'seeked' : 'failed'
  }

  private tryStallSeek(metrics: PlaybackMetrics, generation: number): boolean {
    if (!this.isCurrentGeneration(generation)) {
      return true
    }
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
      return !this.isCurrentGeneration(generation)
    }
    if (!this.isCurrentGeneration(generation)) {
      return true
    }
    this.emitDiagnostic('stall-seek', 'info', generation, {
      attempt: this.stallSeeks,
      stranded: typeof gap === 'number',
    })
    return true
  }

  private requestRecovery(reason: ContinuityRecoveryReason, generation: number): void {
    if (
      !this.isCurrentGeneration(generation) ||
      this.machine.state === 'playing' ||
      this.machine.state === 'resolving'
    ) {
      return
    }

    const now = this.clock.now()
    if (!this.isCurrentGeneration(generation)) {
      return
    }

    if (this.machine.automaticRecoveryCount >= this.policy.maxAutomaticRecoveries) {
      if (
        !this.transition('recovery-exhausted', generation) ||
        !this.isCurrentGeneration(generation)
      ) {
        return
      }
      this.emitDiagnostic('recovery-exhausted', 'warn', generation, {
        attempts: this.machine.automaticRecoveryCount,
      })
      return
    }

    if (this.lastRecoveryAt !== null) {
      const elapsed = now - this.lastRecoveryAt
      if (elapsed < this.policy.recoveryCooldownMs) {
        this.scheduleRecovery(reason, this.policy.recoveryCooldownMs - elapsed, generation)
        return
      }
    }

    const countBeforeRequest = this.machine.automaticRecoveryCount
    if (
      !this.transition('recovery-requested', generation) ||
      !this.isCurrentGeneration(generation) ||
      this.machine.state !== 'recovering'
    ) {
      return
    }
    this.lastRecoveryAt = now
    this.lastRecoveryGeneration = generation
    const counted = this.machine.automaticRecoveryCount > countBeforeRequest
    this.emitDiagnostic('recovery-requested', 'info', generation, {
      attempt: this.machine.automaticRecoveryCount,
      reason,
    })
    if (!this.isCurrentGeneration(generation) || this.machine.state !== 'recovering') {
      return
    }

    if (this.onRecoveryRequest === undefined) {
      this.transition('recovery-exhausted', generation)
      if (!this.isCurrentGeneration(generation)) {
        return
      }
      this.emitDiagnostic('recovery-listener-missing', 'warn', generation)
      return
    }

    // Count before delivery; the listener may cancel synchronously.
    if (counted) {
      this.outstandingRecoveries += 1
    }

    try {
      this.onRecoveryRequest({
        reason,
        generation,
        attempt: this.machine.automaticRecoveryCount,
      })
    } catch {
      if (counted) {
        this.outstandingRecoveries = Math.max(0, this.outstandingRecoveries - 1)
      }
      if (!this.isCurrentGeneration(generation)) {
        return
      }
      this.transition('recovery-exhausted', generation)
      this.emitDiagnostic('recovery-listener-failed', 'warn', generation)
      return
    }
  }

  private clearPendingRecovery(): void {
    if (this.recoveryTimer !== null) {
      const timer = this.recoveryTimer
      this.clock.clearTimeout(timer)
      this.recoveryTimer = null
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
      if (this.machine.state === 'suspended') {
        this.clearSuspension()
      } else if (this.machine.state !== 'resolving' && this.machine.state !== 'warming') {
        return
      }

      this.transition('playback-degraded', generation)
      this.requestRecovery('source-timeout', generation)
    }, this.policy.sourceWarmupTimeoutMs)
  }

  private cancelSourceTimeout(): void {
    if (this.sourceTimeoutTimer === null) {
      return
    }

    const timer = this.sourceTimeoutTimer
    this.clock.clearTimeout(timer)
    this.sourceTimeoutTimer = null
  }
}
