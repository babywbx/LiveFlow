import type { MultiviewGridBox, MultiviewGridBoxOptions, MultiviewGridSpec, MultiviewGridSpecOptions, MultiviewGridTracks } from './types.js';
export declare const DEFAULT_MULTIVIEW_MAX_TILES = 9;
export declare const DEFAULT_MULTIVIEW_ASPECT_RATIO: number;
export declare function multiviewGridSpec(tileCount: number, options?: MultiviewGridSpecOptions): MultiviewGridSpec;
export declare function multiviewGridBox(options: MultiviewGridBoxOptions): MultiviewGridBox;
export declare function multiviewGridTracks(spec: MultiviewGridSpec): MultiviewGridTracks;
