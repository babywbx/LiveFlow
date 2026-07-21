import type { EngineHooks } from '../shared/diagnostics.js'

export interface NativeVideoAdapterOptions extends EngineHooks {
  video: HTMLVideoElement
  crossOrigin?: 'anonymous' | 'use-credentials'
}
