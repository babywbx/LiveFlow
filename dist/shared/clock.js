import { CapacityExceededError } from './errors.js';
function systemTimers(frames) {
    const maxActiveHandles = 256;
    const timers = new Map();
    let nextHandle = 1;
    function allocateHandle() {
        if (timers.size + (frames?.size ?? 0) >= maxActiveHandles) {
            throw new CapacityExceededError('system-clock-handles', maxActiveHandles);
        }
        return nextHandle++;
    }
    const clock = {
        now() {
            return globalThis.performance.now();
        },
        setTimeout(handler, delayMs) {
            const handle = allocateHandle();
            const nativeHandle = globalThis.setTimeout(() => {
                timers.delete(handle);
                handler();
            }, delayMs);
            timers.set(handle, nativeHandle);
            return handle;
        },
        clearTimeout(handle) {
            const nativeHandle = timers.get(handle);
            if (nativeHandle !== undefined) {
                globalThis.clearTimeout(nativeHandle);
                timers.delete(handle);
            }
        },
    };
    return { clock, allocateHandle };
}
export function createSystemTimerClock() {
    return systemTimers().clock;
}
export function createSystemClock() {
    const frames = new Map();
    const { clock, allocateHandle } = systemTimers(frames);
    return {
        ...clock,
        requestFrame(handler) {
            const handle = allocateHandle();
            const onFrame = (timestampMs) => {
                frames.delete(handle);
                handler(timestampMs ?? clock.now());
            };
            if (typeof globalThis.requestAnimationFrame === 'function') {
                const nativeHandle = globalThis.requestAnimationFrame(onFrame);
                frames.set(handle, () => globalThis.cancelAnimationFrame(nativeHandle));
            }
            else {
                const nativeHandle = globalThis.setTimeout(onFrame, 16);
                frames.set(handle, () => globalThis.clearTimeout(nativeHandle));
            }
            return handle;
        },
        cancelFrame(handle) {
            const cancel = frames.get(handle);
            if (cancel !== undefined) {
                cancel();
                frames.delete(handle);
            }
        },
    };
}
