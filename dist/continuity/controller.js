import { createSystemClock } from '../shared/clock.js';
import { CONTRACT_VERSION } from '../shared/contract.js';
import { createDiagnosticEmitter } from '../shared/diagnostic-emitter.js';
import { CapacityExceededError, ContractVersionMismatchError, InvalidPlaybackMetricsError, LiveFlowError, PreparedSourceGenerationMismatchError, sanitizeErrorName, SourceTransitionError, } from '../shared/errors.js';
import { validatePlaybackMetrics } from './metrics.js';
import { resolveContinuityPolicy } from './policy.js';
import { INITIAL_CONTINUITY_STATE, reduceContinuityState, } from './state-machine.js';
export function createContinuityController(options) {
    if (options.contractVersion !== CONTRACT_VERSION) {
        throw new ContractVersionMismatchError(CONTRACT_VERSION, options.contractVersion);
    }
    const clock = options.clock ?? createSystemClock();
    return new DefaultContinuityController(options.adapter, clock, resolveContinuityPolicy(options.policy), options.onRecoveryRequest, createDiagnosticEmitter(options, clock), options.pageActivity);
}
class DefaultContinuityController {
    adapter;
    clock;
    policy;
    onRecoveryRequest;
    diagnostics;
    pageActivity;
    static HARD_LATENCY_CONFIRMATION_SAMPLES = 4;
    static MAX_SNAPSHOT_LISTENERS = 32;
    static METRICS_SAMPLE_INTERVAL_MS = 500;
    static MIN_CATCHUP_BUFFER_SECONDS = 1;
    static RATE_CHANGE_COOLDOWN_MS = 1_000;
    static STALL_DEBOUNCE_MS = 400;
    machine = INITIAL_CONTINUITY_STATE;
    listeners = new Set();
    unsubscribeAdapter;
    destroyPromise = null;
    monitorTimer = null;
    recoveryTimer = null;
    sourceTimeoutTimer = null;
    pendingRecoveryReason = null;
    warmingPrepared = null;
    lastRecoveryAt = null;
    lastRecoveryGeneration = null;
    hardLatencySamples = 0;
    stallSeeks = 0;
    outstandingRecoveries = 0;
    appliedPlaybackRate = 1;
    lastPlaybackRateChangeAt = null;
    healthySince = null;
    suspension = null;
    unsubscribePageActivity = null;
    resumeFlight = null;
    constructor(adapter, clock, policy, onRecoveryRequest, diagnostics, pageActivity) {
        this.adapter = adapter;
        this.clock = clock;
        this.policy = policy;
        this.onRecoveryRequest = onRecoveryRequest;
        this.diagnostics = diagnostics;
        this.pageActivity = pageActivity;
        this.unsubscribeAdapter = this.adapter.subscribe((event) => {
            this.handlePlaybackEvent(event);
        });
    }
    async setSource(source) {
        this.ensureActive();
        const supersededPrepared = this.takeWarmingPrepared();
        if (supersededPrepared !== null) {
            void this.discardAfterTransitionFailure(supersededPrepared, supersededPrepared.generation, 'superseded');
        }
        this.cancelMonitoring();
        this.clearPendingRecovery();
        this.cancelSourceTimeout();
        this.hardLatencySamples = 0;
        this.stallSeeks = 0;
        this.outstandingRecoveries = 0;
        this.applyPlaybackRateForSourceChange();
        const generation = this.machine.generation + 1;
        this.transition({ type: 'source-requested', generation });
        this.scheduleSourceTimeout(generation);
        let prepared;
        try {
            prepared = await this.adapter.prepare(source, generation);
        }
        catch (error) {
            if (this.isCurrentGeneration(generation)) {
                this.cancelSourceTimeout();
            }
            this.transition({ type: 'source-failed', generation });
            throw new SourceTransitionError('prepare', generation, sanitizeErrorName(error));
        }
        if (prepared.generation !== generation) {
            await this.discardPrepared(prepared, generation);
            if (this.isCurrentGeneration(generation)) {
                this.cancelSourceTimeout();
            }
            this.transition({ type: 'source-failed', generation });
            throw new PreparedSourceGenerationMismatchError(generation, prepared.generation);
        }
        if (!this.isCurrentGeneration(generation) || this.machine.state !== 'resolving') {
            await this.discardPrepared(prepared, generation);
            return;
        }
        this.warmingPrepared = prepared;
        this.transition({ type: 'source-prepared', generation });
        try {
            await this.adapter.commit(prepared, generation);
        }
        catch (error) {
            if (this.isCurrentGeneration(generation)) {
                this.cancelSourceTimeout();
            }
            this.transition({ type: 'source-failed', generation });
            const failedPrepared = this.takeWarmingPrepared(generation);
            if (failedPrepared !== null) {
                await this.discardAfterTransitionFailure(failedPrepared, generation, 'commit');
            }
            throw new SourceTransitionError('commit', generation, sanitizeErrorName(error));
        }
        if (!this.isPreparedSourceUsable(generation)) {
            await this.discardTrackedPrepared(prepared, generation);
            return;
        }
        if (this.hasStartedPlayback(generation)) {
            return;
        }
        try {
            await this.adapter.play();
        }
        catch (error) {
            const reason = this.classifyPlayRejection(error);
            if (reason !== null) {
                this.enterSuspension(generation, reason);
                return;
            }
            if (this.isCurrentGeneration(generation)) {
                this.cancelSourceTimeout();
            }
            this.transition({ type: 'source-failed', generation });
            const failedPrepared = this.takeWarmingPrepared(generation);
            if (failedPrepared !== null) {
                await this.discardAfterTransitionFailure(failedPrepared, generation, 'play');
            }
            throw new SourceTransitionError('play', generation, sanitizeErrorName(error));
        }
        if (!this.isPreparedSourceUsable(generation)) {
            await this.discardTrackedPrepared(prepared, generation);
        }
    }
    async resume() {
        this.ensureActive();
        if (this.suspension === null) {
            return;
        }
        await this.retrySuspendedPlay();
    }
    cancelRecovery(generation) {
        if (!this.isCurrentGeneration(generation)) {
            return;
        }
        this.clearPendingRecovery();
        if (this.outstandingRecoveries === 0) {
            return;
        }
        this.outstandingRecoveries -= 1;
        this.lastRecoveryAt = null;
        this.lastRecoveryGeneration = null;
        this.transition({ type: 'recovery-cancelled', generation });
        this.diagnostics.emit({
            scope: 'continuity',
            code: 'recovery-cancelled',
            level: 'info',
            generation,
            detail: {
                attempts: this.machine.automaticRecoveryCount,
            },
        });
    }
    classifyPlayRejection(error) {
        if (!(error instanceof Error)) {
            return null;
        }
        if (error.name === 'NotAllowedError') {
            return 'autoplay-blocked';
        }
        if (error.name === 'AbortError') {
            return 'browser-suspended';
        }
        return null;
    }
    enterSuspension(generation, reason) {
        if (!this.isCurrentGeneration(generation)) {
            return;
        }
        this.cancelSourceTimeout();
        this.suspension = { reason, generation };
        this.diagnostics.emit({
            scope: 'continuity',
            code: 'playback-suspended',
            level: 'warn',
            detail: { reason, generation },
        });
        this.transition({ type: 'playback-suspended', generation });
        this.watchPageActivity();
    }
    watchPageActivity() {
        if (this.pageActivity === undefined || this.unsubscribePageActivity !== null) {
            return;
        }
        this.unsubscribePageActivity = this.pageActivity.subscribe((hidden) => {
            if (hidden || this.suspension === null) {
                return;
            }
            void this.retrySuspendedPlay();
        });
    }
    async retrySuspendedPlay() {
        const suspension = this.suspension;
        if (suspension === null || this.destroyPromise !== null) {
            return;
        }
        if (!this.isCurrentGeneration(suspension.generation)) {
            this.clearSuspension();
            return;
        }
        if (this.resumeFlight !== null) {
            await this.resumeFlight;
            return;
        }
        const flight = this.adapter
            .play()
            .then(() => {
            this.clearSuspension();
            this.transition({ type: 'playback-resumed', generation: suspension.generation });
        })
            .catch(() => {
        })
            .finally(() => {
            if (this.resumeFlight === flight) {
                this.resumeFlight = null;
            }
        });
        this.resumeFlight = flight;
        await flight;
    }
    clearSuspension() {
        this.suspension = null;
        if (this.unsubscribePageActivity !== null) {
            const unsubscribe = this.unsubscribePageActivity;
            this.unsubscribePageActivity = null;
            unsubscribe();
        }
    }
    getSnapshot() {
        return {
            state: this.machine.state,
            generation: this.machine.generation,
            automaticRecoveryCount: this.machine.automaticRecoveryCount,
            healthySince: this.healthySince,
            suspension: this.suspension,
        };
    }
    subscribe(listener) {
        this.ensureActive();
        if (!this.listeners.has(listener) &&
            this.listeners.size >= DefaultContinuityController.MAX_SNAPSHOT_LISTENERS) {
            throw new CapacityExceededError('continuity-snapshot-listeners', DefaultContinuityController.MAX_SNAPSHOT_LISTENERS);
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    destroy() {
        if (this.destroyPromise !== null) {
            return this.destroyPromise;
        }
        this.destroyPromise = this.performDestroy();
        return this.destroyPromise;
    }
    async performDestroy() {
        this.transition({ type: 'destroyed' });
        let cleanupFailed = false;
        const attempt = (operation) => {
            try {
                operation();
            }
            catch {
                cleanupFailed = true;
            }
        };
        attempt(() => {
            this.clearSuspension();
        });
        attempt(() => {
            this.cancelMonitoring();
        });
        attempt(() => {
            this.clearPendingRecovery();
        });
        attempt(() => {
            this.cancelSourceTimeout();
        });
        attempt(() => {
            this.applyPlaybackRate(1, true);
        });
        attempt(() => {
            this.unsubscribeAdapter();
        });
        this.listeners.clear();
        const warmingPrepared = this.takeWarmingPrepared();
        if (warmingPrepared !== null) {
            try {
                await this.discardPrepared(warmingPrepared, warmingPrepared.generation);
            }
            catch {
                cleanupFailed = true;
            }
        }
        try {
            await this.adapter.destroy();
        }
        catch {
            cleanupFailed = true;
        }
        if (cleanupFailed) {
            throw new LiveFlowError('controller-cleanup-failed', 'The continuity controller could not release every adapter resource cleanly.');
        }
    }
    handlePlaybackEvent(event) {
        if (!this.isCurrentGeneration(event.generation)) {
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'stale-playback-event',
                level: 'debug',
                generation: event.generation,
                detail: {
                    currentGeneration: this.machine.generation,
                },
            });
            return;
        }
        if (event.type === 'first-frame') {
            const previousState = this.machine.state;
            this.hardLatencySamples = 0;
            this.transition({ type: 'first-frame', generation: event.generation });
            if (previousState !== this.machine.state && this.machine.state === 'playing') {
                if (this.lastRecoveryGeneration !== null &&
                    event.generation > this.lastRecoveryGeneration) {
                    this.lastRecoveryAt = null;
                    this.lastRecoveryGeneration = null;
                }
                this.takeWarmingPrepared(event.generation);
                this.cancelSourceTimeout();
                this.scheduleMonitoring();
            }
            return;
        }
        if (event.type === 'waiting' || event.type === 'stalled') {
            if (this.machine.state === 'resolving' || this.machine.state === 'warming') {
                return;
            }
            this.hardLatencySamples = 0;
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            this.cancelMonitoring();
            this.transition({ type: 'playback-degraded', generation: event.generation });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'stall-detected',
                level: 'info',
                generation: event.generation,
            });
            this.scheduleRecovery('stall', DefaultContinuityController.STALL_DEBOUNCE_MS);
            return;
        }
        if (event.type === 'error') {
            this.hardLatencySamples = 0;
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            this.cancelMonitoring();
            this.transition({ type: 'playback-degraded', generation: event.generation });
            if (event.recoverable) {
                this.scheduleRecovery('playback-error', 0);
            }
            else {
                this.transition({
                    type: 'recovery-exhausted',
                    generation: event.generation,
                });
                this.diagnostics.emit({
                    scope: 'continuity',
                    code: 'nonrecoverable-playback-error',
                    level: 'warn',
                    generation: event.generation,
                });
            }
            return;
        }
        if (event.type === 'ended') {
            this.hardLatencySamples = 0;
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            this.cancelMonitoring();
            this.transition({ type: 'playback-degraded', generation: event.generation });
            this.scheduleRecovery('playback-error', 0);
            return;
        }
        if (event.type === 'playing' && this.machine.state !== 'warming') {
            this.hardLatencySamples = 0;
            this.clearPendingRecovery();
            this.transition({ type: 'playback-resumed', generation: event.generation });
            this.scheduleMonitoring();
        }
    }
    isCurrentGeneration(generation) {
        return this.machine.state !== 'stopped' && generation === this.machine.generation;
    }
    isPreparedSourceUsable(generation) {
        return (this.isCurrentGeneration(generation) &&
            (this.machine.state === 'warming' || this.machine.state === 'playing'));
    }
    hasStartedPlayback(generation) {
        return this.isCurrentGeneration(generation) && this.machine.state === 'playing';
    }
    async discardPrepared(prepared, generation) {
        try {
            await this.adapter.discard(prepared);
        }
        catch (error) {
            throw new SourceTransitionError('discard', generation, sanitizeErrorName(error));
        }
        this.diagnostics.emit({
            scope: 'continuity',
            code: 'prepared-source-discarded',
            level: 'debug',
            generation,
        });
    }
    async discardTrackedPrepared(prepared, generation) {
        if (this.warmingPrepared !== prepared) {
            return;
        }
        this.warmingPrepared = null;
        await this.discardPrepared(prepared, generation);
    }
    async discardAfterTransitionFailure(prepared, generation, trigger) {
        try {
            await this.discardPrepared(prepared, generation);
        }
        catch {
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'prepared-source-cleanup-failed',
                level: 'warn',
                generation,
                detail: {
                    trigger,
                },
            });
        }
    }
    takeWarmingPrepared(generation) {
        const prepared = this.warmingPrepared;
        if (prepared === null || (generation !== undefined && prepared.generation !== generation)) {
            return null;
        }
        this.warmingPrepared = null;
        return prepared;
    }
    transition(event) {
        const previous = this.machine;
        this.machine = reduceContinuityState(this.machine, event);
        if (this.machine === previous) {
            return;
        }
        if (this.machine.state === 'playing') {
            if (previous.state !== 'playing') {
                this.healthySince = this.clock.now();
            }
        }
        else {
            this.healthySince = null;
        }
        if (this.machine.state !== 'suspended' && this.suspension !== null) {
            this.clearSuspension();
        }
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            }
            catch {
                continue;
            }
        }
    }
    ensureActive() {
        if (this.machine.state === 'stopped') {
            throw new LiveFlowError('controller-destroyed', 'The continuity controller is destroyed.');
        }
    }
    scheduleMonitoring() {
        if (this.monitorTimer !== null || this.machine.state !== 'playing') {
            return;
        }
        this.monitorTimer = this.clock.setTimeout(() => {
            this.monitorTimer = null;
            this.samplePlayback();
            this.scheduleMonitoring();
        }, DefaultContinuityController.METRICS_SAMPLE_INTERVAL_MS);
    }
    cancelMonitoring() {
        if (this.monitorTimer === null) {
            return;
        }
        const timer = this.monitorTimer;
        this.monitorTimer = null;
        this.clock.clearTimeout(timer);
    }
    samplePlayback() {
        if (this.machine.state !== 'playing') {
            return;
        }
        let metrics;
        try {
            metrics = this.adapter.getMetrics();
            validatePlaybackMetrics(metrics, this.clock.now());
        }
        catch (error) {
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            this.transition({
                type: 'playback-degraded',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: error instanceof InvalidPlaybackMetricsError
                    ? 'invalid-playback-metrics'
                    : 'metrics-sample-failed',
                level: 'warn',
                generation: this.machine.generation,
            });
            this.scheduleRecovery('playback-error', 0);
            return;
        }
        const catchupBoundary = this.policy.targetLatencySeconds + this.policy.softCatchupThresholdSeconds;
        if (metrics.stalledSince !== null &&
            this.clock.now() - metrics.stalledSince >= DefaultContinuityController.STALL_DEBOUNCE_MS) {
            if (this.tryStallSeek(metrics)) {
                return;
            }
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            this.transition({
                type: 'playback-degraded',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'stall-detected',
                level: 'info',
                generation: this.machine.generation,
            });
            this.scheduleRecovery('stall', 0);
            return;
        }
        if (metrics.liveEdgeDistanceSeconds > this.policy.maxPlausibleLiveEdgeSeconds) {
            this.hardLatencySamples = 0;
            this.applyPlaybackRateSafely(1, false);
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'implausible-live-edge',
                level: 'warn',
                generation: this.machine.generation,
            });
            return;
        }
        if (metrics.liveEdgeDistanceSeconds >= this.policy.hardResyncThresholdSeconds) {
            this.hardLatencySamples = Math.min(this.hardLatencySamples + 1, DefaultContinuityController.HARD_LATENCY_CONFIRMATION_SAMPLES);
            if (this.hardLatencySamples < DefaultContinuityController.HARD_LATENCY_CONFIRMATION_SAMPLES) {
                if (metrics.bufferedAheadSeconds >= DefaultContinuityController.MIN_CATCHUP_BUFFER_SECONDS) {
                    if (!this.applyPlaybackRateSafely(this.policy.catchupRate, false)) {
                        return;
                    }
                }
                else {
                    if (!this.applyPlaybackRateSafely(1, true)) {
                        return;
                    }
                }
                return;
            }
            this.hardLatencySamples = 0;
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            this.transition({
                type: 'playback-degraded',
                generation: this.machine.generation,
            });
            this.requestRecovery('latency');
            return;
        }
        if (metrics.bufferedAheadSeconds < DefaultContinuityController.MIN_CATCHUP_BUFFER_SECONDS) {
            this.hardLatencySamples = 0;
            if (!this.applyPlaybackRateSafely(1, true)) {
                return;
            }
            return;
        }
        this.hardLatencySamples = 0;
        if (metrics.liveEdgeDistanceSeconds >= catchupBoundary &&
            metrics.liveEdgeDistanceSeconds < this.policy.hardResyncThresholdSeconds &&
            metrics.bufferedAheadSeconds > 0) {
            this.applyPlaybackRateSafely(this.policy.catchupRate, false);
            return;
        }
        if (metrics.liveEdgeDistanceSeconds <= this.policy.targetLatencySeconds) {
            this.applyPlaybackRateSafely(1, false);
        }
    }
    applyPlaybackRateForSourceChange() {
        try {
            this.applyPlaybackRate(1, true);
        }
        catch {
            this.transition({
                type: 'playback-degraded',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'playback-rate-update-failed',
                level: 'warn',
                generation: this.machine.generation,
            });
            this.scheduleRecovery('playback-error', 0);
            throw new LiveFlowError('playback-rate-update-failed', 'The player rejected a playback-rate update.');
        }
    }
    applyPlaybackRateSafely(rate, immediate) {
        try {
            this.applyPlaybackRate(rate, immediate);
            return true;
        }
        catch {
            this.cancelMonitoring();
            this.transition({
                type: 'playback-degraded',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'playback-rate-update-failed',
                level: 'warn',
                generation: this.machine.generation,
            });
            this.scheduleRecovery('playback-error', 0);
            return false;
        }
    }
    applyPlaybackRate(rate, immediate) {
        if (rate === this.appliedPlaybackRate) {
            return;
        }
        if (this.lastPlaybackRateChangeAt !== null && !immediate) {
            const elapsed = this.clock.now() - this.lastPlaybackRateChangeAt;
            if (elapsed < DefaultContinuityController.RATE_CHANGE_COOLDOWN_MS) {
                return;
            }
        }
        const previousRate = this.appliedPlaybackRate;
        this.adapter.setPlaybackRate(rate);
        this.appliedPlaybackRate = rate;
        this.lastPlaybackRateChangeAt = this.clock.now();
        this.diagnostics.emit({
            scope: 'continuity',
            code: rate > 1 ? 'catchup-started' : 'catchup-stopped',
            level: 'info',
            generation: this.machine.generation,
            detail: {
                previousRate,
                rate,
            },
        });
    }
    scheduleRecovery(reason, delayMs) {
        if (this.recoveryTimer !== null) {
            return;
        }
        this.pendingRecoveryReason = reason;
        this.recoveryTimer = this.clock.setTimeout(() => {
            this.recoveryTimer = null;
            const pendingReason = this.pendingRecoveryReason;
            this.pendingRecoveryReason = null;
            if (pendingReason === null) {
                return;
            }
            if (this.seekPastStall(pendingReason)) {
                this.scheduleRecovery(pendingReason, DefaultContinuityController.STALL_DEBOUNCE_MS);
                return;
            }
            this.requestRecovery(pendingReason);
        }, delayMs);
    }
    seekPastStall(reason) {
        if (reason !== 'stall' && reason !== 'latency') {
            return false;
        }
        let metrics;
        try {
            metrics = this.adapter.getMetrics();
        }
        catch {
            return false;
        }
        return this.tryStallSeek(metrics);
    }
    tryStallSeek(metrics) {
        const seek = this.adapter.seek?.bind(this.adapter);
        if (seek === undefined || this.stallSeeks >= this.policy.maxStallSeeksPerSource) {
            return false;
        }
        const gap = metrics.strandedGapSeconds;
        let target;
        if (typeof gap === 'number') {
            if (gap <= 0 || gap > this.policy.maxGapJumpSeconds)
                return false;
            target = metrics.currentTimeSeconds + gap + this.policy.stallNudgeSeconds;
        }
        else if (metrics.bufferedAheadSeconds > this.policy.stallNudgeSeconds) {
            target = metrics.currentTimeSeconds + this.policy.stallNudgeSeconds;
        }
        else {
            return false;
        }
        this.stallSeeks += 1;
        try {
            seek(target);
        }
        catch {
            return false;
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
        });
        return true;
    }
    requestRecovery(reason) {
        if (this.machine.state === 'stopped' || this.machine.state === 'playing') {
            return;
        }
        if (this.machine.automaticRecoveryCount >= this.policy.maxAutomaticRecoveries) {
            this.transition({
                type: 'recovery-exhausted',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'recovery-exhausted',
                level: 'warn',
                generation: this.machine.generation,
                detail: {
                    attempts: this.machine.automaticRecoveryCount,
                },
            });
            return;
        }
        if (this.lastRecoveryAt !== null) {
            const elapsed = this.clock.now() - this.lastRecoveryAt;
            if (elapsed < this.policy.recoveryCooldownMs) {
                this.scheduleRecovery(reason, this.policy.recoveryCooldownMs - elapsed);
                return;
            }
        }
        this.lastRecoveryAt = this.clock.now();
        this.lastRecoveryGeneration = this.machine.generation;
        const countBeforeRequest = this.machine.automaticRecoveryCount;
        this.transition({
            type: 'recovery-requested',
            generation: this.machine.generation,
        });
        const counted = this.machine.automaticRecoveryCount > countBeforeRequest;
        this.diagnostics.emit({
            scope: 'continuity',
            code: 'recovery-requested',
            level: 'info',
            generation: this.machine.generation,
            detail: {
                attempt: this.machine.automaticRecoveryCount,
                reason,
            },
        });
        if (this.onRecoveryRequest === undefined) {
            this.transition({
                type: 'recovery-exhausted',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'recovery-listener-missing',
                level: 'warn',
                generation: this.machine.generation,
            });
            return;
        }
        if (counted) {
            this.outstandingRecoveries += 1;
        }
        try {
            this.onRecoveryRequest({
                reason,
                generation: this.machine.generation,
                attempt: this.machine.automaticRecoveryCount,
            });
        }
        catch {
            if (counted) {
                this.outstandingRecoveries = Math.max(0, this.outstandingRecoveries - 1);
            }
            this.transition({
                type: 'recovery-exhausted',
                generation: this.machine.generation,
            });
            this.diagnostics.emit({
                scope: 'continuity',
                code: 'recovery-listener-failed',
                level: 'warn',
                generation: this.machine.generation,
            });
            return;
        }
    }
    clearPendingRecovery() {
        if (this.recoveryTimer !== null) {
            const timer = this.recoveryTimer;
            this.recoveryTimer = null;
            this.clock.clearTimeout(timer);
        }
        this.pendingRecoveryReason = null;
    }
    scheduleSourceTimeout(generation) {
        if ((this.machine.state !== 'resolving' && this.machine.state !== 'warming') ||
            this.sourceTimeoutTimer !== null) {
            return;
        }
        this.sourceTimeoutTimer = this.clock.setTimeout(() => {
            this.sourceTimeoutTimer = null;
            if (!this.isCurrentGeneration(generation) ||
                (this.machine.state !== 'resolving' && this.machine.state !== 'warming')) {
                return;
            }
            this.transition({
                type: 'playback-degraded',
                generation,
            });
            const timedOutPrepared = this.takeWarmingPrepared(generation);
            if (timedOutPrepared !== null) {
                void this.discardAfterTransitionFailure(timedOutPrepared, generation, 'source-timeout');
            }
            this.requestRecovery('source-timeout');
        }, this.policy.sourceWarmupTimeoutMs);
    }
    cancelSourceTimeout() {
        if (this.sourceTimeoutTimer === null) {
            return;
        }
        const timer = this.sourceTimeoutTimer;
        this.sourceTimeoutTimer = null;
        this.clock.clearTimeout(timer);
    }
}
