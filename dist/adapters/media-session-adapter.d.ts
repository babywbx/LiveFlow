import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js';
import type { EngineHooks } from '../shared/diagnostics.js';
export interface TimeRangesLike {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
}
export interface VideoElementLike {
    src: string;
    crossOrigin: string | null;
    preload: string;
    currentTime: number;
    playbackRate: number;
    muted: boolean;
    volume: number;
    readonly paused: boolean;
    readonly ended: boolean;
    readonly readyState: number;
    readonly buffered: TimeRangesLike;
    readonly error: {
        readonly code: number;
    } | null;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    load(): void;
    play(): Promise<void>;
    pause(): void;
    removeAttribute(name: string): void;
    requestVideoFrameCallback?(callback: (timestampMs: number) => void): number;
    cancelVideoFrameCallback?(handle: number): void;
    getVideoPlaybackQuality?(): {
        readonly droppedVideoFrames: number;
    };
}
export type ResourceEvent = {
    readonly type: 'ready';
} | {
    readonly type: 'playing';
} | {
    readonly type: 'waiting';
} | {
    readonly type: 'stalled';
} | {
    readonly type: 'ended';
} | {
    readonly type: 'error';
    readonly code: string;
    readonly recoverable: boolean;
};
export interface MediaResourceDriver<Resource> {
    readonly initialResource: Resource;
    create(source: LiveSource, generation: number): Promise<Resource>;
    activate(resource: Resource, source: LiveSource): void;
    video(resource: Resource): VideoElementLike;
    subscribe(resource: Resource, listener: (event: ResourceEvent) => void): () => void;
    reveal(next: Resource, previous: Resource): void;
    release(resource: Resource): void;
}
export interface MediaSessionAdapterOptions extends EngineHooks {
    readonly now?: () => number;
}
export declare function createMediaSessionAdapter<Resource>(driver: MediaResourceDriver<Resource>, options: MediaSessionAdapterOptions): LivePlayerAdapter;
