import { type Clock } from '../shared/clock.js';
import type { EngineHooks } from '../shared/diagnostics.js';
import type { ContinuityController, ContinuityPolicy, ContinuityRecoveryRequestListener, LivePlayerAdapter } from './types.js';
export interface ContinuityControllerOptions extends EngineHooks {
    readonly adapter: LivePlayerAdapter;
    readonly contractVersion: number;
    readonly clock?: Clock;
    readonly policy?: Partial<ContinuityPolicy>;
    readonly onRecoveryRequest?: ContinuityRecoveryRequestListener;
}
export declare function createContinuityController(options: ContinuityControllerOptions): ContinuityController;
