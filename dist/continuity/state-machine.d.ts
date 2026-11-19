import type { ContinuityState } from './types.js';
export interface ContinuityMachineState {
    readonly state: ContinuityState;
    readonly generation: number;
    readonly automaticRecoveryCount: number;
}
export type ContinuityMachineEvent = 'source-requested' | 'source-prepared' | 'first-frame' | 'playback-degraded' | 'playback-resumed' | 'recovery-requested' | 'recovery-cancelled' | 'recovery-exhausted' | 'source-failed' | 'playback-suspended' | 'destroyed';
export declare const INITIAL_CONTINUITY_STATE: ContinuityMachineState;
export declare function reduceContinuityState(current: ContinuityMachineState, event: ContinuityMachineEvent, generation: number): ContinuityMachineState;
