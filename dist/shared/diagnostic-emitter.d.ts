import type { Clock } from './clock.js';
import type { DiagnosticDetail, DiagnosticLevel, DiagnosticScope, EngineHooks } from './diagnostics.js';
export type DiagnosticEmitter = (code: string, level: DiagnosticLevel, generation?: number, detail?: DiagnosticDetail) => void;
export declare function createDiagnosticEmitter(scope: DiagnosticScope, hooks: EngineHooks, clock: Pick<Clock, 'now'>): DiagnosticEmitter;
