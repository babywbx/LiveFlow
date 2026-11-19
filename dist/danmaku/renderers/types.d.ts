import type { Destroyable } from '../../shared/disposable.js';
import type { DanmakuIdentity, DanmakuLayout, DanmakuRenderer } from '../types.js';
export interface AssetResolver {
    resolve(assetKey: string): string | null;
}
export interface IdentityRenderer {
    render(identity: DanmakuIdentity, container: HTMLElement): Destroyable;
}
export interface TextRenderer {
    render(text: string, container: HTMLElement): void;
}
export interface DomDanmakuRendererOptions {
    readonly container: HTMLElement;
    readonly layout?: DanmakuLayout;
    readonly maxPoolSize?: number;
    readonly maxBadgesPerMessage?: number;
    readonly maxTextLength?: number;
    readonly maxMeasurementsPerFrame?: number;
    readonly backgroundColor?: string;
    readonly fallbackTextColor?: string;
    readonly minimumContrastRatio?: number;
    readonly reducedMotion?: boolean;
    readonly assetResolver?: AssetResolver;
    readonly identityRenderer?: IdentityRenderer;
    readonly textRenderer?: TextRenderer;
    readonly onAssetError?: (assetKey: string) => void;
}
export type { DanmakuRenderer };
