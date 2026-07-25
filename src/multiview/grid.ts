import { CapacityExceededError } from '../shared/errors.js'
import { InvalidMultiviewLayoutError } from './errors.js'
import type {
  MultiviewGridBox,
  MultiviewGridBoxOptions,
  MultiviewGridSpec,
  MultiviewGridSpecOptions,
  MultiviewGridTracks,
  MultiviewStageSize,
} from './types.js'

export const DEFAULT_MULTIVIEW_MAX_TILES = 9
export const DEFAULT_MULTIVIEW_ASPECT_RATIO = 16 / 9

export function multiviewGridSpec(
  tileCount: number,
  options?: MultiviewGridSpecOptions,
): MultiviewGridSpec {
  const maxTiles = options?.maxTiles ?? DEFAULT_MULTIVIEW_MAX_TILES
  if (!Number.isSafeInteger(maxTiles) || maxTiles < 1) {
    throw new InvalidMultiviewLayoutError('maxTiles')
  }
  if (!Number.isSafeInteger(tileCount) || tileCount < 0) {
    throw new InvalidMultiviewLayoutError('tileCount')
  }
  if (tileCount > maxTiles) {
    throw new CapacityExceededError('multiview-tiles', maxTiles)
  }
  if (tileCount === 0) {
    return { columns: 0, rows: 0, placeholders: 0 }
  }
  const columns = Math.ceil(Math.sqrt(tileCount))
  const rows = Math.ceil(tileCount / columns)
  return { columns, rows, placeholders: columns * rows - tileCount }
}

export function multiviewGridBox(options: MultiviewGridBoxOptions): MultiviewGridBox {
  const { spec, stage, gap } = options
  const aspectRatio = options.aspectRatio ?? DEFAULT_MULTIVIEW_ASPECT_RATIO
  validateGridSpec(spec)
  validateStage(stage)
  if (!Number.isFinite(gap) || gap < 0) {
    throw new InvalidMultiviewLayoutError('gap')
  }
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new InvalidMultiviewLayoutError('aspectRatio')
  }

  if (spec.columns === 0 || spec.rows === 0 || stage.width === 0 || stage.height === 0) {
    return emptyBox()
  }
  const availableWidth = stage.width - gap * (spec.columns - 1)
  const availableHeight = stage.height - gap * (spec.rows - 1)
  if (availableWidth <= 0 || availableHeight <= 0) {
    return emptyBox()
  }

  const tileWidth = Math.min(
    availableWidth / spec.columns,
    (availableHeight / spec.rows) * aspectRatio,
  )
  const tileHeight = tileWidth / aspectRatio
  return {
    width: tileWidth * spec.columns + gap * (spec.columns - 1),
    height: tileHeight * spec.rows + gap * (spec.rows - 1),
    tileWidth,
    tileHeight,
  }
}

export function multiviewGridTracks(spec: MultiviewGridSpec): MultiviewGridTracks {
  validateGridSpec(spec)
  if (spec.columns === 0) {
    return { gridTemplateColumns: 'none', gridTemplateRows: 'none' }
  }
  return {
    gridTemplateColumns: `repeat(${String(spec.columns)}, 1fr)`,
    gridTemplateRows: `repeat(${String(spec.rows)}, 1fr)`,
  }
}

function validateGridSpec(spec: MultiviewGridSpec): void {
  validateTrackCount(spec.columns, 'spec.columns')
  validateTrackCount(spec.rows, 'spec.rows')
  if (!Number.isSafeInteger(spec.placeholders) || spec.placeholders < 0) {
    throw new InvalidMultiviewLayoutError('spec.placeholders')
  }
  if (spec.columns === 0 && spec.rows > 0) {
    throw new InvalidMultiviewLayoutError('spec.columns')
  }
  if (spec.rows === 0 && spec.columns > 0) {
    throw new InvalidMultiviewLayoutError('spec.rows')
  }
  const cells = spec.columns * spec.rows
  if (spec.placeholders >= Math.max(cells, 1)) {
    throw new InvalidMultiviewLayoutError('spec.placeholders')
  }
}

function validateTrackCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidMultiviewLayoutError(field)
  }
}

function validateStage(stage: MultiviewStageSize): void {
  if (!Number.isFinite(stage.width) || stage.width < 0) {
    throw new InvalidMultiviewLayoutError('stage.width')
  }
  if (!Number.isFinite(stage.height) || stage.height < 0) {
    throw new InvalidMultiviewLayoutError('stage.height')
  }
}

function emptyBox(): MultiviewGridBox {
  return { width: 0, height: 0, tileWidth: 0, tileHeight: 0 }
}
