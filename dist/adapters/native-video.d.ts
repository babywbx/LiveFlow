import type { EngineHooks } from '../shared/diagnostics.js';
import type { LivePlayerAdapter } from '../continuity/types.js';
import { type VideoElementLike } from './media-session-adapter.js';
export interface NativeVideoAdapterOptions extends EngineHooks {
    readonly video: VideoElementLike;
    readonly surface?: NativeVideoSurface;
    readonly crossOrigin?: 'anonymous' | 'use-credentials';
    readonly now?: () => number;
}
export interface NativeVideoSurface {
    createVideo(): VideoElementLike;
    stage(video: VideoElementLike): void;
    reveal(video: VideoElementLike, previous: VideoElementLike): void;
    remove(video: VideoElementLike): void;
}
export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export declare function createNativeVideoAdapter(options: NativeVideoAdapterOptions): LivePlayerAdapter;
