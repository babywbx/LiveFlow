import type { PageActivitySource } from '../continuity/types.js';
export interface PageVisibilityDocument {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
export interface DocumentPageActivityOptions {
    readonly document?: PageVisibilityDocument;
}
export declare function createDocumentPageActivity(options?: DocumentPageActivityOptions): PageActivitySource;
