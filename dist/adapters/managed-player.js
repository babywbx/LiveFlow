import { PlayerAdapterError } from './adapter-error.js';
import { createMediaSessionAdapter, } from './media-session-adapter.js';
export function createManagedPlayerAdapter(contract, options) {
    const driver = {
        initialResource: createResource(contract.initialPlayer),
        async create(source, generation) {
            try {
                return createResource(await contract.createPlayer(source, generation));
            }
            catch {
                throw new PlayerAdapterError(`${contract.scope}-create-failed`, contract.operations.createCandidate);
            }
        },
        activate(resource, _source) {
            contract.surface.stage(resource.player);
        },
        video(resource) {
            return contract.video(resource.player);
        },
        subscribe(resource, listener) {
            return contract.subscribe(resource.player, listener);
        },
        reveal(next, previous) {
            contract.surface.reveal(next.player, previous.player);
        },
        release(resource) {
            let cleanupFailed = false;
            if (!resource.destroyed) {
                try {
                    contract.destroyPlayer(resource.player);
                    resource.destroyed = true;
                }
                catch {
                    cleanupFailed = true;
                }
            }
            if (!resource.removed) {
                try {
                    contract.surface.remove(resource.player);
                    resource.removed = true;
                }
                catch {
                    cleanupFailed = true;
                }
            }
            if (cleanupFailed) {
                throw new PlayerAdapterError(`${contract.scope}-cleanup-failed`, contract.operations.releaseInstance);
            }
        },
    };
    return createMediaSessionAdapter(driver, options);
    function createResource(player) {
        return { player, destroyed: false, removed: false };
    }
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
