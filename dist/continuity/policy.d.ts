import type { ContinuityPolicy } from './types.js';
export declare const DEFAULT_CONTINUITY_POLICY: Readonly<ContinuityPolicy>;
export declare function resolveContinuityPolicy(overrides: Partial<ContinuityPolicy> | undefined): ContinuityPolicy;
