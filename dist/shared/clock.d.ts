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
export declare function createSystemClock(): Clock;
