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
})
