import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js';
import type { EngineHooks } from '../shared/diagnostics.js';
import type { VideoElementLike } from './media-session-adapter.js';
export interface DPlayerLike {
    readonly video: VideoElementLike;
    readonly container?: HTMLElement;
    on(event: string, handler: (...args: readonly unknown[]) => void): void;
    destroy(): void;
}
export interface DPlayerSurface {
    stage(player: DPlayerLike): void;
    reveal(player: DPlayerLike, previous: DPlayerLike): void;
    remove(player: DPlayerLike): void;
}
export interface DPlayerAdapterOptions extends EngineHooks {
    readonly player: DPlayerLike;
    readonly createPlayer: (source: LiveSource, generation: number) => DPlayerLike | Promise<DPlayerLike>;
    readonly surface?: DPlayerSurface;
    readonly now?: () => number;
}
export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export declare function createDPlayerAdapter(options: DPlayerAdapterOptions): LivePlayerAdapter;
