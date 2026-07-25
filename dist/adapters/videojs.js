import { PlayerAdapterError } from './adapter-error.js';
import { bindManagedEvents, createManagedPlayerAdapter } from './managed-player.js';
export { PlayerAdapterError } from './adapter-error.js';
export function createVideoJsAdapter(options) {
    requireVideo(options.player);
    const surface = options.surface ?? createDefaultVideoJsSurface(options.player);
    return createManagedPlayerAdapter({
        scope: 'videojs',
        operations: {
            createCandidate: 'create a Video.js candidate',
            releaseFailedCandidate: 'release a failed Video.js candidate',
            releaseInstance: 'release a Video.js instance',
        },
        initialPlayer: options.player,
        surface,
        createPlayer: options.createPlayer,
        video: requireVideo,
        subscribe: subscribeToVideoJs,
        destroyPlayer(player) {
            player.dispose();
        },
    }, options);
}
function requireVideo(player) {
    const candidate = player.el()?.querySelector('video');
    if (candidate === undefined || !isVideoElementLike(candidate)) {
        throw new PlayerAdapterError('videojs-video-missing', 'access the Video.js media element');
    }
    return candidate;
}
function isVideoElementLike(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    return ('play' in value &&
        typeof value.play === 'function' &&
        'pause' in value &&
        typeof value.pause === 'function' &&
        'load' in value &&
        typeof value.load === 'function' &&
        'addEventListener' in value &&
        typeof value.addEventListener === 'function' &&
        'removeEventListener' in value &&
        typeof value.removeEventListener === 'function' &&
        'buffered' in value);
}
function subscribeToVideoJs(player, listener) {
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
        listener({ type: 'error', code: 'videojs-media-error', recoverable: true });
    };
    const externallyDisposed = () => {
        listener({ type: 'error', code: 'videojs-disposed', recoverable: false });
    };
    const registrations = [
        ['loadeddata', ready],
        ['canplay', ready],
        ['playing', playing],
        ['waiting', waiting],
        ['stalled', stalled],
        ['ended', ended],
        ['error', error],
        ['dispose', externallyDisposed],
    ];
    const video = requireVideo(player);
    const unsubscribe = bindManagedEvents('videojs', 'Video.js', player, registrations);
    if (video.readyState >= 2) {
        ready();
    }
    return unsubscribe;
}
function isHidableHost(value) {
    if (!('hidden' in value) || typeof value.hidden !== 'boolean') {
        return false;
    }
    return 'remove' in value && typeof value.remove === 'function';
}
function requireHidableHost(player, operation) {
    const host = player.el();
    if (host === null || !isHidableHost(host)) {
        throw new PlayerAdapterError('videojs-host-missing', operation);
    }
    return host;
}
function createDefaultVideoJsSurface(initial) {
    const host = initial.el();
    if (host === null || !isHidableHost(host)) {
        throw new PlayerAdapterError('videojs-surface-required', 'create the Video.js surface');
    }
    return {
        stage(player) {
            requireHidableHost(player, 'stage a Video.js candidate').hidden = true;
        },
        reveal(player, previous) {
            const nextHost = requireHidableHost(player, 'reveal a Video.js candidate');
            const previousHost = requireHidableHost(previous, 'reveal a Video.js candidate');
            nextHost.hidden = false;
            previousHost.hidden = true;
        },
        remove(player) {
            const removable = player.el();
            if (removable !== null && isHidableHost(removable)) {
                removable.remove();
            }
        },
    };
}
