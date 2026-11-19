import { InvalidContinuityPolicyError } from '../shared/errors.js';
export const DEFAULT_CONTINUITY_POLICY = {
    targetLatencySeconds: 2,
    softCatchupThresholdSeconds: 0.6,
    hardResyncThresholdSeconds: 8,
    maxPlausibleLiveEdgeSeconds: 3_600,
    catchupRate: 1.04,
    recoveryCooldownMs: 30_000,
    sourceWarmupTimeoutMs: 8_000,
    maxAutomaticRecoveries: 4,
    maxGapJumpSeconds: 30,
    stallNudgeSeconds: 0.1,
    maxStallSeeksPerSource: 3,
};
export function resolveContinuityPolicy(overrides) {
    const policy = { ...DEFAULT_CONTINUITY_POLICY };
    if (overrides != null) {
        for (const field in policy) {
            if (isPolicyField(field)) {
                policy[field] = overrides[field] ?? policy[field];
            }
        }
    }
    validateContinuityPolicy(policy);
    return policy;
}
function isPolicyField(field) {
    return Object.hasOwn(DEFAULT_CONTINUITY_POLICY, field);
}
function validateContinuityPolicy(policy) {
    requireFinitePositive('targetLatencySeconds', policy.targetLatencySeconds);
    requireFinitePositive('softCatchupThresholdSeconds', policy.softCatchupThresholdSeconds);
    requireFinitePositive('hardResyncThresholdSeconds', policy.hardResyncThresholdSeconds);
    requireFinitePositive('recoveryCooldownMs', policy.recoveryCooldownMs);
    requireFinitePositive('sourceWarmupTimeoutMs', policy.sourceWarmupTimeoutMs);
    requireFinitePositive('maxGapJumpSeconds', policy.maxGapJumpSeconds);
    requireFinitePositive('stallNudgeSeconds', policy.stallNudgeSeconds);
    if (!Number.isInteger(policy.maxStallSeeksPerSource) ||
        policy.maxStallSeeksPerSource < 0 ||
        policy.maxStallSeeksPerSource > 100) {
        throw new InvalidContinuityPolicyError('maxStallSeeksPerSource');
    }
    if (policy.catchupRate < 1 || policy.catchupRate > 1.1 || !Number.isFinite(policy.catchupRate)) {
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
    if (!Number.isFinite(policy.maxPlausibleLiveEdgeSeconds) ||
        policy.maxPlausibleLiveEdgeSeconds <= policy.hardResyncThresholdSeconds) {
        throw new InvalidContinuityPolicyError('maxPlausibleLiveEdgeSeconds');
    }
}
function requireFinitePositive(field, value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new InvalidContinuityPolicyError(field);
    }
}
