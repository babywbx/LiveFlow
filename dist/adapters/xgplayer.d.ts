import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js';
import type { EngineHooks } from '../shared/diagnostics.js';
import type { VideoElementLike } from './media-session-adapter.js';
export interface XgPlayerLike {
    readonly media?: VideoElementLike | null;
    readonly video?: VideoElementLike | null;
    readonly root?: HTMLElement | null;
    on(event: string, handler: (...args: readonly unknown[]) => void): void;
    off(event: string, handler: (...args: readonly unknown[]) => void): void;
    destroy(): void;
}
export interface XgPlayerSurface {
    stage(player: XgPlayerLike): void;
    reveal(player: XgPlayerLike, previous: XgPlayerLike): void;
    remove(player: XgPlayerLike): void;
}
export interface XgPlayerAdapterOptions extends EngineHooks {
    readonly player: XgPlayerLike;
    readonly createPlayer: (source: LiveSource, generation: number) => XgPlayerLike | Promise<XgPlayerLike>;
    readonly surface?: XgPlayerSurface;
    readonly now?: () => number;
}
export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export declare function createXgPlayerAdapter(options: XgPlayerAdapterOptions): LivePlayerAdapter;
