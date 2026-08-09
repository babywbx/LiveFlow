import { CapacityExceededError } from '../../shared/errors.js'
import {
  DanmakuRendererError,
  InvalidDanmakuConfigurationError,
  InvalidDanmakuMessageError,
} from '../errors.js'
import type {
  DanmakuMeasurement,
  DanmakuIdentity,
  DanmakuMessage,
  DanmakuRenderFrame,
  DanmakuRenderItem,
  DanmakuRenderer,
  DanmakuViewport,
} from '../types.js'
import { resolveAccessibleTextColor } from './color.js'
import type { DomDanmakuRendererOptions } from './types.js'

interface DomRecord {
  readonly root: HTMLDivElement
  readonly disposables: { destroy(): void }[]
  width: number
}

const DEFAULT_MAX_POOL_SIZE = 96
const DEFAULT_MAX_BADGES = 4
const DEFAULT_MAX_TEXT_LENGTH = 500
const DEFAULT_MAX_MEASUREMENTS = 8

export function createDomDanmakuRenderer(options: DomDanmakuRendererOptions): DanmakuRenderer {
  const maxPoolSize = validatePositiveInteger(
    options.maxPoolSize,
    DEFAULT_MAX_POOL_SIZE,
    'maxPoolSize',
  )
  const maxBadges = validatePositiveInteger(
    options.maxBadgesPerMessage,
    DEFAULT_MAX_BADGES,
    'maxBadgesPerMessage',
  )
  const maxTextLength = validatePositiveInteger(
    options.maxTextLength,
    DEFAULT_MAX_TEXT_LENGTH,
    'maxTextLength',
  )
  const maxMeasurements = validatePositiveInteger(
    options.maxMeasurementsPerFrame,
    DEFAULT_MAX_MEASUREMENTS,
    'maxMeasurementsPerFrame',
  )
  const minimumContrastRatio = options.minimumContrastRatio ?? 4.5
  if (!Number.isFinite(minimumContrastRatio) || minimumContrastRatio <= 0) {
    throw new InvalidDanmakuConfigurationError('minimumContrastRatio')
  }

  const document = options.container.ownerDocument
  const layer = document.createElement('div')
  const probe = document.createElement('div')
  const active = new Map<string, DomRecord>()
  const pool: HTMLDivElement[] = []
  const pendingDisposables: { destroy(): void }[] = []
  const pendingRoots = new Set<HTMLDivElement>()
  let viewport: DanmakuViewport = {
    width: Math.max(1, options.container.clientWidth),
    height: Math.max(1, options.container.clientHeight),
  }
  let destroyed = false
  let cleanupComplete = false
  let paused = false
  let reducedMotion = options.reducedMotion ?? false
  let mediaQuery: MediaQueryList | null = null

  try {
    configureLayer(layer)
    configureProbe(probe)
    layer.append(probe)
    options.container.append(layer)

    if (
      options.reducedMotion === undefined &&
      typeof document.defaultView?.matchMedia === 'function'
    ) {
      mediaQuery = document.defaultView.matchMedia('(prefers-reduced-motion: reduce)')
      reducedMotion = mediaQuery.matches
    }
    updateLayerState()
    mediaQuery?.addEventListener('change', handleReducedMotionChange)
  } catch {
    unbindMediaQuery()
    removeElement(probe)
    removeElement(layer)
    throw new DanmakuRendererError('initialize')
  }

  return {
    measure(messages: readonly DanmakuMessage[]): readonly DanmakuMeasurement[] {
      ensureActive()
      const measurements: DanmakuMeasurement[] = []
      for (const message of messages.slice(0, maxMeasurements)) {
        validateRenderableMessage(message)
        const disposables: { destroy(): void }[] = []
        try {
          populateNode(probe, message, disposables)
          const bounds = probe.getBoundingClientRect()
          const width = Math.max(1, bounds.width)
          const height = Math.max(1, bounds.height)
          measurements.push({ id: message.id, width, height })
        } catch (error) {
          const cleanupSucceeded = destroyDisposables(disposables)
          retainDisposables(disposables)
          resetElement(probe)
          if (!cleanupSucceeded) {
            throw new DanmakuRendererError('identity-destroy')
          }
          if (error instanceof Error) {
            throw error
          }
          throw new DanmakuRendererError('measure')
        }
        const cleanupSucceeded = destroyDisposables(disposables)
        retainDisposables(disposables)
        resetElement(probe)
        if (!cleanupSucceeded) {
          throw new DanmakuRendererError('identity-destroy')
        }
      }
      return measurements
    },
    render(frame: DanmakuRenderFrame): void {
      ensureActive()
      for (const id of frame.unmounts) {
        release(id)
      }

      const fragment = document.createDocumentFragment()
      for (const item of frame.mounts) {
        if (active.has(item.message.id)) {
          throw new InvalidDanmakuMessageError('id')
        }
        const record = acquire()
        try {
          populateNode(record.root, item.message, record.disposables)
        } catch (error) {
          recycleFailedRecord(record)
          if (error instanceof Error) {
            throw error
          }
          throw new DanmakuRendererError('render')
        }
        record.width = item.width
        applyPosition(record.root, item, record.width)
        active.set(item.message.id, record)
        fragment.append(record.root)
      }
      if (fragment.childNodes.length > 0) {
        layer.append(fragment)
      }
      for (const update of frame.updates) {
        const record = active.get(update.id)
        if (record !== undefined) {
          const x = reducedMotion ? Math.max(0, (viewport.width - record.width) / 2) : update.x
          record.root.style.transform = `translate3d(${String(x)}px, ${String(update.y)}px, 0)`
        }
      }
    },
    resize(nextViewport: DanmakuViewport): void {
      ensureActive()
      validateViewport(nextViewport)
      viewport = { ...nextViewport }
      layer.style.width = `${String(viewport.width)}px`
      layer.style.height = `${String(viewport.height)}px`
    },
    setPaused(nextPaused: boolean): void {
      ensureActive()
      paused = nextPaused
      updateLayerState()
    },
    destroy(): void {
      if (cleanupComplete) {
        return
      }
      destroyed = true
      let cleanupFailed = !retryPendingCleanup() || !unbindMediaQuery()
      let identityCleanupFailed = false
      for (const [id, record] of active) {
        const identitiesDestroyed = destroyDisposables(record.disposables)
        const rootRemoved = removeElement(record.root)
        identityCleanupFailed = !identitiesDestroyed || identityCleanupFailed
        cleanupFailed = !rootRemoved || cleanupFailed
        if (identitiesDestroyed && rootRemoved) {
          active.delete(id)
        }
      }
      cleanupFailed = identityCleanupFailed || cleanupFailed
      for (let index = pool.length - 1; index >= 0; index -= 1) {
        const root = pool[index]
        if (root !== undefined && removeElement(root)) {
          pool.splice(index, 1)
        } else {
          cleanupFailed = true
        }
      }
      cleanupFailed = !removeElement(probe) || cleanupFailed
      cleanupFailed = !removeElement(layer) || cleanupFailed
      if (cleanupFailed) {
        throw new DanmakuRendererError(identityCleanupFailed ? 'identity-destroy' : 'destroy')
      }
      cleanupComplete = true
    },
  }

  function acquire(): DomRecord {
    const pooled = pool.pop()
    if (pooled !== undefined) {
      return { root: pooled, disposables: [], width: 0 }
    }
    if (active.size + pool.length >= maxPoolSize) {
      throw new CapacityExceededError('danmaku-dom-nodes', maxPoolSize)
    }
    return {
      root: createRoot(document),
      disposables: [],
      width: 0,
    }
  }

  function release(id: string): void {
    const record = active.get(id)
    if (record === undefined) {
      return
    }
    const cleanupSucceeded = destroyDisposables(record.disposables)
    let rootReleased = true
    try {
      resetRoot(record.root)
      record.root.remove()
    } catch {
      rootReleased = false
    }
    if (cleanupSucceeded && rootReleased) {
      active.delete(id)
      if (pool.length < maxPoolSize) {
        pool.push(record.root)
      }
    }
    if (!cleanupSucceeded || !rootReleased) {
      throw new DanmakuRendererError('identity-destroy')
    }
  }

  function recycleFailedRecord(record: DomRecord): void {
    const cleanupSucceeded = destroyDisposables(record.disposables)
    retainDisposables(record.disposables)
    resetRoot(record.root)
    const rootRemoved = removeElement(record.root)
    if (!rootRemoved) {
      pendingRoots.add(record.root)
    }
    if (cleanupSucceeded && rootRemoved && pool.length < maxPoolSize) {
      pool.push(record.root)
    }
    if (!cleanupSucceeded || !rootRemoved) {
      throw new DanmakuRendererError('identity-destroy')
    }
  }

  function retainDisposables(disposables: { destroy(): void }[]): void {
    pendingDisposables.push(...disposables.splice(0))
  }

  function retryPendingCleanup(): boolean {
    const disposablesDestroyed = destroyDisposables(pendingDisposables)
    let rootsRemoved = true
    for (const root of pendingRoots) {
      if (removeElement(root)) {
        pendingRoots.delete(root)
      } else {
        rootsRemoved = false
      }
    }
    return disposablesDestroyed && rootsRemoved
  }

  function populateNode(
    root: HTMLElement,
    message: DanmakuMessage,
    disposables: { destroy(): void }[],
  ): void {
    resetElement(root)
    root.className = 'liveflow-danmaku__message'
    root.dataset.mode = message.mode

    const identities = message.identities
    const identityCount = Math.min(identities?.length ?? 0, maxBadges)
    for (let index = 0; index < identityCount; index += 1) {
      const identity = identities?.[index]
      if (identity === undefined) {
        throw new InvalidDanmakuMessageError('identities')
      }
      const identityNode = document.createElement('span')
      identityNode.className = 'liveflow-danmaku__identity'
      identityNode.dataset.kind = identity.kind
      if (identity.variant !== undefined) {
        identityNode.dataset.variant = identity.variant
      }
      if (options.identityRenderer !== undefined) {
        try {
          disposables.push(options.identityRenderer.render(identity, identityNode))
        } catch {
          throw new DanmakuRendererError('identity-render')
        }
      } else {
        renderDefaultIdentity(identityNode, identity)
      }
      root.append(identityNode)
    }

    const displayName = message.sender?.displayName
    if (displayName !== undefined && displayName.length > 0) {
      const sender = document.createElement('span')
      sender.className = 'liveflow-danmaku__sender'
      sender.textContent = displayName
      root.append(sender)

      const delimiter = document.createElement('span')
      delimiter.className = 'liveflow-danmaku__delimiter'
      delimiter.textContent = '：'
      root.append(delimiter)
    }

    const text = document.createElement('span')
    text.className = 'liveflow-danmaku__text'
    text.textContent = message.text.slice(0, maxTextLength)
    text.style.color = resolveAccessibleTextColor(
      message.color,
      options.backgroundColor,
      options.fallbackTextColor,
      minimumContrastRatio,
    )
    root.append(text)
  }

  function renderDefaultIdentity(container: HTMLElement, identity: DanmakuIdentity): void {
    if (identity.assetKey !== undefined && options.assetResolver !== undefined) {
      const resolved = resolveAsset(identity.assetKey)
      if (resolved !== null) {
        const image = document.createElement('img')
        image.className = 'liveflow-danmaku__identity-asset'
        image.alt = identity.label
        image.src = resolved
        image.decoding = 'async'
        image.draggable = false
        container.append(image)
      }
    }
    const label = document.createElement('span')
    label.className = 'liveflow-danmaku__identity-label'
    label.textContent =
      identity.level === undefined
        ? identity.label
        : `${identity.label} Lv.${String(identity.level)}`
    container.append(label)
  }

  function resolveAsset(assetKey: string): string | null {
    let resolved: string | null
    try {
      resolved = options.assetResolver?.resolve(assetKey) ?? null
    } catch {
      notifyAssetError(assetKey)
      return null
    }
    if (resolved === null) {
      return null
    }
    try {
      const url = new URL(resolved, document.baseURI)
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') {
        notifyAssetError(assetKey)
        return null
      }
      return url.href
    } catch {
      notifyAssetError(assetKey)
      return null
    }
  }

  function notifyAssetError(assetKey: string): void {
    try {
      options.onAssetError?.(assetKey)
    } catch {
      return
    }
  }

  function applyPosition(root: HTMLElement, item: DanmakuRenderItem, width: number): void {
    const x = reducedMotion ? Math.max(0, (viewport.width - width) / 2) : item.x
    root.style.transform = `translate3d(${String(x)}px, ${String(item.y)}px, 0)`
  }

  function handleReducedMotionChange(event: MediaQueryListEvent): void {
    reducedMotion = event.matches
    updateLayerState()
  }

  function unbindMediaQuery(): boolean {
    if (mediaQuery === null) {
      return true
    }
    try {
      mediaQuery.removeEventListener('change', handleReducedMotionChange)
      mediaQuery = null
      return true
    } catch {
      return false
    }
  }

  function updateLayerState(): void {
    layer.dataset.paused = paused ? 'true' : 'false'
    layer.dataset.reducedMotion = reducedMotion ? 'true' : 'false'
  }

  function ensureActive(): void {
    if (destroyed) {
      throw new InvalidDanmakuConfigurationError('renderer.destroyed')
    }
    if (!retryPendingCleanup()) {
      throw new DanmakuRendererError('identity-destroy')
    }
  }
}

