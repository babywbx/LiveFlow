import { describe, expect, it, vi } from 'vitest'

import { createDocumentPageActivity } from '../../src/adapters/document-page-activity.js'
import type { PageVisibilityDocument } from '../../src/adapters/document-page-activity.js'
import { CapacityExceededError } from '../../src/index.js'

interface FakeDocument extends PageVisibilityDocument {
  visibilityState: DocumentVisibilityState
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
  fire: () => void
}

function createFakeDocument(): FakeDocument {
  const listeners = new Set<() => void>()
  return {
    visibilityState: 'hidden',
    addEventListener(type, listener): void {
      if (type === 'visibilitychange') listeners.add(listener)
    },
    removeEventListener(type, listener): void {
      if (type === 'visibilitychange') listeners.delete(listener)
    },
    fire(): void {
      for (const listener of listeners) listener()
    },
  }
}

describe('document page activity', () => {
  it('reports visibility and notifies subscribers on change', () => {
    const fake = createFakeDocument()
    const activity = createDocumentPageActivity({ document: fake })
    const seen: boolean[] = []

    const unsubscribe = activity.subscribe((hidden) => seen.push(hidden))
    expect(activity.isHidden()).toBe(true)

    fake.visibilityState = 'visible'
    fake.fire()
    expect(seen).toEqual([false])
    expect(activity.isHidden()).toBe(false)

    unsubscribe()
    fake.fire()
    expect(seen).toEqual([false])
  })

  it('unbinds the document listener once the last subscriber leaves', () => {
    const fake = createFakeDocument()
    const removeSpy = vi.spyOn(fake, 'removeEventListener')
    const activity = createDocumentPageActivity({ document: fake })

    const first = activity.subscribe(() => {})
    const second = activity.subscribe(() => {})
    first()
    expect(removeSpy).not.toHaveBeenCalled()
    second()
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the subscriber set bounded', () => {
    const fake = createFakeDocument()
    const activity = createDocumentPageActivity({ document: fake })
    for (let index = 0; index < 16; index += 1) {
      activity.subscribe(() => {})
    }
    expect(() => activity.subscribe(() => {})).toThrow(CapacityExceededError)
  })

  it('survives a subscriber that throws', () => {
    const fake = createFakeDocument()
    const activity = createDocumentPageActivity({ document: fake })
    const seen: boolean[] = []
    activity.subscribe(() => {
      throw new Error('listener exploded')
    })
    activity.subscribe((hidden) => seen.push(hidden))

    fake.visibilityState = 'visible'
    expect(() => fake.fire()).not.toThrow()
    expect(seen).toEqual([false])
  })

  it('rolls back a failed document binding without consuming capacity', () => {
    const listeners = new Set<() => void>()
    let failing = true
    const target: PageVisibilityDocument = {
      visibilityState: 'hidden',
      addEventListener(_type, listener): void {
        listeners.add(listener)
        if (failing) {
          throw new Error('Synthetic binding failure.')
        }
      },
      removeEventListener(_type, listener): void {
        listeners.delete(listener)
      },
    }
    const activity = createDocumentPageActivity({ document: target })

    for (let index = 0; index < 20; index += 1) {
      expect(() => activity.subscribe(() => {})).toThrowError(
        expect.objectContaining({ code: 'page-activity-subscribe-failed' }),
      )
    }
    expect(listeners.size).toBe(0)

    failing = false
    const unsubscribe = activity.subscribe(() => {})
    expect(listeners.size).toBe(1)
    unsubscribe()
    expect(listeners.size).toBe(0)
  })

  it('retries a failed document unbinding', () => {
    let removeCalls = 0
    const listeners = new Set<() => void>()
    const target: PageVisibilityDocument = {
      visibilityState: 'visible',
      addEventListener(_type, listener): void {
        listeners.add(listener)
      },
      removeEventListener(_type, listener): void {
        removeCalls += 1
        if (removeCalls === 1) {
          throw new Error('Synthetic unbinding failure.')
        }
        listeners.delete(listener)
      },
    }
    const activity = createDocumentPageActivity({ document: target })
    const unsubscribe = activity.subscribe(() => {})

    expect(unsubscribe).toThrowError(
      expect.objectContaining({ code: 'page-activity-unsubscribe-failed' }),
    )
    expect(listeners.size).toBe(1)
    expect(unsubscribe).not.toThrow()
    expect(listeners.size).toBe(0)
  })
})
