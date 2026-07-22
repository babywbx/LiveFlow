import type { Clock } from './clock.js'
import type { DiagnosticEvent, EngineHooks } from './diagnostics.js'

const MAX_DIAGNOSTIC_CODES = 32
const DIAGNOSTIC_COOLDOWN_MS = 1_000

export interface DiagnosticEmitter {
  emit(event: DiagnosticEvent): void
}

export function createDiagnosticEmitter(hooks: EngineHooks, clock: Clock): DiagnosticEmitter {
  const lastEmittedAt = new Map<string, number>()

  return {
    emit(event: DiagnosticEvent): void {
      if (hooks.onDiagnostic === undefined) {
        return
      }

      const previousEmission = lastEmittedAt.get(event.code)
      let now: number
      try {
        now = clock.now()
      } catch {
        return
      }
      if (!Number.isFinite(now)) {
        return
      }
      if (previousEmission !== undefined && now - previousEmission < DIAGNOSTIC_COOLDOWN_MS) {
        return
      }
      if (previousEmission === undefined && lastEmittedAt.size >= MAX_DIAGNOSTIC_CODES) {
        return
      }

      lastEmittedAt.set(event.code, now)
      try {
        hooks.onDiagnostic(event)
      } catch {
        return
      }
    },
  }
}
