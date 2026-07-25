export const INITIAL_CONTINUITY_STATE = {
    state: 'idle',
    generation: 0,
    automaticRecoveryCount: 0,
};
export function reduceContinuityState(current, event) {
    if (current.state === 'stopped') {
        return current;
    }
    if (event.type === 'destroyed') {
        return {
            ...current,
            state: 'stopped',
        };
    }
    if (event.type === 'source-requested') {
        if (event.generation <= current.generation) {
            return current;
        }
        return {
            state: 'resolving',
            generation: event.generation,
            automaticRecoveryCount: current.automaticRecoveryCount,
        };
    }
    if (event.generation !== current.generation) {
        return current;
    }
    switch (event.type) {
        case 'source-prepared':
            if (current.state !== 'resolving') {
                return current;
            }
            return {
                ...current,
                state: 'warming',
            };
        case 'first-frame':
            if (current.state !== 'warming' &&
                current.state !== 'degraded' &&
                current.state !== 'recovering' &&
                current.state !== 'waiting-reopen' &&
                current.state !== 'suspended') {
                return current;
            }
            return {
                ...current,
                state: 'playing',
                automaticRecoveryCount: current.state === 'warming' ? 0 : current.automaticRecoveryCount,
            };
        case 'playback-degraded':
            if (current.state !== 'resolving' &&
                current.state !== 'warming' &&
                current.state !== 'playing' &&
                current.state !== 'recovering') {
                return current;
            }
            return {
                ...current,
                state: 'degraded',
            };
        case 'playback-resumed':
            if (current.state !== 'degraded' &&
                current.state !== 'recovering' &&
                current.state !== 'waiting-reopen' &&
                current.state !== 'suspended') {
                return current;
            }
            return {
                ...current,
                state: 'playing',
            };
        case 'recovery-requested':
            if (current.state !== 'warming' && current.state !== 'degraded') {
                return current;
            }
            return {
                ...current,
                state: 'recovering',
                automaticRecoveryCount: current.automaticRecoveryCount + 1,
            };
        case 'recovery-exhausted':
            if (current.state !== 'degraded' && current.state !== 'recovering') {
                return current;
            }
            return {
                ...current,
                state: 'waiting-reopen',
            };
        case 'source-failed':
            if (current.state !== 'resolving' && current.state !== 'warming') {
                return current;
            }
            return {
                ...current,
                state: 'recovering',
            };
        case 'playback-suspended':
            if (current.state !== 'warming' &&
                current.state !== 'playing' &&
                current.state !== 'degraded') {
                return current;
            }
            return {
                ...current,
                state: 'suspended',
            };
    }
}
