import { CapacityExceededError } from './errors.js';
function now() {
    return globalThis.performance.now();
}
function handleAllocator(handles, other) {
    const maxActiveHandles = 256;
    let nextHandle = 1;
    return () => {
        if (handles.size + (other?.size ?? 0) >= maxActiveHandles) {
            throw new CapacityExceededError('system-clock-handles', maxActiveHandles);
        }
        return nextHandle++;
    };
}
function systemTimers(timers, allocateHandle) {
    return {
        now,
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
}
function systemFrames(frames, allocateHandle) {
    return {
        now,
        requestFrame(handler) {
            const handle = allocateHandle();
            const onFrame = (timestampMs) => {
                frames.delete(handle);
                handler(timestampMs ?? now());
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
export function createSystemTimerClock() {
    const timers = new Map();
    return systemTimers(timers, handleAllocator(timers));
}
export function createSystemFrameClock() {
    const frames = new Map();
    return systemFrames(frames, handleAllocator(frames));
}
export function createSystemClock() {
    const timers = new Map();
    const frames = new Map();
    const allocateHandle = handleAllocator(timers, frames);
    return { ...systemTimers(timers, allocateHandle), ...systemFrames(frames, allocateHandle) };
}
