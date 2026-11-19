import type { ContinuityState } from './types.js'

export interface ContinuityMachineState {
  readonly state: ContinuityState
  readonly generation: number
  readonly automaticRecoveryCount: number
}

export type ContinuityMachineEvent =
  | 'source-requested'
  | 'source-prepared'
  | 'first-frame'
  | 'playback-degraded'
  | 'playback-resumed'
  | 'recovery-requested'
  | 'recovery-cancelled'
  | 'recovery-exhausted'
  | 'source-failed'
  | 'playback-suspended'
  | 'destroyed'

export const INITIAL_CONTINUITY_STATE: ContinuityMachineState = {
  state: 'idle',
  generation: 0,
  automaticRecoveryCount: 0,
}

export function reduceContinuityState(
  current: ContinuityMachineState,
  event: ContinuityMachineEvent,
  generation: number,
): ContinuityMachineState {
  if (current.state === 'stopped') {
    return current
  }

  if (event === 'destroyed') {
    return {
      ...current,
      state: 'stopped',
    }
  }

  if (event === 'source-requested') {
    if (generation <= current.generation) {
      return current
    }

    return {
      state: 'resolving',
      generation,
      automaticRecoveryCount: current.automaticRecoveryCount,
    }
  }

  if (generation !== current.generation) {
    return current
  }

  switch (event) {
    case 'source-prepared':
      if (current.state !== 'resolving') {
        return current
      }
      return {
        ...current,
        state: 'warming',
      }
    case 'first-frame':
      if (
        current.state !== 'warming' &&
        current.state !== 'degraded' &&
        current.state !== 'recovering' &&
        current.state !== 'waiting-reopen' &&
        current.state !== 'suspended'
      ) {
        return current
      }
      return {
        ...current,
        state: 'playing',
        automaticRecoveryCount: current.state === 'warming' ? 0 : current.automaticRecoveryCount,
      }
    case 'playback-degraded':
      if (
        current.state !== 'resolving' &&
        current.state !== 'warming' &&
        current.state !== 'playing' &&
        current.state !== 'recovering' &&
        current.state !== 'suspended'
      ) {
        return current
      }
      return {
        ...current,
        state: 'degraded',
      }
    case 'playback-resumed':
      if (
        current.state !== 'degraded' &&
        current.state !== 'recovering' &&
        current.state !== 'waiting-reopen' &&
        current.state !== 'suspended'
      ) {
        return current
      }
      return {
        ...current,
        state: 'playing',
      }
    case 'recovery-requested':
      if (current.state !== 'warming' && current.state !== 'degraded') {
        return current
      }
      return {
        ...current,
        state: 'recovering',
        automaticRecoveryCount: current.automaticRecoveryCount + 1,
      }
    case 'recovery-cancelled':
      if (current.automaticRecoveryCount === 0) {
        return current
      }
      return {
        ...current,
        automaticRecoveryCount: current.automaticRecoveryCount - 1,
      }
    case 'recovery-exhausted':
      if (current.state !== 'degraded' && current.state !== 'recovering') {
        return current
      }
      return {
        ...current,
        state: 'waiting-reopen',
      }
    case 'source-failed':
      if (current.state !== 'resolving' && current.state !== 'warming') {
        return current
      }
      return {
        ...current,
        state: 'recovering',
      }
    case 'playback-suspended':
      if (current.state !== 'warming' && current.state !== 'playing') {
        return current
      }
      return {
        ...current,
        state: 'suspended',
      }
  }
}
