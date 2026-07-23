import { createSystemClock } from '../shared/clock.js';
import { CONTRACT_VERSION } from '../shared/contract.js';
import { createDiagnosticEmitter } from '../shared/diagnostic-emitter.js';
import { ContractVersionMismatchError } from '../shared/errors.js';
import { InvalidOverlayConfigurationError, OverlayCapacityError, OverlayCleanupError, OverlayDestroyedError, OverlayRenderError, OverlaySchedulingError, } from './errors.js';
import { createSafeOverlayRenderer } from './safe-renderer.js';
import { DEFAULT_OVERLAY_INSTANCE_STATE, mergeInstanceState, parseOverlayEvent, resolveOverlayLimits, validateInstanceId, validateInstanceState, validateRendererKind, } from './validation.js';
export function createOverlayEngine(options) {
    if (options.contractVersion !== CONTRACT_VERSION) {
        throw new ContractVersionMismatchError(CONTRACT_VERSION, options.contractVersion);
    }
    return new RealtimeOverlayEngine(options);
}
class RealtimeOverlayEngine {
    options;
    limits;
    clock;
    diagnostic;
    defaultRenderer;
    renderers = new Map();
    ownedRenderers = new Set();
    pending = [];
    active = new Map();
    dedupe = new Map();
    counters = {
        received: 0,
        accepted: 0,
        displayed: 0,
        fullDisplayed: 0,
        compactDisplayed: 0,
        deduped: 0,
        expired: 0,
        dropped: 0,
        budgetDenied: 0,
        renderFailed: 0,
    };
    registration;
    instanceState;
    nextCardId = 1;
    lastNow = null;
    destroyed = false;
    draining = false;
    constructor(options) {
        this.options = options;
        this.limits = resolveOverlayLimits(options.limits);
        this.clock = options.clock ?? createSystemClock();
        this.diagnostic = createDiagnosticEmitter(options, this.clock);
        validateInstanceId(options.instanceId, this.limits.maxKeyLength);
        this.instanceState = options.instanceState ?? DEFAULT_OVERLAY_INSTANCE_STATE;
        validateInstanceState(this.instanceState);
        if (options.defaultRenderer !== undefined) {
            this.defaultRenderer = options.defaultRenderer;
        }
        else if (options.container !== undefined) {
            const rendererOptions = options.assetResolver === undefined ? {} : { assetResolver: options.assetResolver };
            this.defaultRenderer = createSafeOverlayRenderer(options.container, rendererOptions);
        }
        else {
            throw new InvalidOverlayConfigurationError('defaultRenderer');
        }
        this.ownedRenderers.add(this.defaultRenderer);
        this.registration =
            options.coordinator === undefined
                ? null
                : options.coordinator.register({
                    instanceId: options.instanceId,
                    ...this.instanceState,
                });
    }
    submit(candidate) {
        this.ensureAlive();
        this.counters.received += 1;
        const now = this.now();
        const event = parseOverlayEvent(candidate, this.limits, now);
        this.expirePending(now);
        this.expireDedupe(now);
        if (now - event.receivedAt > this.limits.maxEventLifetimeMs) {
            this.counters.expired += 1;
            this.emitDiagnostic('overlay-event-expired', 'info');
            return { status: 'expired' };
        }
        const dedupeKey = this.dedupeKey(event);
        if (this.dedupe.has(dedupeKey)) {
            this.counters.deduped += 1;
            this.emitDiagnostic('overlay-event-deduped', 'debug');
            return { status: 'deduped' };
        }
        if (this.dedupe.size >= this.limits.maxDedupeEntries) {
            this.counters.dropped += 1;
            this.emitDiagnostic('overlay-event-dropped', 'warn', { reason: 'dedupe-capacity' });
            return { status: 'dropped' };
        }
        if (!this.enqueue(event)) {
            this.counters.dropped += 1;
            this.emitDiagnostic('overlay-event-dropped', 'warn', { reason: 'queue-overload' });
            return { status: 'dropped' };
        }
        this.dedupe.set(dedupeKey, { event, phase: 'pending' });
        this.counters.accepted += 1;
        this.drain();
        if ([...this.active.values()].some((card) => card.event === event)) {
            return { status: 'displayed' };
        }
        if (this.pending.includes(event)) {
            return { status: 'queued' };
        }
        return { status: 'dropped' };
    }
    registerRenderer(kind, renderer) {
        this.ensureAlive();
        validateRendererKind(kind, this.limits.maxKeyLength);
        if (this.renderers.has(kind)) {
            throw new InvalidOverlayConfigurationError('duplicateRendererKind');
        }
        const wouldAddOwnedRenderer = !this.ownedRenderers.has(renderer);
        if (this.renderers.size >= this.limits.maxRenderers ||
            (wouldAddOwnedRenderer && this.ownedRenderers.size - 1 >= this.limits.maxRenderers)) {
            throw new OverlayCapacityError('overlay-renderers', this.limits.maxRenderers);
        }
        this.renderers.set(kind, renderer);
        this.ownedRenderers.add(renderer);
        let destroyed = false;
        return {
            destroy: () => {
                if (destroyed) {
                    return;
                }
                destroyed = true;
                if (this.renderers.get(kind) === renderer) {
                    this.renderers.delete(kind);
                }
            },
        };
    }
    updateInstance(update) {
        this.ensureAlive();
        this.instanceState = mergeInstanceState(this.instanceState, update);
        this.registration?.update(update);
    }
    getMetrics() {
        return {
            ...this.counters,
            pendingDepth: this.pending.length,
            visible: this.active.size,
        };
    }
    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        let cleanupFailed = false;
        for (const card of [...this.active.values()]) {
            if (!this.cleanupCard(card)) {
                cleanupFailed = true;
            }
        }
        this.active.clear();
        this.pending.length = 0;
        this.dedupe.clear();
        for (const renderer of this.ownedRenderers) {
            try {
                renderer.destroy();
            }
            catch {
                cleanupFailed = true;
            }
        }
        this.renderers.clear();
        this.ownedRenderers.clear();
        try {
            this.registration?.destroy();
        }
        catch {
            cleanupFailed = true;
        }
        if (cleanupFailed) {
            const error = new OverlayCleanupError();
            this.reportError(error);
            throw error;
        }
    }
    enqueue(event) {
        if (this.pending.length < this.limits.maxPending) {
            this.pending.push(event);
            this.sortPending();
            return true;
        }
        const lowest = this.pending.at(-1);
        if (lowest === undefined || event.priority <= lowest.priority) {
            return false;
        }
        this.pending.pop();
        this.removePendingDedupe(lowest);
        this.counters.dropped += 1;
        this.emitDiagnostic('overlay-event-dropped', 'warn', { reason: 'priority-eviction' });
        this.pending.push(event);
        this.sortPending();
        return true;
    }
    sortPending() {
        this.pending.sort((left, right) => {
            if (left.priority !== right.priority) {
                return left.priority < right.priority ? 1 : -1;
            }
            if (left.receivedAt !== right.receivedAt) {
                return left.receivedAt < right.receivedAt ? -1 : 1;
            }
            return left.id.localeCompare(right.id);
        });
    }
    drain() {
        if (this.draining || this.destroyed) {
            return;
        }
        this.draining = true;
        try {
            while (this.active.size < this.limits.maxVisible && this.pending.length > 0) {
                const event = this.pending.shift();
                if (event === undefined) {
                    break;
                }
                const now = this.now();
                if (now - event.receivedAt > this.limits.maxEventLifetimeMs) {
                    this.removePendingDedupe(event);
                    this.counters.expired += 1;
                    this.emitDiagnostic('overlay-event-expired', 'info');
                    continue;
                }
                const grant = this.createGrant(event);
                if (grant.presentation === 'suppressed') {
                    grant.destroy();
                    this.removePendingDedupe(event);
                    this.counters.budgetDenied += 1;
                    this.counters.dropped += 1;
                    this.emitDiagnostic('overlay-budget-suppressed', 'info');
                    continue;
                }
                const renderer = this.renderers.get(event.kind) ?? this.defaultRenderer;
                let renderHandle;
                try {
                    renderHandle = renderer.render(event, grant.presentation);
                }
                catch {
                    grant.destroy();
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.counters.renderFailed += 1;
                    this.reportError(new OverlayRenderError(event.kind));
                    continue;
                }
                const cardId = this.nextCardId;
                this.nextCardId += 1;
                let timer;
                try {
                    timer = this.clock.setTimeout(() => {
                        this.finishCard(cardId);
                    }, event.durationMs);
                }
                catch {
                    this.cleanupUnscheduledCard(renderHandle, grant);
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                const card = {
                    id: cardId,
                    event,
                    renderer,
                    grant,
                    timer,
                    renderHandle,
                    unsubscribeGrant: () => { },
                };
                this.active.set(cardId, card);
                this.markDisplayed(event, now);
                this.counters.displayed += 1;
                if (grant.presentation === 'full') {
                    this.counters.fullDisplayed += 1;
                }
                else {
                    this.counters.compactDisplayed += 1;
                }
                try {
                    card.unsubscribeGrant = grant.subscribe((presentation) => {
                        this.onPresentationChanged(cardId, presentation);
                    });
                }
                catch {
                    this.finishCard(cardId);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                }
            }
        }
        finally {
            this.draining = false;
        }
    }
    createGrant(event) {
        if (this.options.coordinator === undefined) {
            return new LocalFullGrant();
        }
        return this.options.coordinator.request(this.options.instanceId, {
            priority: event.priority,
            highCost: event.nodes.some((node) => node.type === 'asset'),
        });
    }
    onPresentationChanged(cardId, presentation) {
        const card = this.active.get(cardId);
        if (card === undefined || this.destroyed) {
            return;
        }
        if (presentation === 'suppressed') {
            this.finishCard(cardId);
            return;
        }
        try {
            card.renderHandle.destroy();
            card.renderHandle = card.renderer.render(card.event, presentation);
            this.emitDiagnostic('overlay-presentation-changed', 'debug', { presentation });
        }
        catch {
            this.finishCard(cardId);
            this.counters.dropped += 1;
            this.counters.renderFailed += 1;
            this.reportError(new OverlayRenderError(card.event.kind));
        }
    }
    finishCard(cardId) {
        const card = this.active.get(cardId);
        if (card === undefined) {
            return;
        }
        this.active.delete(cardId);
        if (!this.cleanupCard(card)) {
            this.reportError(new OverlayCleanupError());
        }
        this.drain();
    }
    cleanupCard(card) {
        let successful = true;
        try {
            this.clock.clearTimeout(card.timer);
        }
        catch {
            successful = false;
        }
        try {
            card.unsubscribeGrant();
        }
        catch {
            successful = false;
        }
        try {
            card.renderHandle.destroy();
        }
        catch {
            successful = false;
        }
        try {
            card.grant.destroy();
        }
        catch {
            successful = false;
        }
        return successful;
    }
    cleanupUnscheduledCard(renderHandle, grant) {
        let cleanupFailed = false;
        try {
            renderHandle.destroy();
        }
        catch {
            cleanupFailed = true;
        }
        try {
            grant.destroy();
        }
        catch {
            cleanupFailed = true;
        }
        if (cleanupFailed) {
            this.reportError(new OverlayCleanupError());
        }
    }
    expirePending(now) {
        for (let index = this.pending.length - 1; index >= 0; index -= 1) {
            const event = this.pending[index];
            if (event !== undefined && now - event.receivedAt > this.limits.maxEventLifetimeMs) {
                this.pending.splice(index, 1);
                this.removePendingDedupe(event);
                this.counters.expired += 1;
                this.emitDiagnostic('overlay-event-expired', 'info');
            }
        }
    }
    expireDedupe(now) {
        for (const [key, entry] of this.dedupe) {
            if (entry.phase === 'displayed' &&
                entry.displayedAt !== undefined &&
                now - entry.displayedAt > this.limits.dedupeWindowMs) {
                this.dedupe.delete(key);
            }
        }
    }
    markDisplayed(event, displayedAt) {
        this.dedupe.set(this.dedupeKey(event), { event, phase: 'displayed', displayedAt });
    }
    removePendingDedupe(event) {
        const key = this.dedupeKey(event);
        const entry = this.dedupe.get(key);
        if (entry?.phase === 'pending' && entry.event === event) {
            this.dedupe.delete(key);
        }
    }
    dedupeKey(event) {
        return event.dedupeKey === undefined ? `id:${event.id}` : `key:${event.dedupeKey}`;
    }
    now() {
        const now = this.clock.now();
        if (!Number.isFinite(now) || now < 0 || (this.lastNow !== null && now < this.lastNow)) {
            throw new InvalidOverlayConfigurationError('clock');
        }
        this.lastNow = now;
        return now;
    }
    reportError(error) {
        const code = error instanceof OverlayRenderError
            ? 'overlay-render-failed'
            : error instanceof OverlaySchedulingError
                ? 'overlay-scheduling-failed'
                : 'overlay-cleanup-failed';
        this.emitDiagnostic(code, 'warn');
        if (this.options.onError === undefined) {
            return;
        }
        try {
            this.options.onError(error);
        }
        catch {
            return;
        }
    }
    emitDiagnostic(code, level, detail) {
        if (detail === undefined) {
            this.diagnostic.emit({ scope: 'overlay', code, level });
        }
        else {
            this.diagnostic.emit({ scope: 'overlay', code, level, detail });
        }
    }
    ensureAlive() {
        if (this.destroyed) {
            throw new OverlayDestroyedError('engine');
        }
    }
}
class LocalFullGrant {
    presentation = 'full';
    subscribe(_listener) {
        return () => { };
    }
    destroy() { }
}
