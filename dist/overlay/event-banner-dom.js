import { InvalidOverlayConfigurationError } from './errors.js';
export function createDomBannerSurface(container, options = {}) {
    const document = container.ownerDocument;
    const nodes = new WeakMap();
    let canvasMeasure = null;
    return {
        get baseUrl() {
            return document.baseURI;
        },
        createElement(kind) {
            const node = document.createElement(kind === 'root' ? 'section' : 'span');
            const element = createDomElement(node, nodes);
            nodes.set(element, node);
            return element;
        },
        createImage() {
            const node = document.createElement('img');
            const controller = new AbortController();
            const element = {
                ...createDomElement(node, nodes, controller),
                setSource(url) {
                    node.src = url;
                },
                onLoadError(listener) {
                    node.addEventListener('error', listener, { once: true, signal: controller.signal });
                },
            };
            nodes.set(element, node);
            return element;
        },
        mount(element) {
            container.append(nodeOf(nodes, element));
        },
        measureText(text, fontSize, font) {
            if (options.measureText !== undefined) {
                return options.measureText(text, fontSize, font);
            }
            canvasMeasure ??= createCanvasMeasure(document);
            return canvasMeasure(text, fontSize, font);
        },
    };
}
function createDomElement(node, nodes, controller) {
    return {
        setAttribute(name, value) {
            node.setAttribute(name, value);
        },
        setStyle(property, value) {
            node.style.setProperty(property, value);
        },
        setText(text) {
            node.textContent = text;
        },
        append(child) {
            node.append(nodeOf(nodes, child));
        },
        remove() {
            controller?.abort();
            node.remove();
        },
        isMounted() {
            return node.isConnected;
        },
    };
}
function nodeOf(nodes, element) {
    const node = nodes.get(element);
    if (node === undefined) {
        throw new InvalidOverlayConfigurationError('surface.element');
    }
    return node;
}
function createCanvasMeasure(document) {
    let context;
    try {
        context = document.createElement('canvas').getContext('2d');
    }
    catch {
        context = null;
    }
    if (context === null) {
        return approximateTextWidth;
    }
    const measureContext = context;
    return (text, fontSize, font) => {
        measureContext.font = `${font.weight} ${String(fontSize)}px ${font.family}`;
        return measureContext.measureText(text).width;
    };
}
function approximateTextWidth(text, fontSize) {
    let units = 0;
    for (const character of text) {
        units += (character.codePointAt(0) ?? 0) <= 0xff ? 0.56 : 1;
    }
    return units * fontSize;
}
