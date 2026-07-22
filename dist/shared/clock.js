import { CapacityExceededError } from './errors.js';
export function createSystemClock() {
    const maxActiveHandles = 256;
    let nextHandle = 1;
    const timerCancellations = new Map();
    const frameCancellations = new Map();
    return {
        now() {
            return globalThis.performance.now();
        },
        setTimeout(handler, delayMs) {
            ensureCapacity();
            const handle = nextHandle;
            nextHandle += 1;
            const nativeHandle = globalThis.setTimeout(() => {
                timerCancellations.delete(handle);
                handler();
            }, delayMs);
            timerCancellations.set(handle, () => {
                globalThis.clearTimeout(nativeHandle);
            });
            return handle;
        },
        clearTimeout(handle) {
            const cancel = timerCancellations.get(handle);
            if (cancel === undefined) {
                return;
            }
            timerCancellations.delete(handle);
            cancel();
        },
        requestFrame(handler) {
            ensureCapacity();
            const handle = nextHandle;
            nextHandle += 1;
            if (typeof globalThis.requestAnimationFrame === 'function') {
                const nativeHandle = globalThis.requestAnimationFrame((timestampMs) => {
                    frameCancellations.delete(handle);
                    handler(timestampMs);
                });
                frameCancellations.set(handle, () => {
                    globalThis.cancelAnimationFrame(nativeHandle);
                });
                return handle;
            }
            const nativeHandle = globalThis.setTimeout(() => {
                frameCancellations.delete(handle);
                handler(globalThis.performance.now());
            }, 16);
            frameCancellations.set(handle, () => {
                globalThis.clearTimeout(nativeHandle);
            });
            return handle;
        },
        cancelFrame(handle) {
            const cancel = frameCancellations.get(handle);
            if (cancel === undefined) {
                return;
            }
            frameCancellations.delete(handle);
            cancel();
        },
    };
    function ensureCapacity() {
        if (timerCancellations.size + frameCancellations.size >= maxActiveHandles) {
            throw new CapacityExceededError('system-clock-handles', maxActiveHandles);
        }
    }
}
