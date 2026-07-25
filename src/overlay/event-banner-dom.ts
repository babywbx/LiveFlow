import { InvalidOverlayConfigurationError } from './errors.js'
import type {
  BannerElement,
  BannerElementKind,
  BannerFont,
  BannerImageElement,
  BannerSurface,
  BannerSurfaceTextMeasure,
  DomBannerSurfaceOptions,
} from './event-banner-types.js'

type NodeRegistry = WeakMap<BannerElement, HTMLElement>

export function createDomBannerSurface(
  container: HTMLElement,
  options: DomBannerSurfaceOptions = {},
): BannerSurface {
  const document = container.ownerDocument
  const nodes: NodeRegistry = new WeakMap()
  let canvasMeasure: BannerSurfaceTextMeasure | null = null

  return {
    get baseUrl(): string {
      return document.baseURI
    },
    createElement(kind: BannerElementKind): BannerElement {
      const node = document.createElement(kind === 'root' ? 'section' : 'span')
      const element = createDomElement(node, nodes)
      nodes.set(element, node)
      return element
    },
    createImage(): BannerImageElement {
      const node = document.createElement('img')
      const controller = new AbortController()
      const element: BannerImageElement = {
        ...createDomElement(node, nodes, controller),
        setSource(url: string): void {
          node.src = url
        },
        onLoadError(listener: () => void): void {
          node.addEventListener('error', listener, { once: true, signal: controller.signal })
        },
      }
      nodes.set(element, node)
      return element
    },
    mount(element: BannerElement): void {
      container.append(nodeOf(nodes, element))
    },
    measureText(text: string, fontSize: number, font: BannerFont): number {
      if (options.measureText !== undefined) {
        return options.measureText(text, fontSize, font)
      }
      canvasMeasure ??= createCanvasMeasure(document)
      return canvasMeasure(text, fontSize, font)
    },
  }
}

function createDomElement(
  node: HTMLElement,
  nodes: NodeRegistry,
  controller?: AbortController,
): BannerElement {
  return {
    setAttribute(name: string, value: string): void {
      node.setAttribute(name, value)
    },
    setStyle(property: string, value: string): void {
      node.style.setProperty(property, value)
    },
    setText(text: string): void {
      node.textContent = text
    },
    append(child: BannerElement): void {
      node.append(nodeOf(nodes, child))
    },
    remove(): void {
      controller?.abort()
      node.remove()
    },
    isMounted(): boolean {
      return node.isConnected
    },
  }
}

function nodeOf(nodes: NodeRegistry, element: BannerElement): HTMLElement {
  const node = nodes.get(element)
  if (node === undefined) {
    throw new InvalidOverlayConfigurationError('surface.element')
  }
  return node
}

// The measurement canvas stays lazy so module evaluation never touches the DOM.
function createCanvasMeasure(document: Document): BannerSurfaceTextMeasure {
  let context: CanvasRenderingContext2D | null
  try {
    context = document.createElement('canvas').getContext('2d')
  } catch {
    context = null
  }
  if (context === null) {
    return approximateTextWidth
  }
  const measureContext = context
  return (text: string, fontSize: number, font: BannerFont): number => {
    measureContext.font = `${font.weight} ${String(fontSize)}px ${font.family}`
    return measureContext.measureText(text).width
  }
}

function approximateTextWidth(text: string, fontSize: number): number {
  let units = 0
  for (const character of text) {
    units += (character.codePointAt(0) ?? 0) <= 0xff ? 0.56 : 1
  }
  return units * fontSize
}
