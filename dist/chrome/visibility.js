import { createSystemClock } from '../shared/clock.js';
import { CapacityExceededError } from '../shared/errors.js';
import { ChromeVisibilityDestroyedError, ChromeVisibilityPinUnderflowError, InvalidChromeVisibilityConfigurationError, } from './errors.js';
export const DEFAULT_CHROME_IDLE_HIDE_MS = 2_500;
const HIDDEN_SNAPSHOT = Object.freeze({ visible: false });
const VISIBLE_SNAPSHOT = Object.freeze({ visible: true });
export function createChromeVisibility(options = {}) {
    const idleHideMs = options.idleHideMs ?? DEFAULT_CHROME_IDLE_HIDE_MS;
    if (!Number.isFinite(idleHideMs) || idleHideMs <= 0) {
        throw new InvalidChromeVisibilityConfigurationError('idleHideMs');
    }
    return new DefaultChromeVisibilityController(options.clock ?? createSystemClock(), idleHideMs, options.hold ?? false);
}
class DefaultChromeVisibilityController {
    clock;
    idleHideMs;
    hold;
    static MAX_PIN_DEPTH = 32;
    static MAX_SNAPSHOT_LISTENERS = 32;
    listeners = new Set();
    destroyed = false;
    focusWithin = false;
    hideTimer = null;
    pinCount = 0;
    pointerInside = false;
    visible = false;
    constructor(clock, idleHideMs, hold) {
        this.clock = clock;
        this.idleHideMs = idleHideMs;
        this.hold = hold;
    }
    pointerEnter() {
        this.reveal();
    }
    pointerMove() {
        this.reveal();
    }
    pointerDown() {
        this.reveal();
    }
    pointerLeave() {
        this.ensureActive();
        this.pointerInside = false;
        if (this.pinCount > 0 || this.focusWithin) {
            return;
        }
        this.cancelHide();
        this.setVisible(false);
    }
    pin() {
        this.ensureActive();
        if (this.pinCount >= DefaultChromeVisibilityController.MAX_PIN_DEPTH) {
            throw new CapacityExceededError('chrome-visibility-pins', DefaultChromeVisibilityController.MAX_PIN_DEPTH);
        }
        this.pinCount += 1;
        this.cancelHide();
        this.setVisible(true);
    }
    unpin() {
        this.ensureActive();
        if (this.pinCount === 0) {
            throw new ChromeVisibilityPinUnderflowError();
        }
        this.pinCount -= 1;
        this.scheduleHide();
    }
    setFocusWithin(focused) {
        this.ensureActive();
        this.focusWithin = focused;
        if (focused) {
            this.cancelHide();
            this.setVisible(true);
            return;
        }
        this.scheduleHide();
    }
    setHold(hold) {
        this.ensureActive();
        this.hold = hold;
        if (hold) {
            if (this.pointerInside) {
                this.cancelHide();
            }
            return;
        }
        this.scheduleHide();
    }
    getSnapshot() {
        return this.visible ? VISIBLE_SNAPSHOT : HIDDEN_SNAPSHOT;
    }
    subscribe(listener) {
        this.ensureActive();
        if (!this.listeners.has(listener) &&
            this.listeners.size >= DefaultChromeVisibilityController.MAX_SNAPSHOT_LISTENERS) {
            throw new CapacityExceededError('chrome-visibility-snapshot-listeners', DefaultChromeVisibilityController.MAX_SNAPSHOT_LISTENERS);
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.cancelHide();
        this.focusWithin = false;
        this.hold = false;
        this.pinCount = 0;
        this.pointerInside = false;
        this.setVisible(false);
        this.listeners.clear();
    }
    reveal() {
        this.ensureActive();
        this.pointerInside = true;
        this.setVisible(true);
        this.scheduleHide();
    }
    setVisible(next) {
        if (this.visible === next) {
            return;
        }
        this.visible = next;
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
    scheduleHide() {
        this.cancelHide();
        if (!this.visible || this.isHeld()) {
            return;
        }
        this.hideTimer = this.clock.setTimeout(() => {
            this.hideTimer = null;
            if (this.isHeld()) {
                return;
            }
            this.setVisible(false);
        }, this.idleHideMs);
    }
    cancelHide() {
        if (this.hideTimer === null) {
            return;
        }
        const timer = this.hideTimer;
        this.hideTimer = null;
        this.clock.clearTimeout(timer);
    }
    isHeld() {
        return this.pinCount > 0 || this.focusWithin || (this.hold && this.pointerInside);
    }
    ensureActive() {
        if (this.destroyed) {
            throw new ChromeVisibilityDestroyedError();
        }
    }
}
