import { PlayerAdapterError } from './adapter-error.js';
import { bindManagedEvents, createManagedPlayerAdapter } from './managed-player.js';
export { PlayerAdapterError } from './adapter-error.js';
export function createXgPlayerAdapter(options) {
    requireMedia(options.player);
    const surface = options.surface ?? createDefaultXgPlayerSurface(options.player);
    return createManagedPlayerAdapter({
        scope: 'xgplayer',
        operations: {
            createCandidate: 'create an XGPlayer candidate',
            releaseFailedCandidate: 'release a failed XGPlayer candidate',
            releaseInstance: 'release an XGPlayer instance',
        },
        initialPlayer: options.player,
        surface,
        createPlayer: options.createPlayer,
        video: requireMedia,
        subscribe: subscribeToXgPlayer,
        destroyPlayer(player) {
            player.destroy();
        },
    }, options);
}
function requireMedia(player) {
    const media = player.media ?? player.video;
    if (media === undefined || media === null) {
        throw new PlayerAdapterError('xgplayer-media-missing', 'access the XGPlayer media element');
    }
    return media;
}
function subscribeToXgPlayer(player, listener) {
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
        listener({ type: 'error', code: 'xgplayer-media-error', recoverable: true });
    };
    const externallyDestroyed = () => {
        listener({ type: 'error', code: 'xgplayer-destroyed', recoverable: false });
    };
    const registrations = [
        ['ready', ready],
        ['loadeddata', ready],
        ['canplay', ready],
        ['playing', playing],
        ['waiting', waiting],
        ['stalled', stalled],
        ['ended', ended],
        ['error', error],
        ['destroy', externallyDestroyed],
    ];
    const media = requireMedia(player);
    const unsubscribe = bindManagedEvents('xgplayer', 'XGPlayer', player, registrations);
    if (media.readyState >= 2) {
        ready();
    }
    return unsubscribe;
}
function createDefaultXgPlayerSurface(initial) {
    if (initial.root === undefined || initial.root === null) {
        throw new PlayerAdapterError('xgplayer-surface-required', 'create the XGPlayer surface');
    }
    return {
        stage(player) {
            if (player.root === undefined || player.root === null) {
                throw new PlayerAdapterError('xgplayer-root-missing', 'stage an XGPlayer candidate');
            }
            player.root.hidden = true;
        },
        reveal(player, previous) {
            if (player.root === undefined ||
                player.root === null ||
                previous.root === undefined ||
                previous.root === null) {
                throw new PlayerAdapterError('xgplayer-root-missing', 'reveal an XGPlayer candidate');
            }
            player.root.hidden = false;
            previous.root.hidden = true;
        },
        remove(player) {
            player.root?.remove();
        },
    };
}
