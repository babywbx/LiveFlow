export type DiagnosticScope = 'continuity' | 'danmaku' | 'overlay'

export type DiagnosticLevel = 'debug' | 'info' | 'warn'

export type DiagnosticDetail = Readonly<Record<string, string | number | boolean>>

export interface DiagnosticEvent {
  scope: DiagnosticScope
  code: string
  level: DiagnosticLevel
  generation?: number
  detail?: DiagnosticDetail
}

export interface EngineHooks {
  onDiagnostic?(event: DiagnosticEvent): void
}
