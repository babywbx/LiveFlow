import { PlayerAdapterError } from './adapter-error.js';
import { bindManagedEvents, createManagedPlayerAdapter } from './managed-player.js';
export { PlayerAdapterError } from './adapter-error.js';
export function createDPlayerAdapter(options) {
    const surface = options.surface ?? createDefaultDPlayerSurface(options.player);
    return createManagedPlayerAdapter({
        scope: 'dplayer',
        operations: {
            createCandidate: 'create a DPlayer candidate',
            releaseInstance: 'release a DPlayer instance',
        },
        initialPlayer: options.player,
        surface,
        createPlayer: options.createPlayer,
        video(player) {
            return player.video;
        },
        subscribe: subscribeToDPlayer,
        destroyPlayer(player) {
            player.destroy();
        },
    }, options);
}
function subscribeToDPlayer(player, listener) {
    const video = player.video;
    const readyAtSubscription = video.readyState >= 2;
    let disposed = false;
    const forward = (event) => {
        if (!disposed) {
            listener(event);
        }
    };
    const ready = () => {
        forward({ type: 'ready' });
    };
    const playing = () => {
        forward({ type: 'playing' });
    };
    const waiting = () => {
        forward({ type: 'waiting' });
    };
    const stalled = () => {
        forward({ type: 'stalled' });
    };
    const ended = () => {
        forward({ type: 'ended' });
    };
    const error = () => {
        forward({ type: 'error', code: 'dplayer-media-error', recoverable: true });
    };
    const externallyDestroyed = () => {
        forward({ type: 'error', code: 'dplayer-destroyed', recoverable: false });
    };
    const registrations = [
        ['loadeddata', ready],
        ['canplay', ready],
        ['playing', playing],
        ['waiting', waiting],
        ['stalled', stalled],
        ['ended', ended],
        ['error', error],
        ['destroy', externallyDestroyed],
    ];
    let unsubscribe;
    try {
        unsubscribe = bindManagedEvents('dplayer', 'DPlayer', player, registrations);
    }
    catch (bindError) {
        disposed = true;
        throw bindError;
    }
    if (readyAtSubscription) {
        ready();
    }
    return () => {
        disposed = true;
        unsubscribe();
    };
}
function createDefaultDPlayerSurface(initial) {
    if (initial.container === undefined) {
        throw new PlayerAdapterError('dplayer-surface-required', 'create the DPlayer surface');
    }
    return {
        stage(player) {
            if (player.container === undefined) {
                throw new PlayerAdapterError('dplayer-container-missing', 'stage a DPlayer candidate');
            }
            player.container.hidden = true;
        },
        reveal(player, previous) {
            if (player.container === undefined || previous.container === undefined) {
                throw new PlayerAdapterError('dplayer-container-missing', 'reveal a DPlayer candidate');
            }
            player.container.hidden = false;
            previous.container.hidden = true;
        },
        remove(player) {
            player.container?.remove();
        },
    };
}
