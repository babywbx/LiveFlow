const MAX_DIAGNOSTIC_CODES = 32;
const DIAGNOSTIC_COOLDOWN_MS = 1_000;
export function createDiagnosticEmitter(scope, hooks, clock) {
    const lastEmittedAt = new Map();
    return (code, level, generation, detail) => {
        if (hooks.onDiagnostic === undefined)
            return;
        const previousEmission = lastEmittedAt.get(code);
        let now;
        try {
            now = clock.now();
        }
        catch {
            return;
        }
        if (!Number.isFinite(now))
            return;
        if (previousEmission !== undefined && now - previousEmission < DIAGNOSTIC_COOLDOWN_MS)
            return;
        if (previousEmission === undefined && lastEmittedAt.size >= MAX_DIAGNOSTIC_CODES)
            return;
        lastEmittedAt.set(code, now);
        const event = { scope, code, level };
        if (generation !== undefined)
            event.generation = generation;
        if (detail !== undefined)
            event.detail = detail;
        try {
            hooks.onDiagnostic(event);
        }
        catch {
            return;
        }
    };
}
