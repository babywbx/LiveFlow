const MAX_DIAGNOSTIC_CODES = 32;
const DIAGNOSTIC_COOLDOWN_MS = 1_000;
export function createDiagnosticEmitter(hooks, clock) {
    const lastEmittedAt = new Map();
    return {
        emit(event) {
            if (hooks.onDiagnostic === undefined) {
                return;
            }
            const previousEmission = lastEmittedAt.get(event.code);
            const now = clock.now();
            if (previousEmission !== undefined && now - previousEmission < DIAGNOSTIC_COOLDOWN_MS) {
                return;
            }
            if (previousEmission === undefined && lastEmittedAt.size >= MAX_DIAGNOSTIC_CODES) {
                return;
            }
            lastEmittedAt.set(event.code, now);
            try {
                hooks.onDiagnostic(event);
            }
            catch {
                return;
            }
        },
    };
}
