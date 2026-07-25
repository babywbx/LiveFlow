import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js';
import type { EngineHooks } from '../shared/diagnostics.js';
export interface VideoJsHostElementLike {
    querySelector(selectors: string): unknown;
}
export interface VideoJsPlayerLike {
    el(): VideoJsHostElementLike | null;
    on(event: string, handler: (...args: readonly unknown[]) => void): void;
    off(event: string, handler: (...args: readonly unknown[]) => void): void;
    dispose(): void;
}
export interface VideoJsSurface {
    stage(player: VideoJsPlayerLike): void;
    reveal(player: VideoJsPlayerLike, previous: VideoJsPlayerLike): void;
    remove(player: VideoJsPlayerLike): void;
}
export interface VideoJsAdapterOptions extends EngineHooks {
    readonly player: VideoJsPlayerLike;
    readonly createPlayer: (source: LiveSource, generation: number) => VideoJsPlayerLike | Promise<VideoJsPlayerLike>;
    readonly surface?: VideoJsSurface;
    readonly now?: () => number;
}
export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export declare function createVideoJsAdapter(options: VideoJsAdapterOptions): LivePlayerAdapter;
