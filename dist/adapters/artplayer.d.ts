import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js';
import type { EngineHooks } from '../shared/diagnostics.js';
import { type VideoElementLike } from './media-session-adapter.js';
export interface ArtPlayerLike<OverlayContainer = HTMLElement> {
    readonly video: VideoElementLike;
    readonly container?: HTMLElement;
    readonly overlayContainer?: OverlayContainer;
    on(event: string, handler: (...args: readonly unknown[]) => void): void;
    off(event: string, handler: (...args: readonly unknown[]) => void): void;
    setMutex(enabled: boolean): void;
    destroy(): void;
}
export interface ArtPlayerCreationOptions {
    readonly mutex: false;
}
export interface ArtPlayerSurface<OverlayContainer = HTMLElement> {
    stage(player: ArtPlayerLike<OverlayContainer>): void;
    reveal(player: ArtPlayerLike<OverlayContainer>, previous: ArtPlayerLike<OverlayContainer>): void;
    remove(player: ArtPlayerLike<OverlayContainer>): void;
}
export interface ArtPlayerAdapterOptions<OverlayContainer = HTMLElement> extends EngineHooks {
    readonly player: ArtPlayerLike<OverlayContainer>;
    readonly createPlayer: (source: LiveSource, generation: number, options: ArtPlayerCreationOptions) => ArtPlayerLike<OverlayContainer> | Promise<ArtPlayerLike<OverlayContainer>>;
    readonly surface?: ArtPlayerSurface<OverlayContainer>;
    readonly overlayContainer?: OverlayContainer;
    readonly now?: () => number;
}
export interface ArtPlayerAdapter<OverlayContainer = HTMLElement> extends LivePlayerAdapter {
    getOverlayContainer(): OverlayContainer | null;
}
export type { TimeRangesLike, VideoElementLike } from './media-session-adapter.js';
export { PlayerAdapterError } from './adapter-error.js';
export declare function createArtPlayerAdapter<OverlayContainer = HTMLElement>(options: ArtPlayerAdapterOptions<OverlayContainer>): ArtPlayerAdapter<OverlayContainer>;
