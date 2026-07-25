import { CapacityExceededError } from '../shared/errors.js';
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
            listeners.add(listener);
            if (bound === null) {
                target.addEventListener('visibilitychange', notify);
                bound = () => {
                    target.removeEventListener('visibilitychange', notify);
                };
            }
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && bound !== null) {
                    const unbind = bound;
                    bound = null;
                    unbind();
                }
            };
        },
    };
}
