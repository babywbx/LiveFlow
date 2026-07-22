export { CONTRACT_VERSION } from '../shared/contract.js'
export { createOverlayBudgetCoordinator } from './budget-coordinator.js'
export {
  InvalidOverlayConfigurationError,
  InvalidOverlayEventError,
  OverlayCapacityError,
  OverlayCleanupError,
  OverlayDestroyedError,
  OverlayRenderError,
  OverlaySchedulingError,
} from './errors.js'
export { createOverlayEngine } from './realtime-overlay.js'
export { createSafeOverlayRenderer } from './safe-renderer.js'
export { DEFAULT_OVERLAY_LIMITS } from './validation.js'
export type {
  OverlayBudgetCoordinator,
  OverlayBudgetGrant,
  OverlayBudgetLimits,
  OverlayBudgetMetrics,
  OverlayBudgetRegistration,
  OverlayBudgetRequest,
  OverlayEngine,
  OverlayEngineOptions,
  OverlayInstanceState,
  OverlayInstanceStateUpdate,
  OverlayLimits,
  OverlayMetrics,
  OverlayNode,
  OverlayPresentation,
  OverlayPresentationListener,
  OverlayRenderer,
  OverlaySubmitResult,
  OverlaySubmitStatus,
  RealtimeOverlayEvent,
  SafeOverlayRendererOptions,
} from './types.js'
