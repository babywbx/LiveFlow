import { InvalidContinuityPolicyError } from '../shared/errors.js'
import type { ContinuityPolicy } from './types.js'

export const DEFAULT_CONTINUITY_POLICY: Readonly<ContinuityPolicy> = {
  targetLatencySeconds: 2,
  softCatchupThresholdSeconds: 0.6,
  hardResyncThresholdSeconds: 8,
  catchupRate: 1.04,
  recoveryCooldownMs: 30_000,
  sourceWarmupTimeoutMs: 8_000,
  reopenGraceMs: 90_000,
  maxAutomaticRecoveries: 4,
}

export function resolveContinuityPolicy(
  overrides: Partial<ContinuityPolicy> | undefined,
): ContinuityPolicy {
  const policy: ContinuityPolicy = {
    targetLatencySeconds:
      overrides?.targetLatencySeconds ?? DEFAULT_CONTINUITY_POLICY.targetLatencySeconds,
    softCatchupThresholdSeconds:
      overrides?.softCatchupThresholdSeconds ??
      DEFAULT_CONTINUITY_POLICY.softCatchupThresholdSeconds,
    hardResyncThresholdSeconds:
      overrides?.hardResyncThresholdSeconds ?? DEFAULT_CONTINUITY_POLICY.hardResyncThresholdSeconds,
    catchupRate: overrides?.catchupRate ?? DEFAULT_CONTINUITY_POLICY.catchupRate,
    recoveryCooldownMs:
      overrides?.recoveryCooldownMs ?? DEFAULT_CONTINUITY_POLICY.recoveryCooldownMs,
    sourceWarmupTimeoutMs:
      overrides?.sourceWarmupTimeoutMs ?? DEFAULT_CONTINUITY_POLICY.sourceWarmupTimeoutMs,
    reopenGraceMs: overrides?.reopenGraceMs ?? DEFAULT_CONTINUITY_POLICY.reopenGraceMs,
    maxAutomaticRecoveries:
      overrides?.maxAutomaticRecoveries ?? DEFAULT_CONTINUITY_POLICY.maxAutomaticRecoveries,
  }

  validateContinuityPolicy(policy)
  return policy
}

function validateContinuityPolicy(policy: ContinuityPolicy): void {
  requireFinitePositive('targetLatencySeconds', policy.targetLatencySeconds)
  requireFinitePositive('softCatchupThresholdSeconds', policy.softCatchupThresholdSeconds)
  requireFinitePositive('hardResyncThresholdSeconds', policy.hardResyncThresholdSeconds)
  requireFinitePositive('recoveryCooldownMs', policy.recoveryCooldownMs)
  requireFinitePositive('sourceWarmupTimeoutMs', policy.sourceWarmupTimeoutMs)
  requireFinitePositive('reopenGraceMs', policy.reopenGraceMs)

  if (policy.catchupRate <= 1 || policy.catchupRate > 1.1 || !Number.isFinite(policy.catchupRate)) {
    throw new InvalidContinuityPolicyError('catchupRate')
  }
  if (
    !Number.isInteger(policy.maxAutomaticRecoveries) ||
    policy.maxAutomaticRecoveries < 1 ||
    policy.maxAutomaticRecoveries > 100
  ) {
    throw new InvalidContinuityPolicyError('maxAutomaticRecoveries')
  }
  if (
    policy.hardResyncThresholdSeconds <=
    policy.targetLatencySeconds + policy.softCatchupThresholdSeconds
  ) {
    throw new InvalidContinuityPolicyError('hardResyncThresholdSeconds')
  }
}

function requireFinitePositive(field: keyof ContinuityPolicy, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidContinuityPolicyError(field)
  }
}
