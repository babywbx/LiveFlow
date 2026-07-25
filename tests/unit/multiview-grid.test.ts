import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MULTIVIEW_ASPECT_RATIO,
  DEFAULT_MULTIVIEW_MAX_TILES,
  multiviewGridBox,
  multiviewGridSpec,
  multiviewGridTracks,
} from '../../src/multiview/index.js'

describe('multiviewGridSpec', () => {
  it.each([
    [0, 0, 0, 0],
    [1, 1, 1, 0],
    [2, 2, 1, 0],
    [3, 2, 2, 1],
    [4, 2, 2, 0],
    [5, 3, 2, 1],
    [6, 3, 2, 0],
    [7, 3, 3, 2],
    [8, 3, 3, 1],
    [9, 3, 3, 0],
  ])(
    'maps %i tiles to %i columns x %i rows with %i placeholders',
    (tileCount, columns, rows, placeholders) => {
      expect(multiviewGridSpec(tileCount)).toEqual({ columns, rows, placeholders })
    },
  )

  it('defaults to a nine tile ceiling', () => {
    expect(DEFAULT_MULTIVIEW_MAX_TILES).toBe(9)
    expect(multiviewGridSpec(9, { maxTiles: DEFAULT_MULTIVIEW_MAX_TILES })).toEqual(
      multiviewGridSpec(9),
    )
  })

  it('extends the ladder when the caller raises maxTiles', () => {
    expect(multiviewGridSpec(12, { maxTiles: 16 })).toEqual({
      columns: 4,
      rows: 3,
      placeholders: 0,
    })
    expect(multiviewGridSpec(16, { maxTiles: 16 })).toEqual({
      columns: 4,
      rows: 4,
      placeholders: 0,
    })
  })

  it('keeps placeholders as the unused cells of the grid', () => {
    for (let tileCount = 0; tileCount <= DEFAULT_MULTIVIEW_MAX_TILES; tileCount += 1) {
      const spec = multiviewGridSpec(tileCount)
      expect(spec.placeholders).toBe(spec.columns * spec.rows - tileCount)
    }
  })

  it('returns a fresh object so callers cannot poison later calls', () => {
    const first = multiviewGridSpec(4)
    first.columns = 99
    expect(multiviewGridSpec(4).columns).toBe(2)
  })
})

describe('multiviewGridBox', () => {
  it('keeps tiles 16:9 and contains the grid inside the stage', () => {
    const box = multiviewGridBox({
      stage: { width: 1600, height: 900 },
      spec: multiviewGridSpec(4),
      gap: 8,
    })
    expect(box.tileWidth / box.tileHeight).toBeCloseTo(DEFAULT_MULTIVIEW_ASPECT_RATIO)
    expect(box.width).toBeLessThanOrEqual(1600)
    expect(box.height).toBeLessThanOrEqual(900)
  })

  it('is width limited on a narrow stage and height limited on a wide stage', () => {
    const narrow = multiviewGridBox({
      stage: { width: 800, height: 2000 },
      spec: multiviewGridSpec(4),
      gap: 8,
    })
    expect(narrow.width).toBeCloseTo(800)
    const wide = multiviewGridBox({
      stage: { width: 4000, height: 600 },
      spec: multiviewGridSpec(4),
      gap: 8,
    })
    expect(wide.height).toBeCloseTo(600)
  })

  it('honours a custom aspect ratio', () => {
    const box = multiviewGridBox({
      stage: { width: 1600, height: 900 },
      spec: multiviewGridSpec(4),
      gap: 0,
      aspectRatio: 4 / 3,
    })
    expect(box.tileWidth / box.tileHeight).toBeCloseTo(4 / 3)
    expect(box.height).toBeLessThanOrEqual(900)
  })

  it('reserves the gap between tiles only', () => {
    const box = multiviewGridBox({
      stage: { width: 1600, height: 900 },
      spec: multiviewGridSpec(9),
      gap: 10,
    })
    expect(box.width).toBeCloseTo(box.tileWidth * 3 + 20)
    expect(box.height).toBeCloseTo(box.tileHeight * 3 + 20)
  })

  it('returns a zero box when there is no usable space', () => {
    const emptyStage = multiviewGridBox({
      stage: { width: 0, height: 0 },
      spec: multiviewGridSpec(4),
      gap: 8,
    })
    expect(emptyStage).toEqual({ width: 0, height: 0, tileWidth: 0, tileHeight: 0 })

    const noTiles = multiviewGridBox({
      stage: { width: 1600, height: 900 },
      spec: multiviewGridSpec(0),
      gap: 8,
    })
    expect(noTiles).toEqual({ width: 0, height: 0, tileWidth: 0, tileHeight: 0 })

    const gapEatsTheStage = multiviewGridBox({
      stage: { width: 10, height: 900 },
      spec: multiviewGridSpec(9),
      gap: 40,
    })
    expect(gapEatsTheStage).toEqual({ width: 0, height: 0, tileWidth: 0, tileHeight: 0 })
  })
})

describe('multiviewGridTracks', () => {
  it('renders explicit repeat tracks for both axes', () => {
    expect(multiviewGridTracks(multiviewGridSpec(6))).toEqual({
      gridTemplateColumns: 'repeat(3, 1fr)',
      gridTemplateRows: 'repeat(2, 1fr)',
    })
    expect(multiviewGridTracks(multiviewGridSpec(1))).toEqual({
      gridTemplateColumns: 'repeat(1, 1fr)',
      gridTemplateRows: 'repeat(1, 1fr)',
    })
  })

  it('renders no tracks for an empty grid', () => {
    expect(multiviewGridTracks(multiviewGridSpec(0))).toEqual({
      gridTemplateColumns: 'none',
      gridTemplateRows: 'none',
    })
  })

  it('always declares the row track explicitly so placeholders cannot stretch it', () => {
    for (let tileCount = 1; tileCount <= DEFAULT_MULTIVIEW_MAX_TILES; tileCount += 1) {
      const spec = multiviewGridSpec(tileCount)
      const tracks = multiviewGridTracks(spec)
      expect(tracks.gridTemplateRows).toMatch(/^repeat\(\d+, 1fr\)$/)
      expect(tracks.gridTemplateRows).toBe(`repeat(${String(spec.rows)}, 1fr)`)
      expect(tracks.gridTemplateRows).not.toBe('auto')
      expect(tracks.gridTemplateRows).not.toBe('')
    }
  })

  it('sizes every row exactly like the computed tile height', () => {
    const spec = multiviewGridSpec(7)
    const tracks = multiviewGridTracks(spec)
    const box = multiviewGridBox({ stage: { width: 1600, height: 900 }, spec, gap: 12 })
    const declaredRows = Number(/^repeat\((\d+), 1fr\)$/.exec(tracks.gridTemplateRows)?.[1])
    expect(declaredRows).toBe(spec.rows)
    expect(box.height).toBeCloseTo(box.tileHeight * declaredRows + 12 * (declaredRows - 1))
  })
})
