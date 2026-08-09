import { CapacityExceededError, LiveFlowError } from '../shared/errors.js';
const MAX_PAGE_ACTIVITY_LISTENERS = 16;
export function createDocumentPageActivity(options = {}) {
    const target = options.document ?? globalThis.document;
    const listeners = new Set();
    let bound = null;
    const isHidden = () => target.visibilityState === 'hidden';
    const notify = () => {
        const hidden = isHidden();
        for (const listener of listeners) {
            try {
                listener(hidden);
            }
            catch {
                continue;
            }
        }
    };
    return {
        isHidden,
        subscribe(listener) {
            if (!listeners.has(listener) && listeners.size >= MAX_PAGE_ACTIVITY_LISTENERS) {
                throw new CapacityExceededError('page-activity-listeners', MAX_PAGE_ACTIVITY_LISTENERS);
            }
            if (bound === null) {
                try {
                    target.addEventListener('visibilitychange', notify);
                }
                catch {
                    try {
                        target.removeEventListener('visibilitychange', notify);
                    }
                    catch {
                    }
                    throw new LiveFlowError('page-activity-subscribe-failed', 'Could not subscribe to page visibility changes.');
                }
                bound = () => {
                    target.removeEventListener('visibilitychange', notify);
                };
            }
            listeners.add(listener);
            return () => {
                if (!listeners.has(listener)) {
                    return;
                }
                if (listeners.size === 1 && bound !== null) {
                    const unbind = bound;
                    try {
                        unbind();
                        bound = null;
                    }
                    catch {
                        throw new LiveFlowError('page-activity-unsubscribe-failed', 'Could not unsubscribe from page visibility changes.');
                    }
                }
                listeners.delete(listener);
            };
        },
    };
}
