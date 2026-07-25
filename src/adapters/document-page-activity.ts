import { CapacityExceededError } from '../shared/errors.js'
import type { PageActivitySource } from '../continuity/types.js'

const MAX_PAGE_ACTIVITY_LISTENERS = 16

export interface PageVisibilityDocument {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface DocumentPageActivityOptions {
  readonly document?: PageVisibilityDocument
}

export function createDocumentPageActivity(
  options: DocumentPageActivityOptions = {},
): PageActivitySource {
  const target = options.document ?? globalThis.document
  const listeners = new Set<(hidden: boolean) => void>()
  let bound: (() => void) | null = null

  const isHidden = (): boolean => target.visibilityState === 'hidden'

  const notify = (): void => {
    const hidden = isHidden()
    for (const listener of listeners) {
      try {
        listener(hidden)
      } catch {
        continue
      }
    }
  }

  return {
    isHidden,
    subscribe(listener): () => void {
      if (!listeners.has(listener) && listeners.size >= MAX_PAGE_ACTIVITY_LISTENERS) {
        throw new CapacityExceededError('page-activity-listeners', MAX_PAGE_ACTIVITY_LISTENERS)
      }
      listeners.add(listener)
      if (bound === null) {
        target.addEventListener('visibilitychange', notify)
        bound = (): void => {
          target.removeEventListener('visibilitychange', notify)
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && bound !== null) {
          const unbind = bound
          bound = null
          unbind()
        }
      }
    },
  }
}
