import { createSystemClock } from '../shared/clock.js';
import { AssetResolutionError } from '../shared/errors.js';
import { InvalidOverlayConfigurationError, OverlayDestroyedError } from './errors.js';
import { fitBannerText, normalizeBannerText, smallestBannerFontSize, validateBannerFontSizes, } from './event-banner-text.js';
export const DEFAULT_EVENT_BANNER_LIMITS = {
    maxActiveBanners: 2,
    maxTextLength: 512,
};
export const MAX_EVENT_BANNER_LIMITS = {
    maxActiveBanners: 8,
    maxTextLength: 1_024,
};
const BANNER_ATTRIBUTE = 'data-liveflow-event-banner';
const TEXT_ATTRIBUTE = 'data-liveflow-event-banner-text';
const MAX_STYLE_TEXT_LENGTH = 256;
const MAX_ASSET_KEY_LENGTH = 128;
const ENTRY_MOTION_MS = 240;
const ENTRY_MOTION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SHADOW_OFFSET = 2;
const SHADOW_BLUR = 3;
export function createEventBannerPresenter(options) {
    const surface = options.surface;
    const layout = resolveLayout(options.layout);
    const maxActiveBanners = resolveLimit(options.maxActiveBanners, DEFAULT_EVENT_BANNER_LIMITS.maxActiveBanners, MAX_EVENT_BANNER_LIMITS.maxActiveBanners, 'maxActiveBanners');
    const maxTextLength = resolveLimit(options.maxTextLength, DEFAULT_EVENT_BANNER_LIMITS.maxTextLength, MAX_EVENT_BANNER_LIMITS.maxTextLength, 'maxTextLength');
    const reducedMotion = options.reducedMotion === true;
    const clock = options.clock ?? createSystemClock();
    const measure = (text, fontSize) => surface.measureText(text, fontSize, layout.font);
    const active = new Set();
    let destroyed = false;
    return {
        present(content, presentation) {
            if (destroyed) {
                throw new OverlayDestroyedError('event-banner-presenter');
            }
            if (presentation === 'suppressed') {
                return inertHandle();
            }
            const model = resolveContent(content, maxTextLength);
            if (presentation === 'compact' || model.assetKey === null) {
                return mount(createCompactBanner(model));
            }
            const assetKey = model.assetKey;
            const assetUrl = resolveAssetUrl(assetKey);
            if (assetUrl === null) {
                reportAssetError(assetKey);
                return mount(createCompactBanner(model));
            }
            return mount(createFullBanner(model, assetKey, assetUrl));
        },
        activeCount() {
            return active.size;
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            for (const banner of [...active]) {
                release(banner);
            }
        },
    };
    function mount(banner) {
        while (active.size >= maxActiveBanners) {
            const oldest = active.values().next().value;
            if (oldest === undefined) {
                break;
            }
            release(oldest);
        }
        prepareEntryMotion(banner);
        active.add(banner);
        surface.mount(banner.root);
        startEntryMotion(banner);
        let released = false;
        return {
            destroy() {
                if (released) {
                    return;
                }
                released = true;
                release(banner);
            },
        };
    }
    function release(banner) {
        if (banner.frame !== null) {
            clock.cancelFrame(banner.frame);
            banner.frame = null;
        }
        active.delete(banner);
        banner.root.remove();
    }
    function prepareEntryMotion(banner) {
        if (reducedMotion) {
            return;
        }
        banner.root.setStyle('opacity', '0');
        banner.root.setStyle('transform', 'translate(-50%, 10px)');
        banner.root.setStyle('transition', `opacity ${String(ENTRY_MOTION_MS)}ms ${ENTRY_MOTION_EASING}, transform ${String(ENTRY_MOTION_MS)}ms ${ENTRY_MOTION_EASING}`);
    }
    function startEntryMotion(banner) {
        if (reducedMotion) {
            return;
        }
        banner.frame = clock.requestFrame(() => {
            banner.frame = null;
            if (!banner.root.isMounted()) {
                return;
            }
            banner.root.setStyle('opacity', '1');
            banner.root.setStyle('transform', 'translate(-50%, 0)');
        });
    }
    function createFullBanner(model, assetKey, assetUrl) {
        const root = surface.createElement('root');
        applyRootAttributes(root, model, 'full');
        applySharedRootStyle(root, layout);
        root.setStyle('width', `min(${String(layout.maxWidthPercent)}%, ${String(layout.width)}px)`);
        root.setStyle('aspect-ratio', `${String(layout.width)} / ${String(layout.height)}`);
        root.setStyle('container-type', 'inline-size');
        root.setStyle('overflow', 'hidden');
        const image = surface.createImage();
        image.setSource(assetUrl);
        image.setAttribute('alt', model.assetAlt ?? '');
        if (model.assetAlt === null) {
            image.setAttribute('aria-hidden', 'true');
        }
        image.setAttribute('draggable', 'false');
        image.setAttribute('decoding', 'async');
        image.setStyle('position', 'absolute');
        image.setStyle('inset', '0');
        image.setStyle('width', '100%');
        image.setStyle('height', '100%');
        image.setStyle('object-fit', 'fill');
        image.setStyle('pointer-events', 'none');
        root.append(image);
        const fit = fitBannerText(model.text, layout.maxTextWidth, layout.fontSizes, measure);
        const text = surface.createElement('text');
        text.setAttribute(TEXT_ATTRIBUTE, '');
        text.setText(fit.text);
        if (fit.truncated) {
            text.setAttribute('title', model.text);
        }
        applySharedTextStyle(text, layout);
        text.setStyle('position', 'absolute');
        text.setStyle('z-index', '1');
        text.setStyle('top', percent(layout.textTop, layout.height));
        text.setStyle('left', percent(layout.textLeft, layout.width));
        text.setStyle('width', percent(layout.maxTextWidth, layout.width));
        text.setStyle('font-size', containerWidth(fit.fontSize, layout.width));
        text.setStyle('line-height', '1.25');
        if (layout.outlineColor !== null) {
            text.setStyle('-webkit-text-stroke', `${containerWidth(layout.outlineWidth, layout.width)} ${layout.outlineColor}`);
            text.setStyle('paint-order', 'stroke fill');
        }
        text.setStyle('text-shadow', `0 ${containerWidth(SHADOW_OFFSET, layout.width)} ${containerWidth(SHADOW_BLUR, layout.width)} rgb(0 0 0 / 28%)`);
        root.append(text);
        const banner = { root, text, frame: null };
        image.onLoadError(() => {
            if (!active.has(banner)) {
                return;
            }
            image.remove();
            applyCompactRootStyle(root, layout);
            applyCompactTextStyle(text, layout);
            root.setAttribute(BANNER_ATTRIBUTE, 'compact');
            reportAssetError(assetKey);
        });
        return banner;
    }
    function createCompactBanner(model) {
        const root = surface.createElement('root');
        applyRootAttributes(root, model, 'compact');
        applyCompactRootStyle(root, layout);
        const text = surface.createElement('text');
        text.setAttribute(TEXT_ATTRIBUTE, '');
        text.setText(model.text);
        applyCompactTextStyle(text, layout);
        root.append(text);
        return { root, text, frame: null };
    }
    function resolveAssetUrl(assetKey) {
        if (options.assetResolver === undefined) {
            return null;
        }
        let candidate;
        try {
            candidate = options.assetResolver.resolve(assetKey);
        }
        catch {
            return null;
        }
        if (candidate === null) {
            return null;
        }
        try {
            const url = new URL(candidate, surface.baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') {
                return null;
            }
            return url.href;
        }
        catch {
            return null;
        }
    }
    function reportAssetError(assetKey) {
        if (options.onAssetError === undefined) {
            return;
        }
        try {
            options.onAssetError(new AssetResolutionError(assetKey));
        }
        catch {
            return;
        }
    }
}
function applyRootAttributes(root, model, presentation) {
    root.setAttribute(BANNER_ATTRIBUTE, presentation);
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-label', model.label);
}
function applySharedRootStyle(root, layout) {
    root.setStyle('position', 'absolute');
    root.setStyle('left', '50%');
    root.setStyle('bottom', `${String(layout.bottomPercent)}%`);
    root.setStyle('z-index', String(layout.zIndex));
    root.setStyle('transform', 'translate(-50%, 0)');
    root.setStyle('pointer-events', 'none');
    root.setStyle('user-select', 'none');
}
function applyCompactRootStyle(root, layout) {
    applySharedRootStyle(root, layout);
    root.setStyle('width', 'max-content');
    root.setStyle('max-width', `${String(layout.maxWidthPercent)}%`);
    root.setStyle('aspect-ratio', 'auto');
    root.setStyle('container-type', 'normal');
    root.setStyle('overflow', 'hidden');
    root.setStyle('padding', '10px 14px');
    root.setStyle('border-radius', '14px');
    root.setStyle('background', 'rgb(15 18 28 / 88%)');
}
function applySharedTextStyle(text, layout) {
    text.setStyle('overflow', 'hidden');
    text.setStyle('white-space', 'nowrap');
    text.setStyle('color', layout.textColor);
    text.setStyle('font-family', layout.font.family);
    text.setStyle('font-weight', layout.font.weight);
    text.setStyle('letter-spacing', '0.01em');
    text.setStyle('pointer-events', 'none');
}
function applyCompactTextStyle(text, layout) {
    applySharedTextStyle(text, layout);
    text.setStyle('position', 'static');
    text.setStyle('display', 'block');
    text.setStyle('top', 'auto');
    text.setStyle('left', 'auto');
    text.setStyle('width', 'auto');
    text.setStyle('text-overflow', 'ellipsis');
    text.setStyle('font-size', `${String(smallestBannerFontSize(layout.fontSizes))}px`);
    text.setStyle('line-height', '1.3');
    if (layout.outlineColor !== null) {
        text.setStyle('-webkit-text-stroke', `1px ${layout.outlineColor}`);
        text.setStyle('paint-order', 'stroke fill');
    }
    text.setStyle('text-shadow', '0 1px 3px rgb(0 0 0 / 32%)');
}
function resolveContent(content, maxTextLength) {
    const text = normalizeBannerText(content.text, maxTextLength, 'content.text');
    const label = content.label === undefined
        ? text
        : normalizeBannerText(content.label, maxTextLength, 'content.label');
    const assetKey = content.assetKey === undefined
        ? null
        : normalizeBannerText(content.assetKey, MAX_ASSET_KEY_LENGTH, 'content.assetKey');
    const assetAlt = content.assetAlt === undefined
        ? null
        : normalizeBannerText(content.assetAlt, maxTextLength, 'content.assetAlt');
    return { text, label, assetKey, assetAlt };
}
function resolveLayout(layout) {
    const width = positiveNumber(layout.width, 'layout.width');
    const height = positiveNumber(layout.height, 'layout.height');
    const textTop = boundedNumber(layout.textTop, height, 'layout.textTop');
    const textLeft = boundedNumber(layout.textLeft, width, 'layout.textLeft');
    const maxTextWidth = positiveNumber(layout.maxTextWidth, 'layout.maxTextWidth');
    if (textLeft + maxTextWidth > width) {
        throw new InvalidOverlayConfigurationError('layout.maxTextWidth');
    }
    const fontSizes = validateBannerFontSizes(layout.fontSizes);
    const family = boundedStyleText(layout.fontFamily, 'layout.fontFamily');
    const weight = boundedStyleText(layout.fontWeight ?? '700', 'layout.fontWeight');
    const textColor = boundedStyleText(layout.textColor ?? '#FFFFFF', 'layout.textColor');
    const outlineColor = layout.outlineColor === undefined
        ? null
        : boundedStyleText(layout.outlineColor, 'layout.outlineColor');
    const outlineWidth = boundedNumber(layout.outlineWidth ?? 2, width, 'layout.outlineWidth');
    const maxWidthPercent = percentValue(layout.maxWidthPercent ?? 92, 'layout.maxWidthPercent');
    const bottomPercent = percentValue(layout.bottomPercent ?? 12, 'layout.bottomPercent');
    const zIndex = layout.zIndex ?? 30;
    if (!Number.isSafeInteger(zIndex)) {
        throw new InvalidOverlayConfigurationError('layout.zIndex');
    }
    return {
        width,
        height,
        textTop,
        textLeft,
        maxTextWidth,
        fontSizes,
        font: { family, weight },
        textColor,
        outlineColor,
        outlineWidth,
        maxWidthPercent,
        bottomPercent,
        zIndex,
    };
}
function resolveLimit(input, fallback, ceiling, field) {
    const value = input ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
        throw new InvalidOverlayConfigurationError(field);
    }
    return value;
}
function positiveNumber(value, field) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new InvalidOverlayConfigurationError(field);
    }
    return value;
}
function boundedNumber(value, ceiling, field) {
    if (!Number.isFinite(value) || value < 0 || value > ceiling) {
        throw new InvalidOverlayConfigurationError(field);
    }
    return value;
}
function percentValue(value, field) {
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
        throw new InvalidOverlayConfigurationError(field);
    }
    return value;
}
function boundedStyleText(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STYLE_TEXT_LENGTH) {
        throw new InvalidOverlayConfigurationError(field);
    }
    return value;
}
function percent(value, total) {
    return `${String(round((value / total) * 100))}%`;
}
function containerWidth(value, total) {
    return `${String(round((value / total) * 100))}cqw`;
}
function round(value) {
    return Math.round(value * 1_000) / 1_000;
}
function inertHandle() {
    return {
        destroy() { },
    };
}
