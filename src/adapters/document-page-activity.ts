import { CapacityExceededError, LiveFlowError } from '../shared/errors.js'
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
      if (bound === null) {
        try {
          target.addEventListener('visibilitychange', notify)
        } catch {
          try {
            target.removeEventListener('visibilitychange', notify)
          } catch {
            // Best-effort rollback before ownership exists.
          }
          throw new LiveFlowError(
            'page-activity-subscribe-failed',
            'Could not subscribe to page visibility changes.',
          )
        }
        bound = (): void => {
          target.removeEventListener('visibilitychange', notify)
        }
      }
      listeners.add(listener)
      return () => {
        if (!listeners.has(listener)) {
          return
        }
        if (listeners.size === 1 && bound !== null) {
          const unbind = bound
          try {
            unbind()
            bound = null
          } catch {
            throw new LiveFlowError(
              'page-activity-unsubscribe-failed',
              'Could not unsubscribe from page visibility changes.',
            )
          }
        }
        listeners.delete(listener)
      }
    },
  }
}
