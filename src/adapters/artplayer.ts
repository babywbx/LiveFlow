import type { EngineHooks } from '../shared/diagnostics.js'

export interface ArtPlayerLike {
  readonly video: HTMLVideoElement
  on(event: string, handler: (...args: readonly unknown[]) => void): void
  off(event: string, handler: (...args: readonly unknown[]) => void): void
}

export interface ArtPlayerAdapterOptions extends EngineHooks {
  player: ArtPlayerLike
  overlayContainer?: HTMLElement
}
