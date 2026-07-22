import type { Clock } from './clock.js';
import type { DiagnosticEvent, EngineHooks } from './diagnostics.js';
export interface DiagnosticEmitter {
    emit(event: DiagnosticEvent): void;
}
export declare function createDiagnosticEmitter(hooks: EngineHooks, clock: Clock): DiagnosticEmitter;
