import { normalizeHexColor } from '../hex-color.js';
export { normalizeHexColor };
export declare function contrastRatio(first: string, second: string): number | null;
export declare function resolveAccessibleTextColor(requested: string | undefined, background?: string, fallback?: string, minimumRatio?: number): string;
