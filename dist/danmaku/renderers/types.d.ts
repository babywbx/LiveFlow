import type { Destroyable } from '../../shared/disposable.js';
import type { DanmakuIdentity, DanmakuRenderer } from '../types.js';
export interface AssetResolver {
    resolve(assetKey: string): string | null;
}
export interface IdentityRenderer {
    render(identity: DanmakuIdentity, container: HTMLElement): Destroyable;
}
export interface DomDanmakuRendererOptions {
    readonly container: HTMLElement;
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
    readonly onAssetError?: (assetKey: string) => void;
}
export type { DanmakuRenderer };
