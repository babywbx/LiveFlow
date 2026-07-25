import type { AssetResolver } from '../danmaku/renderers/types.js';
import type { Clock } from '../shared/clock.js';
import type { Destroyable } from '../shared/disposable.js';
import type { AssetResolutionError } from '../shared/errors.js';
import type { OverlayPresentation } from './types.js';
export type BannerElementKind = 'root' | 'text';
export interface BannerFont {
    readonly family: string;
    readonly weight: string;
}
export type BannerTextMeasure = (text: string, fontSize: number) => number;
export type BannerSurfaceTextMeasure = (text: string, fontSize: number, font: BannerFont) => number;
export interface BannerElement {
    setAttribute(name: string, value: string): void;
    setStyle(property: string, value: string): void;
    setText(text: string): void;
    append(child: BannerElement): void;
    remove(): void;
    isMounted(): boolean;
}
export interface BannerImageElement extends BannerElement {
    setSource(url: string): void;
    onLoadError(listener: () => void): void;
}
export interface BannerSurface {
    readonly baseUrl: string;
    createElement(kind: BannerElementKind): BannerElement;
    createImage(): BannerImageElement;
    mount(element: BannerElement): void;
    measureText(text: string, fontSize: number, font: BannerFont): number;
}
export interface BannerLayout {
    readonly width: number;
    readonly height: number;
    readonly textTop: number;
    readonly textLeft: number;
    readonly maxTextWidth: number;
    readonly fontSizes: readonly number[];
    readonly fontFamily: string;
    readonly fontWeight?: string;
    readonly textColor?: string;
    readonly outlineColor?: string;
    readonly outlineWidth?: number;
    readonly maxWidthPercent?: number;
    readonly bottomPercent?: number;
    readonly zIndex?: number;
}
export interface BannerContent {
    readonly text: string;
    readonly label?: string;
    readonly assetKey?: string;
    readonly assetAlt?: string;
}
export interface BannerTextFit {
    readonly text: string;
    readonly fontSize: number;
    readonly truncated: boolean;
}
export interface EventBannerLimits {
    readonly maxActiveBanners: number;
    readonly maxTextLength: number;
}
export interface EventBannerPresenterOptions {
    readonly surface: BannerSurface;
    readonly layout: BannerLayout;
    readonly assetResolver?: AssetResolver;
    readonly clock?: Clock;
    readonly maxActiveBanners?: number;
    readonly maxTextLength?: number;
    readonly reducedMotion?: boolean;
    readonly onAssetError?: (error: AssetResolutionError) => void;
}
export interface EventBannerPresenter extends Destroyable {
    present(content: BannerContent, presentation: OverlayPresentation): Destroyable;
    activeCount(): number;
}
export interface DomBannerSurfaceOptions {
    readonly measureText?: BannerSurfaceTextMeasure;
}
