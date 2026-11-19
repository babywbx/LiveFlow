export type TimerHandle = number;
export type FrameHandle = number;
export interface Clock {
    now(): number;
    setTimeout(handler: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    requestFrame(handler: (timestampMs: number) => void): FrameHandle;
    cancelFrame(handle: FrameHandle): void;
}
export interface RandomSource {
    next(): number;
}
export type TimerClock = Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>;
type FrameClock = Pick<Clock, 'now' | 'requestFrame' | 'cancelFrame'>;
export declare function createSystemTimerClock(): TimerClock;
export declare function createSystemFrameClock(): FrameClock;
export declare function createSystemClock(): Clock;
export {};
