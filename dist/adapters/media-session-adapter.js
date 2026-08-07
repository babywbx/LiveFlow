import { CapacityExceededError } from '../shared/errors.js';
import { PlayerAdapterError } from './adapter-error.js';
const MAX_LISTENERS = 32;
const MAX_PREPARED_SESSIONS = 4;
export function createMediaSessionAdapter(driver, options) {
    const now = options.now ?? defaultNow;
    const listeners = new Set();
    const sessions = new Map();
    const pendingCreations = new Set();
    let current = createInitialSession(driver.initialResource);
    let committed = null;
    let destroyed = false;
    let destroyPromise = null;
    let desiredMuted = driver.video(driver.initialResource).muted;
    let desiredVolume = driver.video(driver.initialResource).volume;
    let desiredPlaybackRate = driver.video(driver.initialResource).playbackRate;
    return {
        async prepare(source, generation) {
            ensureActive();
            if (sessions.has(generation)) {
                throw new PlayerAdapterError('duplicate-media-generation', 'prepare');
            }
            if (sessions.size + pendingCreations.size >= MAX_PREPARED_SESSIONS) {
                throw new CapacityExceededError('player-adapter-prepared-sessions', MAX_PREPARED_SESSIONS);
            }
            let creation;
            try {
                creation = driver.create(source, generation);
            }
            catch {
                throw new PlayerAdapterError('media-prepare-failed', 'prepare');
            }
            pendingCreations.add(creation);
            let resource;
            try {
                resource = await creation;
            }
            catch {
                throw new PlayerAdapterError('media-prepare-failed', 'prepare');
            }
            finally {
                pendingCreations.delete(creation);
            }
            const prepared = Object.freeze({ generation });
            if (destroyed) {
                if (!releaseResource(resource)) {
                    throw new PlayerAdapterError('media-release-failed', 'release a late media candidate');
                }
                return prepared;
            }
            if (sessions.has(generation)) {
                releaseResource(resource);
                throw new PlayerAdapterError('duplicate-media-generation', 'prepare');
            }
            let session = null;
            let unsubscribe;
            try {
                unsubscribe = driver.subscribe(resource, (event) => {
                    if (session !== null) {
                        handleResourceEvent(session, event);
                    }
                });
            }
            catch {
                releaseResource(resource);
                throw new PlayerAdapterError('media-subscribe-failed', 'subscribe to media events');
            }
            session = {
                generation,
                prepared,
                resource,
                unsubscribe,
                stalledSince: null,
                frameHandle: null,
                committed: false,
                released: false,
            };
            sessions.set(generation, session);
            try {
                applyCandidateControls(driver.video(resource));
                driver.activate(resource, source);
            }
            catch {
                sessions.delete(generation);
                releaseSession(session);
                throw new PlayerAdapterError('media-activation-failed', 'prepare');
            }
            return prepared;
        },
        commit(prepared, generation) {
            ensureActive();
            const session = sessions.get(generation);
            if (session === undefined ||
                session.prepared !== prepared ||
                prepared.generation !== generation) {
                throw new PlayerAdapterError('unknown-prepared-source', 'commit');
            }
            if (committed !== null && committed !== session && committed !== current) {
                sessions.delete(committed.generation);
                releaseSession(committed);
            }
            session.committed = true;
            committed = session;
            const video = driver.video(session.resource);
            if (!video.paused && !video.ended) {
                requestFirstFrame(session);
            }
            return Promise.resolve();
        },
        discard(prepared) {
            const session = sessions.get(prepared.generation);
            if (session === undefined || session.prepared !== prepared || session === current) {
                return Promise.resolve();
            }
            sessions.delete(session.generation);
            if (committed === session) {
                committed = null;
            }
            if (!releaseSession(session)) {
                throw new PlayerAdapterError('media-discard-failed', 'discard a media candidate');
            }
            return Promise.resolve();
        },
        async play() {
            ensureActive();
            const target = committed ?? current;
            if (target === null || target.released) {
                throw new PlayerAdapterError('media-session-unavailable', 'play');
            }
            try {
                await driver.video(target.resource).play();
            }
            catch {
                throw new PlayerAdapterError('media-play-failed', 'play');
            }
        },
        pause() {
            ensureActive();
            try {
                if (current !== null) {
                    driver.video(current.resource).pause();
                }
                if (committed !== null && committed !== current) {
                    driver.video(committed.resource).pause();
                }
            }
            catch {
                throw new PlayerAdapterError('media-pause-failed', 'pause media');
            }
        },
        setMuted(muted) {
            ensureActive();
            desiredMuted = muted;
            try {
                if (current !== null) {
                    driver.video(current.resource).muted = muted;
                }
                if (committed !== null && committed !== current) {
                    driver.video(committed.resource).muted = true;
                }
            }
            catch {
                throw new PlayerAdapterError('media-mute-failed', 'set muted state');
            }
        },
        setVolume(volume) {
            ensureActive();
            if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
                throw new PlayerAdapterError('invalid-media-volume', 'set volume');
            }
            desiredVolume = volume;
            try {
                applyToLiveVideos((video) => {
                    video.volume = volume;
                });
            }
            catch {
                throw new PlayerAdapterError('media-volume-failed', 'set volume');
            }
        },
        setPlaybackRate(rate) {
            ensureActive();
            if (!Number.isFinite(rate) || rate <= 0) {
                throw new PlayerAdapterError('invalid-playback-rate', 'set playback rate');
            }
            desiredPlaybackRate = rate;
            try {
                applyToLiveVideos((video) => {
                    video.playbackRate = rate;
                });
            }
            catch {
                throw new PlayerAdapterError('playback-rate-failed', 'set playback rate');
            }
        },
        getMetrics() {
            ensureActive();
            if (current === null) {
                throw new PlayerAdapterError('media-session-unavailable', 'read metrics');
            }
            try {
                const video = driver.video(current.resource);
                return readMetrics(video, current.stalledSince);
            }
            catch {
                throw new PlayerAdapterError('media-metrics-failed', 'read metrics');
            }
        },
        seek(seconds) {
            ensureActive();
            if (current === null) {
                throw new PlayerAdapterError('media-session-unavailable', 'seek');
            }
            if (!Number.isFinite(seconds) || seconds < 0) {
                throw new PlayerAdapterError('media-seek-failed', 'seek');
            }
            try {
                driver.video(current.resource).currentTime = seconds;
            }
            catch {
                throw new PlayerAdapterError('media-seek-failed', 'seek');
            }
        },
        subscribe(listener) {
            ensureActive();
            if (!listeners.has(listener) && listeners.size >= MAX_LISTENERS) {
                throw new CapacityExceededError('player-adapter-listeners', MAX_LISTENERS);
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        destroy() {
            if (destroyPromise !== null) {
                return destroyPromise;
            }
            destroyPromise = performDestroy();
            return destroyPromise;
        },
    };
    function createInitialSession(resource) {
        let session = null;
        let unsubscribe;
        try {
            unsubscribe = driver.subscribe(resource, (event) => {
                if (session !== null) {
                    handleResourceEvent(session, event);
                }
            });
        }
        catch {
            throw new PlayerAdapterError('media-subscribe-failed', 'subscribe to initial media events');
        }
        session = {
            generation: 0,
            prepared: Object.freeze({ generation: 0 }),
            resource,
            unsubscribe,
            stalledSince: null,
            frameHandle: null,
            committed: true,
            released: false,
        };
        return session;
    }
    function handleResourceEvent(session, event) {
        if (destroyed || session.released) {
            return;
        }
        if (session !== current && session !== committed && event.type !== 'ready') {
            return;
        }
        if (event.type === 'playing') {
            session.stalledSince = null;
            if (session === committed && session !== current) {
                requestFirstFrame(session);
            }
            else if (session === current) {
                emit({ type: 'playing', generation: session.generation });
            }
            return;
        }
        if (event.type === 'waiting' || event.type === 'stalled') {
            session.stalledSince ??= now();
            emit({ type: event.type, generation: session.generation });
            return;
        }
        if (event.type === 'ready') {
            emit({ type: 'ready', generation: session.generation });
            return;
        }
        if (event.type === 'ended') {
            emit({ type: 'ended', generation: session.generation });
            return;
        }
        emit({
            type: 'error',
            generation: session.generation,
            code: event.code,
            recoverable: event.recoverable,
        });
    }
    function requestFirstFrame(session) {
        if (session.frameHandle !== null) {
            return;
        }
        const video = driver.video(session.resource);
        if (video.requestVideoFrameCallback === undefined) {
            promote(session);
            return;
        }
        try {
            session.frameHandle = video.requestVideoFrameCallback(() => {
                session.frameHandle = null;
                promote(session);
            });
        }
        catch {
            emit({
                type: 'error',
                generation: session.generation,
                code: 'video-frame-callback-failed',
                recoverable: true,
            });
        }
    }
    function promote(session) {
        if (destroyed || session.released || committed !== session || current === session) {
            return;
        }
        const previous = current;
        if (previous === null) {
            return;
        }
        try {
            driver.reveal(session.resource, previous.resource);
        }
        catch {
            sessions.delete(session.generation);
            committed = null;
            releaseSession(session);
            emit({
                type: 'error',
                generation: session.generation,
                code: 'adapter-reveal-failed',
                recoverable: true,
            });
            emitDiagnostic('media-reveal-failed', session.generation);
            return;
        }
        current = session;
        committed = session;
        sessions.delete(session.generation);
        session.committed = true;
        releaseSession(previous);
        emit({ type: 'first-frame', generation: session.generation });
        try {
            const video = driver.video(session.resource);
            video.muted = desiredMuted;
            video.volume = desiredVolume;
            video.playbackRate = desiredPlaybackRate;
        }
        catch {
            emit({
                type: 'error',
                generation: session.generation,
                code: 'media-control-restore-failed',
                recoverable: true,
            });
            emitDiagnostic('media-control-restore-failed', session.generation);
            return;
        }
        emit({ type: 'playing', generation: session.generation });
    }
    function releaseSession(session) {
        if (session.released) {
            return true;
        }
        session.released = true;
        try {
            cancelFrame(session);
        }
        catch {
            emitDiagnostic('media-frame-cancel-failed', session.generation);
        }
        let unsubscribed = true;
        try {
            session.unsubscribe();
        }
        catch {
            unsubscribed = false;
            emitDiagnostic('media-unsubscribe-failed', session.generation);
        }
        const released = releaseResource(session.resource);
        return unsubscribed && released;
    }
    function releaseResource(resource) {
        try {
            driver.release(resource);
            return true;
        }
        catch {
            emitDiagnostic('media-release-failed');
            return false;
        }
    }
    function cancelFrame(session) {
        if (session.frameHandle === null) {
            return;
        }
        const handle = session.frameHandle;
        session.frameHandle = null;
        const video = driver.video(session.resource);
        if (video.cancelVideoFrameCallback !== undefined) {
            video.cancelVideoFrameCallback(handle);
        }
    }
    function applyCandidateControls(video) {
        video.muted = true;
        video.volume = desiredVolume;
        video.playbackRate = desiredPlaybackRate;
    }
    function applyToLiveVideos(operation) {
        if (current !== null) {
            operation(driver.video(current.resource));
        }
        if (committed !== null && committed !== current) {
            operation(driver.video(committed.resource));
        }
    }
    function emit(event) {
        for (const listener of listeners) {
            try {
                listener(event);
            }
            catch {
                emitDiagnostic('playback-listener-failed', event.generation);
            }
        }
    }
    function emitDiagnostic(code, generation) {
        if (options.onDiagnostic === undefined) {
            return;
        }
        try {
            if (generation === undefined) {
                options.onDiagnostic({ scope: 'continuity', code, level: 'warn' });
            }
            else {
                options.onDiagnostic({ scope: 'continuity', code, level: 'warn', generation });
            }
        }
        catch {
            return;
        }
    }
    function performDestroy() {
        destroyed = true;
        listeners.clear();
        const releasable = new Set();
        if (current !== null) {
            releasable.add(current);
        }
        if (committed !== null) {
            releasable.add(committed);
        }
        for (const session of sessions.values()) {
            releasable.add(session);
        }
        sessions.clear();
        committed = null;
        current = null;
        let cleanupFailed = false;
        for (const session of releasable) {
            if (!releaseSession(session)) {
                cleanupFailed = true;
            }
        }
        if (cleanupFailed) {
            return Promise.reject(new PlayerAdapterError('player-adapter-cleanup-failed', 'destroy the adapter'));
        }
        return Promise.resolve();
    }
    function ensureActive() {
        if (destroyed) {
            throw new PlayerAdapterError('player-adapter-destroyed', 'use a destroyed adapter');
        }
    }
}
function defaultNow() {
    return globalThis.performance.now();
}
function readMetrics(video, stalledSince) {
    const currentTime = video.currentTime;
    let bufferedAhead = 0;
    let liveEdge = currentTime;
    let inRange = false;
    let nextStart = null;
    for (let index = 0; index < video.buffered.length; index += 1) {
        const start = video.buffered.start(index);
        const end = video.buffered.end(index);
        if (currentTime >= start && currentTime <= end) {
            inRange = true;
            bufferedAhead = Math.max(bufferedAhead, end - currentTime);
        }
        else if (start > currentTime && (nextStart === null || start < nextStart)) {
            nextStart = start;
        }
        liveEdge = Math.max(liveEdge, end);
    }
    const metrics = {
        currentTimeSeconds: currentTime,
        bufferedAheadSeconds: Math.max(0, bufferedAhead),
        liveEdgeDistanceSeconds: Math.max(0, liveEdge - currentTime),
        playbackRate: video.playbackRate,
        stalledSince,
        droppedFrames: video.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
    };
    if (inRange || nextStart === null)
        return metrics;
    return { ...metrics, strandedGapSeconds: nextStart - currentTime };
}
