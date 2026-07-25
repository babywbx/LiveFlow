import { PlayerAdapterError } from './adapter-error.js';
import { createMediaSessionAdapter, } from './media-session-adapter.js';
export function createManagedPlayerAdapter(contract, options) {
    const driver = {
        initialResource: contract.initialPlayer,
        async create(source, generation) {
            let player = null;
            try {
                player = await contract.createPlayer(source, generation);
                contract.surface.stage(player);
            }
            catch {
                if (player !== null) {
                    let cleanupFailed = false;
                    try {
                        contract.destroyPlayer(player);
                    }
                    catch {
                        cleanupFailed = true;
                    }
                    try {
                        contract.surface.remove(player);
                    }
                    catch {
                        cleanupFailed = true;
                    }
                    if (cleanupFailed) {
                        throw new PlayerAdapterError(`${contract.scope}-cleanup-failed`, contract.operations.releaseFailedCandidate);
                    }
                }
                throw new PlayerAdapterError(`${contract.scope}-create-failed`, contract.operations.createCandidate);
            }
            return player;
        },
        activate(_player, _source) { },
        video(player) {
            return contract.video(player);
        },
        subscribe(player, listener) {
            return contract.subscribe(player, listener);
        },
        reveal(next, previous) {
            contract.surface.reveal(next, previous);
        },
        release(player) {
            let cleanupFailed = false;
            try {
                contract.destroyPlayer(player);
            }
            catch {
                cleanupFailed = true;
            }
            try {
                contract.surface.remove(player);
            }
            catch {
                cleanupFailed = true;
            }
            if (cleanupFailed) {
                throw new PlayerAdapterError(`${contract.scope}-cleanup-failed`, contract.operations.releaseInstance);
            }
        },
    };
    return createMediaSessionAdapter(driver, options);
}
export function bindManagedEvents(scope, label, target, registrations) {
    const subscribed = [];
    try {
        for (const registration of registrations) {
            target.on(registration[0], registration[1]);
            subscribed.push(registration);
        }
    }
    catch {
        for (const [event, handler] of subscribed) {
            try {
                target.off?.(event, handler);
            }
            catch {
                continue;
            }
        }
        throw new PlayerAdapterError(`${scope}-subscribe-failed`, `subscribe to ${label} events`);
    }
    return () => {
        if (target.off === undefined) {
            return;
        }
        let cleanupFailed = false;
        for (const [event, handler] of registrations) {
            try {
                target.off(event, handler);
            }
            catch {
                cleanupFailed = true;
            }
        }
        if (cleanupFailed) {
            throw new PlayerAdapterError(`${scope}-unsubscribe-failed`, `unsubscribe from ${label} events`);
        }
    };
}
