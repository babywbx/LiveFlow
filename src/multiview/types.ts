export interface MultiviewGridSpec {
  columns: number
  rows: number
  placeholders: number
}

export interface MultiviewGridSpecOptions {
  maxTiles?: number
}

export interface MultiviewStageSize {
  width: number
  height: number
}

export interface MultiviewGridBox {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
}

export interface MultiviewGridBoxOptions {
  stage: MultiviewStageSize
  spec: MultiviewGridSpec
  gap: number
  aspectRatio?: number
}

export interface MultiviewGridTracks {
  gridTemplateColumns: string
  gridTemplateRows: string
}
