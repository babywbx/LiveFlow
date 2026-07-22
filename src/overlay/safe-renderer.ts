import type { Destroyable } from '../shared/disposable.js'
import type {
  OverlayNode,
  OverlayPresentation,
  OverlayRenderer,
  RealtimeOverlayEvent,
  SafeOverlayRendererOptions,
} from './types.js'

export function createSafeOverlayRenderer(
  container: HTMLElement,
  options: SafeOverlayRendererOptions = {},
): OverlayRenderer {
  return {
    render(event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable {
      const root = container.ownerDocument.createElement('section')
      root.setAttribute('data-liveflow-overlay-card', presentation)
      root.setAttribute('aria-live', 'polite')

      const nodes = presentation === 'compact' ? event.nodes.slice(0, 1) : event.nodes
      for (const node of nodes) {
        const element = renderNode(container.ownerDocument, node, options)
        if (element !== null) {
          root.append(element)
        }
      }
      container.append(root)

      let destroyed = false
      return {
        destroy(): void {
          if (destroyed) {
            return
          }
          destroyed = true
          root.remove()
        },
      }
    },
    destroy(): void {},
  }
}

function renderNode(
  document: Document,
  node: OverlayNode,
  options: SafeOverlayRendererOptions,
): HTMLElement | null {
  if (node.type === 'text') {
    const element = document.createElement('span')
    element.textContent = node.text
    return element
  }
  if (node.type === 'metric') {
    const element = document.createElement('span')
    const label = document.createElement('span')
    const value = document.createElement('span')
    label.textContent = node.label
    value.textContent = node.value
    element.append(label, value)
    return element
  }
  if (node.type === 'identity') {
    const element = document.createElement('span')
    element.textContent = node.identity.label
    return element
  }
  if (options.assetResolver === undefined) {
    return null
  }

  const resolved = resolveAssetUrl(document, node.assetKey, options)
  if (resolved === null) {
    return null
  }
  const image = document.createElement('img')
  image.src = resolved
  image.alt = node.alt
  return image
}

function resolveAssetUrl(
  document: Document,
  assetKey: string,
  options: SafeOverlayRendererOptions,
): string | null {
  let candidate: string | null
  try {
    candidate = options.assetResolver?.resolve(assetKey) ?? null
  } catch {
    return null
  }
  if (candidate === null) {
    return null
  }
  try {
    const url = new URL(candidate, document.baseURI)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:'
      ? url.href
      : null
  } catch {
    return null
  }
}
