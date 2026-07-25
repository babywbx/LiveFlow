import type { BannerTextFit, BannerTextMeasure } from './event-banner-types.js';
export declare const MAX_BANNER_FONT_STEPS = 8;
export declare function normalizeBannerText(value: string, maxLength: number, field: string): string;
export declare function validateBannerFontSizes(fontSizes: readonly number[]): readonly number[];
export declare function smallestBannerFontSize(fontSizes: readonly number[]): number;
export declare function fitBannerText(text: string, maxWidth: number, fontSizes: readonly number[], measure: BannerTextMeasure): BannerTextFit;
