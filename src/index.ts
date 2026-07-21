export const CONTRACT_VERSION = 1

export type { Clock, FrameHandle, RandomSource, TimerHandle } from './shared/clock.js'
export type { AsyncDestroyable, Destroyable } from './shared/disposable.js'
export type {
  DiagnosticDetail,
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticScope,
  EngineHooks,
} from './shared/diagnostics.js'
export {
  AssetResolutionError,
  ContractVersionMismatchError,
  LiveFlowError,
} from './shared/errors.js'
