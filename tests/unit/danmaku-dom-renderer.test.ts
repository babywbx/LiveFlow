import { describe, expect, it } from 'vitest'

import { DanmakuRendererError } from '../../src/danmaku/index.js'
import { createDomDanmakuRenderer } from '../../src/danmaku/renderers/index.js'

interface FakeStyle {
  setProperty(property: string, value: string): void
  removeProperty(property: string): void
}

interface FakeElement {
  className: string
  readonly childNodes: FakeElement[]
  readonly dataset: Record<string, string>
  readonly fragment: boolean
  removed: boolean
  removeFailures: number
  readonly style: FakeStyle
  textContent: string | null
  append(...children: FakeElement[]): void
  getBoundingClientRect(): { readonly width: number; readonly height: number }
  remove(): void
  removeAttribute(name: string): void
  replaceChildren(): void
  setAttribute(name: string, value: string): void
}

interface FakeMediaQuery {
  readonly matches: boolean
  addCalls: number
  removeCalls: number
  removeFailures: number
  addEventListener(type: string, listener: (event: { readonly matches: boolean }) => void): void
  removeEventListener(type: string, listener: (event: { readonly matches: boolean }) => void): void
}

interface DomFixture {
  readonly container: HTMLElement
  readonly elements: FakeElement[]
  readonly mediaQuery: FakeMediaQuery
}

function createFakeElement(fragment = false): FakeElement {
  return {
    className: '',
    childNodes: [],
    dataset: {},
    fragment,
    removed: false,
    removeFailures: 0,
    style: {
      setProperty(): void {},
      removeProperty(): void {},
    },
    textContent: null,
    append(...children): void {
      for (const child of children) {
        if (child.fragment) {
          this.childNodes.push(...child.childNodes)
        } else {
          this.childNodes.push(child)
        }
      }
    },
    getBoundingClientRect() {
      return { width: 120, height: 24 }
    },
    remove(): void {
      if (this.removeFailures > 0) {
        this.removeFailures -= 1
        throw new Error('remove failed')
      }
      this.removed = true
    },
    removeAttribute(): void {},
    replaceChildren(): void {
      this.childNodes.length = 0
    },
    setAttribute(): void {},
  }
}

function isFixtureContainer(value: unknown): value is HTMLElement {
  return (
    typeof value === 'object' && value !== null && 'ownerDocument' in value && 'append' in value
  )
}

function createDomFixture(addFails: boolean, removeFailures: number): DomFixture {
  const elements: FakeElement[] = []
  const mediaQuery: FakeMediaQuery = {
    matches: false,
    addCalls: 0,
    removeCalls: 0,
    removeFailures,
    addEventListener(): void {
      this.addCalls += 1
      if (addFails) {
        throw new Error('bind failed')
      }
    },
    removeEventListener(): void {
      this.removeCalls += 1
      if (this.removeFailures > 0) {
        this.removeFailures -= 1
        throw new Error('unbind failed')
      }
    },
  }
  const document = {
    baseURI: 'https://example.test/',
    defaultView: {
      matchMedia(): FakeMediaQuery {
        return mediaQuery
      },
    },
    createDocumentFragment(): FakeElement {
      return createFakeElement(true)
    },
    createElement(): FakeElement {
      const element = createFakeElement()
      elements.push(element)
      return element
    },
  }
  const container = {
    append(): void {},
    clientHeight: 80,
    clientWidth: 320,
    ownerDocument: document,
  }
  if (!isFixtureContainer(container)) {
    throw new Error('invalid fixture')
  }
  return { container, elements, mediaQuery }
}