function configureLayer(layer: HTMLDivElement): void {
  layer.className = 'liveflow-danmaku'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.position = 'absolute'
  layer.style.inset = '0'
  layer.style.overflow = 'hidden'
  layer.style.pointerEvents = 'none'
  layer.style.contain = 'layout paint style'
}

function configureProbe(probe: HTMLDivElement): void {
  probe.className = 'liveflow-danmaku__probe'
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.width = 'max-content'
  probe.style.whiteSpace = 'nowrap'
  probe.style.pointerEvents = 'none'
}

function createRoot(document: Document): HTMLDivElement {
  const root = document.createElement('div')
  root.style.position = 'absolute'
  root.style.left = '0'
  root.style.top = '0'
  root.style.width = 'max-content'
  root.style.whiteSpace = 'nowrap'
  root.style.willChange = 'transform'
  return root
}

function resetRoot(root: HTMLDivElement): void {
  resetElement(root)
  root.removeAttribute('class')
  root.removeAttribute('data-mode')
  root.style.removeProperty('transform')
}

function resetElement(element: HTMLElement): void {
  element.replaceChildren()
}

function removeElement(element: HTMLElement): boolean {
  try {
    element.remove()
    return true
  } catch {
    return false
  }
}

function destroyDisposables(disposables: { destroy(): void }[]): boolean {
  let succeeded = true
  for (const disposable of disposables.splice(0)) {
    try {
      disposable.destroy()
    } catch {
      succeeded = false
      disposables.push(disposable)
    }
  }
  return succeeded
}

function validatePositiveInteger(
  input: number | undefined,
  fallback: number,
  field: string,
): number {
  const value = input ?? fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidDanmakuConfigurationError(field)
  }
  return value
}

function validateViewport(viewport: DanmakuViewport): void {
  if (
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    throw new InvalidDanmakuConfigurationError('viewport')
  }
}

function validateRenderableMessage(message: DanmakuMessage): void {
  if (
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    typeof message.text !== 'string' ||
    message.text.length === 0
  ) {
    throw new InvalidDanmakuMessageError('message')
  }
}
