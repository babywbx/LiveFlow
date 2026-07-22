import type { ContinuityState } from './types.js';
export interface ContinuityMachineState {
    readonly state: ContinuityState;
    readonly generation: number;
    readonly automaticRecoveryCount: number;
}
export type ContinuityMachineEvent = {
    readonly type: 'source-requested';
    readonly generation: number;
} | {
    readonly type: 'source-prepared';
    readonly generation: number;
} | {
    readonly type: 'first-frame';
    readonly generation: number;
} | {
    readonly type: 'playback-degraded';
    readonly generation: number;
} | {
    readonly type: 'playback-resumed';
    readonly generation: number;
} | {
    readonly type: 'recovery-requested';
    readonly generation: number;
} | {
    readonly type: 'recovery-exhausted';
    readonly generation: number;
} | {
    readonly type: 'source-failed';
    readonly generation: number;
} | {
    readonly type: 'destroyed';
};
export declare const INITIAL_CONTINUITY_STATE: ContinuityMachineState;
export declare function reduceContinuityState(current: ContinuityMachineState, event: ContinuityMachineEvent): ContinuityMachineState;
