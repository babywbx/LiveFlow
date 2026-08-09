import { PlayerAdapterError } from './adapter-error.js';
import { createMediaSessionAdapter, } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export function createArtPlayerAdapter(options) {
    const surface = options.surface ?? createDefaultArtPlayerSurface(options.player);
    let visiblePlayer = options.player;
    try {
        options.player.setMutex(false);
    }
    catch {
        throw new PlayerAdapterError('artplayer-mutex-failed', 'disable the initial player mutex');
    }
    const driver = {
        initialResource: createResource(options.player),
        async create(source, generation) {
            try {
                return createResource(await options.createPlayer(source, generation, { mutex: false }));
            }
            catch {
                throw new PlayerAdapterError('artplayer-create-failed', 'create an ArtPlayer candidate');
            }
        },
        activate(resource, _source) {
            resource.player.setMutex(false);
            surface.stage(resource.player);
        },
        video(resource) {
            return resource.player.video;
        },
        subscribe(resource, listener) {
            return subscribeToArtPlayer(resource.player, listener);
        },
        reveal(next, previous) {
            surface.reveal(next.player, previous.player);
            visiblePlayer = next.player;
        },
        release(resource) {
            let cleanupFailed = false;
            if (!resource.destroyed) {
                try {
                    resource.player.destroy();
                    resource.destroyed = true;
                }
                catch {
                    cleanupFailed = true;
                }
            }
            if (!resource.removed) {
                try {
                    surface.remove(resource.player);
                    resource.removed = true;
                }
                catch {
                    cleanupFailed = true;
                }
            }
            if (visiblePlayer === resource.player) {
                visiblePlayer = null;
            }
            if (cleanupFailed) {
                throw new PlayerAdapterError('artplayer-cleanup-failed', 'release an ArtPlayer instance');
            }
        },
    };
    const adapter = createMediaSessionAdapter(driver, options);
    return {
        prepare(source, generation) {
            return adapter.prepare(source, generation);
        },
        commit(prepared, generation) {
            return adapter.commit(prepared, generation);
        },
        discard(prepared) {
            return adapter.discard(prepared);
        },
        play() {
            return adapter.play();
        },
        pause() {
            adapter.pause();
        },
        setMuted(muted) {
            adapter.setMuted(muted);
        },
        setVolume(volume) {
            adapter.setVolume(volume);
        },
        setPlaybackRate(rate) {
            adapter.setPlaybackRate(rate);
        },
        getMetrics() {
            return adapter.getMetrics();
        },
        seek(seconds) {
            adapter.seek?.(seconds);
        },
        subscribe(listener) {
            return adapter.subscribe(listener);
        },
        destroy() {
            return adapter.destroy();
        },
        getOverlayContainer() {
            return visiblePlayer?.overlayContainer ?? options.overlayContainer ?? null;
        },
    };
    function createResource(player) {
        return { player, destroyed: false, removed: false };
    }
}
function subscribeToArtPlayer(player, listener) {
    const video = player.video;
    const readyAtSubscription = video.readyState >= 2;
    const ready = () => {
        listener({ type: 'ready' });
    };
    const playing = () => {
        listener({ type: 'playing' });
    };
    const waiting = () => {
        listener({ type: 'waiting' });
    };
    const stalled = () => {
        listener({ type: 'stalled' });
    };
    const ended = () => {
        listener({ type: 'ended' });
    };
    const error = () => {
        listener({ type: 'error', code: 'artplayer-media-error', recoverable: true });
    };
    const externallyDestroyed = () => {
        listener({ type: 'error', code: 'artplayer-destroyed', recoverable: false });
    };
    const registrations = [
        ['ready', ready],
        ['video:loadeddata', ready],
        ['playing', playing],
        ['video:playing', playing],
        ['waiting', waiting],
        ['video:waiting', waiting],
        ['stalled', stalled],
        ['video:stalled', stalled],
        ['ended', ended],
        ['video:ended', ended],
        ['error', error],
        ['video:error', error],
        ['destroy', externallyDestroyed],
    ];
    const subscribed = [];
    try {
        for (const registration of registrations) {
            const [event, handler] = registration;
            player.on(event, handler);
            subscribed.push(registration);
        }
    }
    catch {
        for (const [event, handler] of subscribed) {
            try {
                player.off(event, handler);
            }
            catch {
                continue;
            }
        }
        throw new PlayerAdapterError('artplayer-subscribe-failed', 'subscribe to ArtPlayer events');
    }
    if (readyAtSubscription) {
        ready();
    }
    return () => {
        let cleanupFailed = false;
        for (const [event, handler] of registrations) {
            try {
                player.off(event, handler);
            }
            catch {
                cleanupFailed = true;
            }
        }
        if (cleanupFailed) {
            throw new PlayerAdapterError('artplayer-unsubscribe-failed', 'unsubscribe from ArtPlayer events');
        }
    };
}
function createDefaultArtPlayerSurface(initial) {
    if (initial.container === undefined) {
        throw new PlayerAdapterError('artplayer-surface-required', 'create the ArtPlayer surface');
    }
    return {
        stage(player) {
            if (player.container === undefined) {
                throw new PlayerAdapterError('artplayer-container-missing', 'stage an ArtPlayer candidate');
            }
            player.container.hidden = true;
        },
        reveal(player, previous) {
            if (player.container === undefined || previous.container === undefined) {
                throw new PlayerAdapterError('artplayer-container-missing', 'reveal an ArtPlayer candidate');
            }
            player.container.hidden = false;
            previous.container.hidden = true;
        },
        remove(player) {
            player.container?.remove();
        },
    };
}
