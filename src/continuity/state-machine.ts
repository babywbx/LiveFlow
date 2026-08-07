import type { ContinuityState } from './types.js'

export interface ContinuityMachineState {
  readonly state: ContinuityState
  readonly generation: number
  readonly automaticRecoveryCount: number
}

export type ContinuityMachineEvent =
  | { readonly type: 'source-requested'; readonly generation: number }
  | { readonly type: 'source-prepared'; readonly generation: number }
  | { readonly type: 'first-frame'; readonly generation: number }
  | { readonly type: 'playback-degraded'; readonly generation: number }
  | { readonly type: 'playback-resumed'; readonly generation: number }
  | { readonly type: 'recovery-requested'; readonly generation: number }
  | { readonly type: 'recovery-cancelled'; readonly generation: number }
  | { readonly type: 'recovery-exhausted'; readonly generation: number }
  | { readonly type: 'source-failed'; readonly generation: number }
  | { readonly type: 'playback-suspended'; readonly generation: number }
  | { readonly type: 'destroyed' }

export const INITIAL_CONTINUITY_STATE: ContinuityMachineState = {
  state: 'idle',
  generation: 0,
  automaticRecoveryCount: 0,
}

export function reduceContinuityState(
  current: ContinuityMachineState,
  event: ContinuityMachineEvent,
): ContinuityMachineState {
  if (current.state === 'stopped') {
    return current
  }

  if (event.type === 'destroyed') {
    return {
      ...current,
      state: 'stopped',
    }
  }

  if (event.type === 'source-requested') {
    if (event.generation <= current.generation) {
      return current
    }

    return {
      state: 'resolving',
      generation: event.generation,
      automaticRecoveryCount: current.automaticRecoveryCount,
    }
  }

  if (event.generation !== current.generation) {
    return current
  }

  switch (event.type) {
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
        current.state !== 'recovering'
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
      if (
        current.state !== 'warming' &&
        current.state !== 'playing' &&
        current.state !== 'degraded'
      ) {
        return current
      }
      return {
        ...current,
        state: 'suspended',
      }
  }
}