describe('DOM danmaku renderer lifecycle', () => {
  it('rolls back the mounted layer when media-query binding fails', () => {
    const fixture = createDomFixture(true, 0)

    expect(() => createDomDanmakuRenderer({ container: fixture.container })).toThrow(
      DanmakuRendererError,
    )
    expect(fixture.mediaQuery.addCalls).toBe(1)
    expect(fixture.mediaQuery.removeCalls).toBe(1)
    expect(
      fixture.elements.find((element) => element.className === 'liveflow-danmaku')?.removed,
    ).toBe(true)
    expect(
      fixture.elements.find((element) => element.className === 'liveflow-danmaku__probe')?.removed,
    ).toBe(true)
  })

  it('cleans every node when media-query unbinding fails and retries the unbind', () => {
    const fixture = createDomFixture(false, 1)
    const renderer = createDomDanmakuRenderer({ container: fixture.container })
    renderer.render({
      timestamp: 0,
      mounts: [
        {
          message: {
            id: 'mounted',
            receivedAt: 0,
            text: 'mounted',
            mode: 'scroll',
            priority: 0,
          },
          lane: 0,
          x: 320,
          y: 0,
          width: 120,
          height: 24,
        },
      ],
      updates: [],
      unmounts: [],
    })

    expect(() => renderer.destroy()).toThrow(DanmakuRendererError)
    expect(fixture.mediaQuery.removeCalls).toBe(1)
    for (const className of [
      'liveflow-danmaku',
      'liveflow-danmaku__probe',
      'liveflow-danmaku__message',
    ]) {
      expect(fixture.elements.find((element) => element.className === className)?.removed).toBe(
        true,
      )
    }

    expect(() => renderer.destroy()).not.toThrow()
    expect(fixture.mediaQuery.removeCalls).toBe(2)
  })

  it('retains a node whose removal must be retried', () => {
    const fixture = createDomFixture(false, 0)
    const renderer = createDomDanmakuRenderer({ container: fixture.container })
    renderer.render({
      timestamp: 0,
      mounts: [
        {
          message: {
            id: 'retry-remove',
            receivedAt: 0,
            text: 'retry',
            mode: 'scroll',
            priority: 0,
          },
          lane: 0,
          x: 320,
          y: 0,
          width: 120,
          height: 24,
        },
      ],
      updates: [],
      unmounts: [],
    })
    const root = fixture.elements.find(
      (element) => element.className === 'liveflow-danmaku__message',
    )
    if (root === undefined) {
      throw new Error('missing mounted root')
    }
    root.removeFailures = 1

    expect(() => renderer.destroy()).toThrow(DanmakuRendererError)
    expect(root.removed).toBe(false)
    expect(() => renderer.destroy()).not.toThrow()
    expect(root.removed).toBe(true)
  })

  it('retains a failed identity cleanup for destroy retry', () => {
    const fixture = createDomFixture(false, 0)
    let destroyCalls = 0
    const renderer = createDomDanmakuRenderer({
      container: fixture.container,
      identityRenderer: {
        render() {
          return {
            destroy(): void {
              destroyCalls += 1
              if (destroyCalls === 1) {
                throw new Error('identity cleanup failed')
              }
            },
          }
        },
      },
    })

    expect(() =>
      renderer.measure([
        {
          id: 'identity-cleanup',
          receivedAt: 0,
          text: 'identity cleanup',
          mode: 'scroll',
          priority: 0,
          identities: [{ kind: 'badge', label: 'badge' }],
        },
      ]),
    ).toThrow(DanmakuRendererError)
    expect(destroyCalls).toBe(1)

    expect(() => renderer.destroy()).not.toThrow()
    expect(destroyCalls).toBe(2)
  })

  it('reads only bounded identity indexes without calling array overrides', () => {
    const fixture = createDomFixture(false, 0)
    const renderer = createDomDanmakuRenderer({ container: fixture.container })
    const identities = [{ kind: 'badge', label: 'badge' }]
    let iteratorCalls = 0
    let sliceCalls = 0
    Object.defineProperty(identities, Symbol.iterator, {
      value(): never {
        iteratorCalls += 1
        throw new Error('custom iterator called')
      },
    })
    Object.defineProperty(identities, 'slice', {
      value(): never {
        sliceCalls += 1
        throw new Error('custom slice called')
      },
    })

    expect(
      renderer.measure([
        {
          id: 'bounded-identities',
          receivedAt: 0,
          text: 'bounded identities',
          mode: 'scroll',
          priority: 0,
          identities,
        },
      ]),
    ).toEqual([{ id: 'bounded-identities', width: 120, height: 24 }])
    expect(iteratorCalls).toBe(0)
    expect(sliceCalls).toBe(0)
    renderer.destroy()
  })
})
