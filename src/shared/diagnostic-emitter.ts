import type { Clock } from './clock.js'
import type {
  DiagnosticDetail,
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticScope,
  EngineHooks,
} from './diagnostics.js'

const MAX_DIAGNOSTIC_CODES = 32
const DIAGNOSTIC_COOLDOWN_MS = 1_000

export type DiagnosticEmitter = (
  code: string,
  level: DiagnosticLevel,
  generation?: number,
  detail?: DiagnosticDetail,
) => void

export function createDiagnosticEmitter(
  scope: DiagnosticScope,
  hooks: EngineHooks,
  clock: Pick<Clock, 'now'>,
): DiagnosticEmitter {
  const lastEmittedAt = new Map<string, number>()

  return (code, level, generation, detail): void => {
    if (hooks.onDiagnostic === undefined) return
    const previousEmission = lastEmittedAt.get(code)
    let now: number
    try {
      now = clock.now()
    } catch {
      return
    }
    if (!Number.isFinite(now)) return
    if (previousEmission !== undefined && now - previousEmission < DIAGNOSTIC_COOLDOWN_MS) return
    if (previousEmission === undefined && lastEmittedAt.size >= MAX_DIAGNOSTIC_CODES) return

    lastEmittedAt.set(code, now)
    const event: DiagnosticEvent = { scope, code, level }
    if (generation !== undefined) event.generation = generation
    if (detail !== undefined) event.detail = detail
    try {
      hooks.onDiagnostic(event)
    } catch {
      return
    }
  }
}
