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
    cleanupCards = new Map();
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
        this.registration = null;
        if (options.coordinator !== undefined) {
            try {
                this.registration = options.coordinator.register({
                    instanceId: options.instanceId,
                    ...this.instanceState,
                });
            }
            catch {
                try {
                    this.defaultRenderer.destroy();
                    this.ownedRenderers.delete(this.defaultRenderer);
                }
                catch {
                    throw new OverlayCleanupError();
                }
                throw new InvalidOverlayConfigurationError('coordinator.register');
            }
        }
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
        let nextState;
        try {
            nextState = mergeInstanceState(this.instanceState, update);
        }
        catch (error) {
            throw normalizeInvalidInstanceStateError(error);
        }
        if (this.registration !== null) {
            try {
                this.registration.update(nextState);
            }
            catch {
                throw new InvalidOverlayConfigurationError('coordinator.update');
            }
        }
        this.instanceState = nextState;
    }
    getMetrics() {
        return {
            ...this.counters,
            pendingDepth: this.pending.length,
            visible: this.active.size,
        };
    }
    destroy() {
        if (this.destroyed &&
            this.active.size === 0 &&
            this.cleanupCards.size === 0 &&
            this.ownedRenderers.size === 0 &&
            this.registration === null) {
            return;
        }
        this.destroyed = true;
        let cleanupFailed = false;
        for (const [cardId, card] of this.active) {
            card.closing = true;
            if (this.cleanupCard(card)) {
                this.active.delete(cardId);
            }
        }
        for (const [cardId, card] of this.cleanupCards) {
            if (this.cleanupCard(card)) {
                this.cleanupCards.delete(cardId);
            }
        }
        this.pending.length = 0;
        this.dedupe.clear();
        this.renderers.clear();
        if (this.active.size === 0 && this.cleanupCards.size === 0 && !this.draining) {
            for (const renderer of [...this.ownedRenderers]) {
                try {
                    renderer.destroy();
                    this.ownedRenderers.delete(renderer);
                }
                catch {
                    cleanupFailed = true;
                }
            }
            if (this.registration !== null) {
                try {
                    this.registration.destroy();
                    this.registration = null;
                }
                catch {
                    cleanupFailed = true;
                }
            }
        }
        else if (this.active.size > 0 || this.cleanupCards.size > 0) {
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
            if (!this.retryFailedCleanup()) {
                return;
            }
            if (this.destroyed) {
                return;
            }
            let remainingWork = this.pending.length;
            while (!this.destroyed &&
                remainingWork > 0 &&
                this.cleanupCards.size === 0 &&
                !this.hasClosingCard() &&
                this.active.size < this.limits.maxVisible &&
                this.pending.length > 0) {
                remainingWork -= 1;
                const event = this.pending.shift();
                if (event === undefined) {
                    break;
                }
                const now = this.now();
                if (this.destroyed) {
                    return;
                }
                if (now - event.receivedAt > this.limits.maxEventLifetimeMs) {
                    this.removePendingDedupe(event);
                    this.counters.expired += 1;
                    this.emitDiagnostic('overlay-event-expired', 'info');
                    continue;
                }
                let grant = null;
                try {
                    grant = this.createGrant(event);
                }
                catch {
                    if (this.destroyed) {
                        return;
                    }
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                if (this.destroyed) {
                    this.cleanupDetachedCard(event, this.defaultRenderer, null, null, grant);
                    return;
                }
                let presentationCandidate;
                try {
                    presentationCandidate = grant.presentation;
                }
                catch {
                    this.cleanupDetachedCard(event, this.defaultRenderer, null, null, grant);
                    if (this.destroyed) {
                        return;
                    }
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                if (this.destroyed) {
                    this.cleanupDetachedCard(event, this.defaultRenderer, null, null, grant);
                    return;
                }
                if (!isOverlayPresentation(presentationCandidate)) {
                    this.cleanupDetachedCard(event, this.defaultRenderer, null, null, grant);
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                const presentation = presentationCandidate;
                if (presentation === 'suppressed') {
                    this.cleanupDetachedCard(event, this.defaultRenderer, null, null, grant);
                    this.removePendingDedupe(event);
                    this.counters.budgetDenied += 1;
                    this.counters.dropped += 1;
                    this.emitDiagnostic('overlay-budget-suppressed', 'info');
                    continue;
                }
                const renderer = this.renderers.get(event.kind) ?? this.defaultRenderer;
                let renderHandle;
                try {
                    renderHandle = renderer.render(event, presentation);
                }
                catch {
                    this.cleanupDetachedCard(event, renderer, null, null, grant);
                    if (this.destroyed) {
                        return;
                    }
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.counters.renderFailed += 1;
                    this.reportError(new OverlayRenderError(event.kind));
                    continue;
                }
                if (this.destroyed) {
                    this.cleanupDetachedCard(event, renderer, null, renderHandle, grant);
                    return;
                }
                const cardId = this.nextCardId;
                this.nextCardId += 1;
                let timer;
                try {
                    timer = this.clock.setTimeout(() => {
                        const current = this.active.get(cardId);
                        if (current !== undefined) {
                            current.timer = null;
                        }
                        this.finishCard(cardId);
                    }, event.durationMs);
                }
                catch {
                    this.cleanupDetachedCard(event, renderer, null, renderHandle, grant);
                    if (this.destroyed) {
                        return;
                    }
                    this.removePendingDedupe(event);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                if (this.destroyed) {
                    this.cleanupDetachedCard(event, renderer, timer, renderHandle, grant);
                    return;
                }
                const card = {
                    id: cardId,
                    event,
                    renderer,
                    grant,
                    timer,
                    renderHandle,
                    unsubscribeGrant: null,
                    closing: false,
                };
                this.active.set(cardId, card);
                this.markDisplayed(event, now);
                this.counters.displayed += 1;
                if (presentation === 'full') {
                    this.counters.fullDisplayed += 1;
                }
                else {
                    this.counters.compactDisplayed += 1;
                }
                let unsubscribeCandidate;
                try {
                    unsubscribeCandidate = grant.subscribe((presentation) => {
                        this.onPresentationChanged(cardId, presentation);
                    });
                }
                catch {
                    if (this.destroyed) {
                        this.cleanupReturnedCard(cardId, card);
                        return;
                    }
                    this.finishCard(cardId);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                if (isUnsubscribe(unsubscribeCandidate)) {
                    card.unsubscribeGrant = unsubscribeCandidate;
                }
                if (this.destroyed) {
                    this.cleanupReturnedCard(cardId, card);
                    return;
                }
                if (!isUnsubscribe(unsubscribeCandidate)) {
                    this.finishCard(cardId);
                    this.counters.dropped += 1;
                    this.reportError(new OverlaySchedulingError());
                    continue;
                }
                if (this.active.get(cardId) !== card) {
                    this.cleanupReturnedCard(cardId, card);
                }
            }
        }
        finally {
            this.draining = false;
            if (this.destroyed) {
                this.destroy();
            }
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
        if (card === undefined || card.closing || this.destroyed) {
            return;
        }
        if (!isOverlayPresentation(presentation)) {
            this.finishCard(cardId);
            this.counters.dropped += 1;
            this.reportError(new OverlaySchedulingError());
            return;
        }
        if (card.renderHandle === null) {
            return;
        }
        if (presentation === 'suppressed') {
            this.finishCard(cardId);
            return;
        }
        try {
            card.renderHandle.destroy();
            card.renderHandle = null;
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
        card.closing = true;
        if (this.cleanupCard(card)) {
            this.active.delete(cardId);
        }
        else {
            this.reportError(new OverlayCleanupError());
        }
        this.drain();
    }
    cleanupCard(card) {
        let successful = true;
        if (card.timer !== null) {
            try {
                this.clock.clearTimeout(card.timer);
                card.timer = null;
            }
            catch {
                successful = false;
            }
        }
        if (card.unsubscribeGrant !== null) {
            try {
                card.unsubscribeGrant();
                card.unsubscribeGrant = null;
            }
            catch {
                successful = false;
            }
        }
        if (card.renderHandle !== null) {
            try {
                card.renderHandle.destroy();
                card.renderHandle = null;
            }
            catch {
                successful = false;
            }
        }
        if (card.grant !== null) {
            try {
                card.grant.destroy();
                card.grant = null;
            }
            catch {
                successful = false;
            }
        }
        return successful;
    }
    cleanupDetachedCard(event, renderer, timer, renderHandle, grant) {
        const cardId = this.nextCardId;
        this.nextCardId += 1;
        const card = {
            id: cardId,
            event,
            renderer,
            grant,
            timer,
            renderHandle,
            unsubscribeGrant: null,
            closing: true,
        };
        if (!this.cleanupCard(card)) {
            this.cleanupCards.set(cardId, card);
            this.reportError(new OverlayCleanupError());
        }
    }
    cleanupReturnedCard(cardId, card) {
        card.closing = true;
        if (this.cleanupCard(card)) {
            this.active.delete(cardId);
            this.cleanupCards.delete(cardId);
            return;
        }
        if (this.active.get(cardId) !== card) {
            this.cleanupCards.set(cardId, card);
        }
        this.reportError(new OverlayCleanupError());
    }
    retryFailedCleanup() {
        let successful = true;
        for (const [cardId, card] of this.cleanupCards) {
            if (this.cleanupCard(card)) {
                this.cleanupCards.delete(cardId);
            }
            else {
                successful = false;
            }
        }
        for (const [cardId, card] of this.active) {
            if (!card.closing) {
                continue;
            }
            if (this.cleanupCard(card)) {
                this.active.delete(cardId);
            }
            else {
                successful = false;
            }
        }
        return successful;
    }
    hasClosingCard() {
        for (const card of this.active.values()) {
            if (card.closing) {
                return true;
            }
        }
        return false;
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
function normalizeInvalidInstanceStateError(error) {
    try {
        if (error instanceof InvalidOverlayConfigurationError) {
            return error;
        }
    }
    catch {
        return new InvalidOverlayConfigurationError('instanceState');
    }
    return new InvalidOverlayConfigurationError('instanceState');
}
function isUnsubscribe(value) {
    return typeof value === 'function';
}
function isOverlayPresentation(value) {
    return value === 'full' || value === 'compact' || value === 'suppressed';
}
