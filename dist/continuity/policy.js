import { InvalidContinuityPolicyError } from '../shared/errors.js';
export const DEFAULT_CONTINUITY_POLICY = {
    targetLatencySeconds: 2,
    softCatchupThresholdSeconds: 0.6,
    hardResyncThresholdSeconds: 8,
    catchupRate: 1.04,
    recoveryCooldownMs: 30_000,
    sourceWarmupTimeoutMs: 8_000,
    reopenGraceMs: 90_000,
    maxAutomaticRecoveries: 4,
    maxGapJumpSeconds: 30,
    stallNudgeSeconds: 0.1,
    maxStallSeeksPerSource: 3,
};
export function resolveContinuityPolicy(overrides) {
    const policy = {
        targetLatencySeconds: overrides?.targetLatencySeconds ?? DEFAULT_CONTINUITY_POLICY.targetLatencySeconds,
        softCatchupThresholdSeconds: overrides?.softCatchupThresholdSeconds ??
            DEFAULT_CONTINUITY_POLICY.softCatchupThresholdSeconds,
        hardResyncThresholdSeconds: overrides?.hardResyncThresholdSeconds ?? DEFAULT_CONTINUITY_POLICY.hardResyncThresholdSeconds,
        catchupRate: overrides?.catchupRate ?? DEFAULT_CONTINUITY_POLICY.catchupRate,
        recoveryCooldownMs: overrides?.recoveryCooldownMs ?? DEFAULT_CONTINUITY_POLICY.recoveryCooldownMs,
        sourceWarmupTimeoutMs: overrides?.sourceWarmupTimeoutMs ?? DEFAULT_CONTINUITY_POLICY.sourceWarmupTimeoutMs,
        reopenGraceMs: overrides?.reopenGraceMs ?? DEFAULT_CONTINUITY_POLICY.reopenGraceMs,
        maxAutomaticRecoveries: overrides?.maxAutomaticRecoveries ?? DEFAULT_CONTINUITY_POLICY.maxAutomaticRecoveries,
        maxGapJumpSeconds: overrides?.maxGapJumpSeconds ?? DEFAULT_CONTINUITY_POLICY.maxGapJumpSeconds,
        stallNudgeSeconds: overrides?.stallNudgeSeconds ?? DEFAULT_CONTINUITY_POLICY.stallNudgeSeconds,
        maxStallSeeksPerSource: overrides?.maxStallSeeksPerSource ?? DEFAULT_CONTINUITY_POLICY.maxStallSeeksPerSource,
    };
    validateContinuityPolicy(policy);
    return policy;
}
function validateContinuityPolicy(policy) {
    requireFinitePositive('targetLatencySeconds', policy.targetLatencySeconds);
    requireFinitePositive('softCatchupThresholdSeconds', policy.softCatchupThresholdSeconds);
    requireFinitePositive('hardResyncThresholdSeconds', policy.hardResyncThresholdSeconds);
    requireFinitePositive('recoveryCooldownMs', policy.recoveryCooldownMs);
    requireFinitePositive('sourceWarmupTimeoutMs', policy.sourceWarmupTimeoutMs);
    requireFinitePositive('reopenGraceMs', policy.reopenGraceMs);
    requireFinitePositive('maxGapJumpSeconds', policy.maxGapJumpSeconds);
    requireFinitePositive('stallNudgeSeconds', policy.stallNudgeSeconds);
    if (!Number.isInteger(policy.maxStallSeeksPerSource) ||
        policy.maxStallSeeksPerSource < 0 ||
        policy.maxStallSeeksPerSource > 100) {
        throw new InvalidContinuityPolicyError('maxStallSeeksPerSource');
    }
    if (policy.catchupRate <= 1 || policy.catchupRate > 1.1 || !Number.isFinite(policy.catchupRate)) {
        throw new InvalidContinuityPolicyError('catchupRate');
    }
    if (!Number.isInteger(policy.maxAutomaticRecoveries) ||
        policy.maxAutomaticRecoveries < 1 ||
        policy.maxAutomaticRecoveries > 100) {
        throw new InvalidContinuityPolicyError('maxAutomaticRecoveries');
    }
    if (policy.hardResyncThresholdSeconds <=
        policy.targetLatencySeconds + policy.softCatchupThresholdSeconds) {
        throw new InvalidContinuityPolicyError('hardResyncThresholdSeconds');
    }
}
function requireFinitePositive(field, value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new InvalidContinuityPolicyError(field);
    }
}
