import { InvalidDanmakuConfigurationError } from './errors.js';
export const DEFAULT_MAX_INLINE_IMAGES = 16;
export const EMOJI_PATTERN = /[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?)*/gu;
const IMAGE_SIZE = 'var(--liveflow-danmaku-image-size, 1.2em)';
const IMAGE_ALIGN = 'var(--liveflow-danmaku-image-align, -0.15em)';
const IMAGE_BLOCK = `calc((1em - ${IMAGE_SIZE}) / 2)`;
const IMAGE_GAP = 'var(--liveflow-danmaku-image-gap, 0px)';
export function createInlineImageRenderer(options) {
    const pattern = options.pattern;
    if (!(pattern instanceof RegExp) || !pattern.global) {
        throw new InvalidDanmakuConfigurationError('pattern');
    }
    const maxImages = options.maxImagesPerMessage ?? DEFAULT_MAX_INLINE_IMAGES;
    if (!Number.isSafeInteger(maxImages) || maxImages <= 0) {
        throw new InvalidDanmakuConfigurationError('maxImagesPerMessage');
    }
    let motionQuery;
    return {
        render(text, container) {
            let last = 0;
            let count = 0;
            for (const match of text.matchAll(pattern)) {
                if (count >= maxImages)
                    break;
                const token = match[0];
                const image = token === '' ? null : createImage(container.ownerDocument, token);
                if (image === null)
                    continue;
                if (match.index > last)
                    container.append(text.slice(last, match.index));
                container.append(image);
                last = match.index + token.length;
                count += 1;
            }
            if (last < text.length)
                container.append(last === 0 ? text : text.slice(last));
        },
    };
    function createImage(document, token) {
        try {
            const resolved = options.resolve(token);
            if (resolved === null)
                return null;
            const ratio = resolved.aspectRatio ?? 1;
            const left = resolved.trim?.left ?? 0;
            const right = resolved.trim?.right ?? 0;
            const src = safeUrl(reducedMotion(document) ? (resolved.stillSrc ?? resolved.src) : resolved.src, document);
            const valid = ratio > 0 && ratio < Infinity && left >= 0 && right >= 0 && left + right < 1;
            if (src === null || !valid)
                return failed(token);
            const width = `${IMAGE_SIZE} * ${String(ratio)}`;
            const image = document.createElement('img');
            image.className = 'liveflow-danmaku__image';
            image.alt = resolved.alt ?? token;
            image.decoding = 'async';
            image.draggable = false;
            image.style.display = 'inline-block';
            image.style.width = `calc(${width})`;
            image.style.marginLeft = `calc(${IMAGE_GAP} - ${width} * ${String(left)})`;
            image.style.marginRight = `calc(${IMAGE_GAP} - ${width} * ${String(right)})`;
            image.style.height = IMAGE_SIZE;
            image.style.marginTop = IMAGE_BLOCK;
            image.style.marginBottom = IMAGE_BLOCK;
            image.style.objectFit = 'contain';
            image.style.verticalAlign = IMAGE_ALIGN;
            image.addEventListener('error', () => {
                image.style.visibility = 'hidden';
                notify(token);
            }, { once: true });
            image.src = src;
            return image;
        }
        catch {
            return failed(token);
        }
    }
    function reducedMotion(document) {
        if (options.reducedMotion !== undefined)
            return options.reducedMotion;
        if (motionQuery === undefined) {
            const view = document.defaultView;
            motionQuery =
                typeof view?.matchMedia === 'function'
                    ? view.matchMedia('(prefers-reduced-motion: reduce)')
                    : null;
        }
        return motionQuery?.matches === true;
    }
    function failed(token) {
        notify(token);
        return null;
    }
    function notify(token) {
        try {
            options.onError?.(token);
        }
        catch {
            return;
        }
    }
}
function safeUrl(value, document) {
    try {
        const url = new URL(value, document.baseURI);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:'
            ? url.href
            : null;
    }
    catch {
        return null;
    }
}
