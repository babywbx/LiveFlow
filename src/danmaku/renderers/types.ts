import type { Destroyable } from '../../shared/disposable.js'
import type { DanmakuIdentity, DanmakuMessage } from '../types.js'

export interface AssetResolver {
  resolve(assetKey: string): string | null
}

export interface IdentityRenderer {
  render(identity: DanmakuIdentity, container: HTMLElement): Destroyable
}

export interface DanmakuRenderer extends Destroyable {
  mount(message: DanmakuMessage): void
  resize(): void
  pause(): void
  resume(): void
}
