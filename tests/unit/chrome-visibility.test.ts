import { describe, expect, it } from 'vitest'

import {
  ChromeVisibilityDestroyedError,
  ChromeVisibilityPinUnderflowError,
  createChromeVisibility,
  DEFAULT_CHROME_IDLE_HIDE_MS,
  InvalidChromeVisibilityConfigurationError,
} from '../../src/chrome/index.js'
import { CapacityExceededError } from '../../src/shared/errors.js'
import { FakeClock } from '../fixtures/fake-clock.js'

describe('chrome visibility', () => {
  it('reveals chrome on pointer signals and hides it after the idle window', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock })

    expect(chrome.getSnapshot().visible).toBe(false)

    chrome.pointerEnter()
    expect(chrome.getSnapshot().visible).toBe(true)

    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS - 1)
    expect(chrome.getSnapshot().visible).toBe(true)

    chrome.pointerMove()
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS - 1)
    expect(chrome.getSnapshot().visible).toBe(true)

    clock.advanceBy(1)
    expect(chrome.getSnapshot().visible).toBe(false)
    expect(clock.pendingTaskCount()).toBe(0)
  })

  it('publishes only real transitions and returns a stable snapshot reference', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock, idleHideMs: 400 })
    const transitions: boolean[] = []
    const unsubscribe = chrome.subscribe((snapshot) => {
      transitions.push(snapshot.visible)
    })

    expect(chrome.getSnapshot()).toBe(chrome.getSnapshot())

    chrome.pointerDown()
    chrome.pointerMove()
    clock.advanceBy(400)
    expect(transitions).toEqual([true, false])

    unsubscribe()
    unsubscribe()
    chrome.pointerEnter()
    expect(transitions).toEqual([true, false])
  })

  it('keeps chrome visible while a pin is open and resumes the timer after unpin', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock })

    chrome.pointerEnter()
    chrome.pin()
    chrome.pin()
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS * 10)
    expect(chrome.getSnapshot().visible).toBe(true)
    expect(clock.pendingTaskCount()).toBe(0)

    chrome.unpin()
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS * 10)
    expect(chrome.getSnapshot().visible).toBe(true)

    chrome.unpin()
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS - 1)
    expect(chrome.getSnapshot().visible).toBe(true)

    clock.advanceBy(1)
    expect(chrome.getSnapshot().visible).toBe(false)
  })

  it('keeps chrome visible while focus stays inside the controls', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock })

    chrome.setFocusWithin(true)
    expect(chrome.getSnapshot().visible).toBe(true)

    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS * 10)
    expect(chrome.getSnapshot().visible).toBe(true)

    chrome.setFocusWithin(false)
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS - 1)
    expect(chrome.getSnapshot().visible).toBe(true)

    clock.advanceBy(1)
    expect(chrome.getSnapshot().visible).toBe(false)
  })

  it('holds chrome while the pointer stays inside and resumes the timer once hold is released', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock })

    chrome.pointerEnter()
    chrome.setHold(true)
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS * 10)
    expect(chrome.getSnapshot().visible).toBe(true)
    expect(clock.pendingTaskCount()).toBe(0)

    chrome.pointerMove()
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS * 10)
    expect(chrome.getSnapshot().visible).toBe(true)

    chrome.setHold(false)
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS - 1)
    expect(chrome.getSnapshot().visible).toBe(true)

    clock.advanceBy(1)
    expect(chrome.getSnapshot().visible).toBe(false)
  })

  it('does not hold chrome when the pointer is outside even if hold is set at creation', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock, hold: true })

    chrome.setFocusWithin(true)
    chrome.setFocusWithin(false)
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS)
    expect(chrome.getSnapshot().visible).toBe(false)
  })

  it('hides immediately when the pointer leaves unless a pin or focus keeps it open', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock, hold: true })

    chrome.pointerEnter()
    chrome.pointerLeave()
    expect(chrome.getSnapshot().visible).toBe(false)
    expect(clock.pendingTaskCount()).toBe(0)

    chrome.pointerEnter()
    chrome.pin()
    chrome.pointerLeave()
    expect(chrome.getSnapshot().visible).toBe(true)

    chrome.unpin()
    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS)
    expect(chrome.getSnapshot().visible).toBe(false)

    chrome.pointerEnter()
    chrome.setFocusWithin(true)
    chrome.pointerLeave()
    expect(chrome.getSnapshot().visible).toBe(true)
  })

  it('rejects an unpin without a matching pin', () => {
    const chrome = createChromeVisibility({ clock: new FakeClock() })

    expect(() => {
      chrome.unpin()
    }).toThrow(ChromeVisibilityPinUnderflowError)

    chrome.pin()
    chrome.unpin()
    expect(() => {
      chrome.unpin()
    }).toThrow(ChromeVisibilityPinUnderflowError)
  })

  it('bounds the pin depth and the subscriber count', () => {
    const chrome = createChromeVisibility({ clock: new FakeClock() })

    for (let index = 0; index < 32; index += 1) {
      chrome.pin()
    }
    expect(() => {
      chrome.pin()
    }).toThrow(CapacityExceededError)

    const listener = (): void => {}
    for (let index = 0; index < 31; index += 1) {
      chrome.subscribe(() => {})
    }
    chrome.subscribe(listener)
    chrome.subscribe(listener)
    expect(() => {
      chrome.subscribe(() => {})
    }).toThrow(CapacityExceededError)
  })

  it('rejects an invalid idle window', () => {
    expect(() => createChromeVisibility({ idleHideMs: 0 })).toThrow(
      InvalidChromeVisibilityConfigurationError,
    )
    expect(() => createChromeVisibility({ idleHideMs: -1 })).toThrow(
      InvalidChromeVisibilityConfigurationError,
    )
    expect(() => createChromeVisibility({ idleHideMs: Number.NaN })).toThrow(
      InvalidChromeVisibilityConfigurationError,
    )
    expect(() => createChromeVisibility({ idleHideMs: Number.POSITIVE_INFINITY })).toThrow(
      InvalidChromeVisibilityConfigurationError,
    )
  })

  it('keeps listener failures from stopping the remaining subscribers', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock })
    const seen: boolean[] = []
    chrome.subscribe(() => {
      throw new Error('listener failed')
    })
    chrome.subscribe((snapshot) => {
      seen.push(snapshot.visible)
    })

    chrome.pointerEnter()
    expect(seen).toEqual([true])
  })

  it('destroys idempotently, leaves no timer behind, and rejects later signals', () => {
    const clock = new FakeClock()
    const chrome = createChromeVisibility({ clock })
    const transitions: boolean[] = []
    chrome.subscribe((snapshot) => {
      transitions.push(snapshot.visible)
    })

    chrome.pointerEnter()
    expect(clock.pendingTaskCount()).toBe(1)

    chrome.destroy()
    chrome.destroy()
    expect(clock.pendingTaskCount()).toBe(0)
    expect(chrome.getSnapshot().visible).toBe(false)
    expect(transitions).toEqual([true, false])

    clock.advanceBy(DEFAULT_CHROME_IDLE_HIDE_MS * 10)
    expect(transitions).toEqual([true, false])

    expect(() => {
      chrome.pointerMove()
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.pointerEnter()
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.pointerDown()
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.pointerLeave()
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.pin()
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.unpin()
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.setFocusWithin(true)
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.setHold(true)
    }).toThrow(ChromeVisibilityDestroyedError)
    expect(() => {
      chrome.subscribe(() => {})
    }).toThrow(ChromeVisibilityDestroyedError)
  })
})
