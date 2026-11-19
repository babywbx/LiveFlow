import type { TextRenderer } from './renderers/types.js';
export interface InlineImage {
    readonly src: string;
    readonly stillSrc?: string;
    readonly alt?: string;
    readonly aspectRatio?: number;
    readonly trim?: {
        readonly left?: number;
        readonly right?: number;
    };
}
export interface InlineImageRendererOptions {
    readonly pattern: RegExp;
    resolve(token: string): InlineImage | null;
    readonly maxImagesPerMessage?: number;
    readonly reducedMotion?: boolean;
    readonly onError?: (token: string) => void;
}
export declare const DEFAULT_MAX_INLINE_IMAGES = 16;
export declare const EMOJI_PATTERN: RegExp;
export declare function createInlineImageRenderer(options: InlineImageRendererOptions): TextRenderer;
