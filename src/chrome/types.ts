import type { Clock } from '../shared/clock.js'

export interface ChromeVisibilitySnapshot {
  readonly visible: boolean
}

export type ChromeVisibilitySnapshotListener = (snapshot: ChromeVisibilitySnapshot) => void

export interface ChromeVisibilityOptions {
  readonly clock?: Clock
  readonly hold?: boolean
  readonly idleHideMs?: number
}

export interface ChromeVisibilityController {
  pointerEnter(): void
  pointerMove(): void
  pointerLeave(): void
  pointerDown(): void
  pin(): void
  unpin(): void
  setFocusWithin(focused: boolean): void
  setHold(hold: boolean): void
  getSnapshot(): ChromeVisibilitySnapshot
  subscribe(listener: ChromeVisibilitySnapshotListener): () => void
  destroy(): void
}
