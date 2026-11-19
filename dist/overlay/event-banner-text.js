import { InvalidOverlayConfigurationError, InvalidOverlayEventError } from './errors.js';
export const MAX_BANNER_FONT_STEPS = 8;
const ELLIPSIS = '…';
let segmenter;
export function normalizeBannerText(value, maxLength, field) {
    if (typeof value !== 'string' || value.length > maxLength) {
        throw new InvalidOverlayEventError(field);
    }
    const text = value.replace(/\s+/gu, ' ').trim();
    if (text.length === 0) {
        throw new InvalidOverlayEventError(field);
    }
    return text;
}
export function validateBannerFontSizes(fontSizes) {
    const candidate = fontSizes;
    if (!Array.isArray(candidate)) {
        throw new InvalidOverlayConfigurationError('layout.fontSizes');
    }
    const count = fontSizes.length;
    if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_BANNER_FONT_STEPS) {
        throw new InvalidOverlayConfigurationError('layout.fontSizes');
    }
    const validated = [];
    let previous = Number.POSITIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
        const fontSize = fontSizes[index];
        if (fontSize === undefined ||
            !Number.isFinite(fontSize) ||
            fontSize <= 0 ||
            fontSize >= previous) {
            throw new InvalidOverlayConfigurationError('layout.fontSizes');
        }
        validated.push(fontSize);
        previous = fontSize;
    }
    return validated;
}
export function smallestBannerFontSize(fontSizes) {
    const smallest = fontSizes[fontSizes.length - 1];
    if (smallest === undefined) {
        throw new InvalidOverlayConfigurationError('layout.fontSizes');
    }
    return smallest;
}
export function fitBannerText(text, maxWidth, fontSizes, measure) {
    const steps = validateBannerFontSizes(fontSizes);
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
        throw new InvalidOverlayConfigurationError('layout.maxTextWidth');
    }
    if (text.length === 0) {
        throw new InvalidOverlayEventError('content.text');
    }
    for (const fontSize of steps) {
        if (measuredWidth(text, fontSize, measure) <= maxWidth) {
            return { text, fontSize, truncated: false };
        }
    }
    const fontSize = smallestBannerFontSize(steps);
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const graphemes = segmenter.segment(text);
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const grapheme = graphemes.containing(middle - 1);
        if (grapheme === undefined) {
            throw new InvalidOverlayEventError('content.text');
        }
        const end = grapheme.index + grapheme.segment.length;
        const candidate = `${text.slice(0, end)}${ELLIPSIS}`;
        if (measuredWidth(candidate, fontSize, measure) <= maxWidth) {
            low = end;
        }
        else {
            high = grapheme.index;
        }
    }
    const truncated = `${text.slice(0, low)}${ELLIPSIS}`;
    if (measuredWidth(truncated, fontSize, measure) > maxWidth) {
        throw new InvalidOverlayConfigurationError('layout.maxTextWidth');
    }
    return { text: truncated, fontSize, truncated: true };
}
function measuredWidth(text, fontSize, measure) {
    const width = measure(text, fontSize);
    if (!Number.isFinite(width) || width < 0) {
        throw new InvalidOverlayConfigurationError('measureText');
    }
    return width;
}
