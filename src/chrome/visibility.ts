import { createSystemClock, type Clock, type TimerHandle } from '../shared/clock.js'
import { CapacityExceededError } from '../shared/errors.js'
import {
  ChromeVisibilityDestroyedError,
  ChromeVisibilityPinUnderflowError,
  InvalidChromeVisibilityConfigurationError,
} from './errors.js'
import type {
  ChromeVisibilityController,
  ChromeVisibilityOptions,
  ChromeVisibilitySnapshot,
  ChromeVisibilitySnapshotListener,
} from './types.js'

export const DEFAULT_CHROME_IDLE_HIDE_MS = 2_500

const HIDDEN_SNAPSHOT: ChromeVisibilitySnapshot = Object.freeze({ visible: false })
const VISIBLE_SNAPSHOT: ChromeVisibilitySnapshot = Object.freeze({ visible: true })

export function createChromeVisibility(
  options: ChromeVisibilityOptions = {},
): ChromeVisibilityController {
  const idleHideMs = options.idleHideMs ?? DEFAULT_CHROME_IDLE_HIDE_MS
  if (!Number.isFinite(idleHideMs) || idleHideMs <= 0) {
    throw new InvalidChromeVisibilityConfigurationError('idleHideMs')
  }

  return new DefaultChromeVisibilityController(
    options.clock ?? createSystemClock(),
    idleHideMs,
    options.hold ?? false,
  )
}

class DefaultChromeVisibilityController implements ChromeVisibilityController {
  private static readonly MAX_PIN_DEPTH = 32
  private static readonly MAX_SNAPSHOT_LISTENERS = 32

  private readonly listeners = new Set<ChromeVisibilitySnapshotListener>()
  private destroyed = false
  private focusWithin = false
  private hideTimer: TimerHandle | null = null
  private pinCount = 0
  private pointerInside = false
  private visible = false

  constructor(
    private readonly clock: Clock,
    private readonly idleHideMs: number,
    private hold: boolean,
  ) {}

  pointerEnter(): void {
    this.reveal()
  }

  pointerMove(): void {
    this.reveal()
  }

  pointerDown(): void {
    this.reveal()
  }

  pointerLeave(): void {
    this.ensureActive()
    this.pointerInside = false
    if (this.pinCount > 0 || this.focusWithin) {
      return
    }

    this.cancelHide()
    this.setVisible(false)
  }

  pin(): void {
    this.ensureActive()
    if (this.pinCount >= DefaultChromeVisibilityController.MAX_PIN_DEPTH) {
      throw new CapacityExceededError(
        'chrome-visibility-pins',
        DefaultChromeVisibilityController.MAX_PIN_DEPTH,
      )
    }

    this.pinCount += 1
    this.cancelHide()
    this.setVisible(true)
  }

  unpin(): void {
    this.ensureActive()
    if (this.pinCount === 0) {
      throw new ChromeVisibilityPinUnderflowError()
    }

    this.pinCount -= 1
    this.scheduleHide()
  }

  setFocusWithin(focused: boolean): void {
    this.ensureActive()
    this.focusWithin = focused
    if (focused) {
      this.cancelHide()
      this.setVisible(true)
      return
    }

    this.scheduleHide()
  }

  setHold(hold: boolean): void {
    this.ensureActive()
    this.hold = hold
    if (hold) {
      if (this.pointerInside) {
        this.cancelHide()
      }
      return
    }

    this.scheduleHide()
  }

  getSnapshot(): ChromeVisibilitySnapshot {
    return this.visible ? VISIBLE_SNAPSHOT : HIDDEN_SNAPSHOT
  }

  subscribe(listener: ChromeVisibilitySnapshotListener): () => void {
    this.ensureActive()
    if (
      !this.listeners.has(listener) &&
      this.listeners.size >= DefaultChromeVisibilityController.MAX_SNAPSHOT_LISTENERS
    ) {
      throw new CapacityExceededError(
        'chrome-visibility-snapshot-listeners',
        DefaultChromeVisibilityController.MAX_SNAPSHOT_LISTENERS,
      )
    }

    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.cancelHide()
    this.focusWithin = false
    this.hold = false
    this.pinCount = 0
    this.pointerInside = false
    this.setVisible(false)
    this.listeners.clear()
  }

  private reveal(): void {
    this.ensureActive()
    this.pointerInside = true
    this.setVisible(true)
    this.scheduleHide()
  }

  private setVisible(next: boolean): void {
    if (this.visible === next) {
      return
    }

    this.visible = next
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        continue
      }
    }
  }

  private scheduleHide(): void {
    this.cancelHide()
    if (!this.visible || this.isHeld()) {
      return
    }

    this.hideTimer = this.clock.setTimeout(() => {
      this.hideTimer = null
      if (this.isHeld()) {
        return
      }

      this.setVisible(false)
    }, this.idleHideMs)
  }

  private cancelHide(): void {
    if (this.hideTimer === null) {
      return
    }

    const timer = this.hideTimer
    this.hideTimer = null
    this.clock.clearTimeout(timer)
  }

  private isHeld(): boolean {
    return this.pinCount > 0 || this.focusWithin || (this.hold && this.pointerInside)
  }

  private ensureActive(): void {
    if (this.destroyed) {
      throw new ChromeVisibilityDestroyedError()
    }
  }
}
