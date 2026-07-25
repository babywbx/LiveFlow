import { PlayerAdapterError } from './adapter-error.js';
import { createMediaSessionAdapter, } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export function createNativeVideoAdapter(options) {
    const surface = options.surface ?? createDefaultNativeVideoSurface(options.video);
    const driver = {
        initialResource: {
            video: options.video,
            removeOnRelease: false,
        },
        create(_source, _generation) {
            const video = surface.createVideo();
            try {
                surface.stage(video);
            }
            catch {
                let cleanupFailed = false;
                try {
                    cleanupVideo(video);
                }
                catch {
                    cleanupFailed = true;
                }
                try {
                    surface.remove(video);
                }
                catch {
                    cleanupFailed = true;
                }
                throw new PlayerAdapterError(cleanupFailed ? 'native-video-stage-cleanup-failed' : 'native-video-stage-failed', 'stage a video');
            }
            return Promise.resolve({
                video,
                removeOnRelease: true,
            });
        },
        activate(resource, source) {
            if (options.crossOrigin !== undefined) {
                resource.video.crossOrigin = options.crossOrigin;
            }
            if (options.binding !== undefined) {
                options.binding.attach(resource.video, source);
                return;
            }
            resource.video.preload = 'auto';
            resource.video.src = source.url;
            resource.video.load();
        },
        video(resource) {
            return resource.video;
        },
        subscribe(resource, listener) {
            return subscribeToVideo(resource.video, listener);
        },
        reveal(next, previous) {
            surface.reveal(next.video, previous.video);
            previous.removeOnRelease = true;
        },
        release(resource) {
            let cleanupFailed = false;
            if (options.binding !== undefined) {
                try {
                    options.binding.detach(resource.video);
                }
                catch {
                    cleanupFailed = true;
                }
            }
            try {
                cleanupVideo(resource.video);
            }
            catch {
                cleanupFailed = true;
            }
            try {
                if (resource.removeOnRelease) {
                    surface.remove(resource.video);
                }
            }
            catch {
                cleanupFailed = true;
            }
            if (cleanupFailed) {
                throw new PlayerAdapterError('native-video-cleanup-failed', 'release a video');
            }
        },
    };
    return createMediaSessionAdapter(driver, options);
}
function subscribeToVideo(video, listener) {
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
        listener({
            type: 'error',
            code: `media-error-${String(video.error?.code ?? 0)}`,
            recoverable: video.error?.code !== 4,
        });
    };
    const registrations = [
        ['loadeddata', ready],
        ['canplay', ready],
        ['playing', playing],
        ['waiting', waiting],
        ['stalled', stalled],
        ['ended', ended],
        ['error', error],
    ];
    const subscribed = [];
    try {
        for (const registration of registrations) {
            const [type, handler] = registration;
            video.addEventListener(type, handler);
            subscribed.push(registration);
        }
    }
    catch {
        for (const [type, handler] of subscribed) {
            try {
                video.removeEventListener(type, handler);
            }
            catch {
                continue;
            }
        }
        throw new PlayerAdapterError('native-video-subscribe-failed', 'subscribe to video events');
    }
    if (video.readyState >= 2) {
        ready();
    }
    return () => {
        let cleanupFailed = false;
        for (const [type, handler] of registrations) {
            try {
                video.removeEventListener(type, handler);
            }
            catch {
                cleanupFailed = true;
            }
        }
        if (cleanupFailed) {
            throw new PlayerAdapterError('native-video-unsubscribe-failed', 'unsubscribe from video events');
        }
    };
}
function cleanupVideo(video) {
    let cleanupFailed = false;
    try {
        video.pause();
    }
    catch {
        cleanupFailed = true;
    }
    try {
        video.removeAttribute('src');
    }
    catch {
        cleanupFailed = true;
    }
    try {
        video.load();
    }
    catch {
        cleanupFailed = true;
    }
    if (cleanupFailed) {
        throw new PlayerAdapterError('native-video-cleanup-failed', 'clear a video resource');
    }
}
function createDefaultNativeVideoSurface(initial) {
    if (typeof HTMLVideoElement === 'undefined' ||
        !(initial instanceof HTMLVideoElement) ||
        initial.parentElement === null) {
        throw new PlayerAdapterError('native-video-surface-required', 'create the video surface');
    }
    const parent = initial.parentElement;
    const ownerDocument = initial.ownerDocument;
    return {
        createVideo() {
            const video = ownerDocument.createElement('video');
            video.controls = initial.controls;
            video.playsInline = initial.playsInline;
            video.className = initial.className;
            return video;
        },
        stage(video) {
            if (!(video instanceof HTMLVideoElement)) {
                throw new PlayerAdapterError('invalid-native-video', 'stage a video');
            }
            video.hidden = true;
            parent.append(video);
        },
        reveal(video, previous) {
            if (!(video instanceof HTMLVideoElement) || !(previous instanceof HTMLVideoElement)) {
                throw new PlayerAdapterError('invalid-native-video', 'reveal a video');
            }
            video.hidden = false;
            previous.hidden = true;
        },
        remove(video) {
            if (video instanceof HTMLVideoElement) {
                video.remove();
            }
        },
    };
}
