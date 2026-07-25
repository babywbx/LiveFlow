import { describe, expect, it } from 'vitest'

import {
  InvalidMultiviewLayoutError,
  multiviewGridBox,
  multiviewGridSpec,
  multiviewGridTracks,
} from '../../src/multiview/index.js'
import { CapacityExceededError, LiveFlowError } from '../../src/shared/index.js'

const spec = multiviewGridSpec(4)
const stage = { width: 1600, height: 900 }

describe('multiviewGridSpec validation', () => {
  it.each([[-1], [Number.NaN], [1.5], [Number.POSITIVE_INFINITY]])(
    'rejects tile count %p',
    (tileCount) => {
      expect(() => multiviewGridSpec(tileCount)).toThrow(InvalidMultiviewLayoutError)
    },
  )

  it.each([[0], [-4], [Number.NaN], [2.5]])('rejects maxTiles %p', (maxTiles) => {
    expect(() => multiviewGridSpec(4, { maxTiles })).toThrow(InvalidMultiviewLayoutError)
  })

  it('reports the invalid field and a stable code', () => {
    try {
      multiviewGridSpec(-1)
      expect.unreachable('an invalid tile count must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LiveFlowError)
      expect(error).toBeInstanceOf(InvalidMultiviewLayoutError)
      if (error instanceof InvalidMultiviewLayoutError) {
        expect(error.code).toBe('invalid-multiview-layout')
        expect(error.field).toBe('tileCount')
        expect(error.name).toBe('InvalidMultiviewLayoutError')
      }
    }
  })

  it('refuses to silently drop tiles above the ceiling', () => {
    expect(() => multiviewGridSpec(10)).toThrow(CapacityExceededError)
    expect(() => multiviewGridSpec(5, { maxTiles: 4 })).toThrow(CapacityExceededError)
  })
})

describe('multiviewGridBox validation', () => {
  it('rejects a negative gap', () => {
    expect(() => multiviewGridBox({ stage, spec, gap: -1 })).toThrow(InvalidMultiviewLayoutError)
  })

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY]])('rejects gap %p', (gap) => {
    expect(() => multiviewGridBox({ stage, spec, gap })).toThrow(InvalidMultiviewLayoutError)
  })

  it.each([[0], [-16 / 9], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rejects aspect ratio %p',
    (aspectRatio) => {
      expect(() => multiviewGridBox({ stage, spec, gap: 8, aspectRatio })).toThrow(
        InvalidMultiviewLayoutError,
      )
    },
  )

  it.each([
    [{ width: -1, height: 900 }],
    [{ width: 1600, height: -1 }],
    [{ width: Number.NaN, height: 900 }],
    [{ width: 1600, height: Number.POSITIVE_INFINITY }],
  ])('rejects stage %p', (invalidStage) => {
    expect(() => multiviewGridBox({ stage: invalidStage, spec, gap: 8 })).toThrow(
      InvalidMultiviewLayoutError,
    )
  })

  it('rejects a hand built spec that is internally inconsistent', () => {
    expect(() =>
      multiviewGridBox({ stage, spec: { columns: 0, rows: 2, placeholders: 0 }, gap: 8 }),
    ).toThrow(InvalidMultiviewLayoutError)
    expect(() =>
      multiviewGridBox({ stage, spec: { columns: 2, rows: 0, placeholders: 0 }, gap: 8 }),
    ).toThrow(InvalidMultiviewLayoutError)
    expect(() =>
      multiviewGridBox({ stage, spec: { columns: -2, rows: 2, placeholders: 0 }, gap: 8 }),
    ).toThrow(InvalidMultiviewLayoutError)
    expect(() =>
      multiviewGridBox({ stage, spec: { columns: 2, rows: 2, placeholders: 4 }, gap: 8 }),
    ).toThrow(InvalidMultiviewLayoutError)
    expect(() =>
      multiviewGridBox({ stage, spec: { columns: 2, rows: 2, placeholders: -1 }, gap: 8 }),
    ).toThrow(InvalidMultiviewLayoutError)
  })

  it('accepts a zero sized stage as a legitimate absence of space', () => {
    expect(() => multiviewGridBox({ stage: { width: 0, height: 0 }, spec, gap: 8 })).not.toThrow()
    expect(() => multiviewGridBox({ stage, spec, gap: 0 })).not.toThrow()
  })
})

describe('multiviewGridTracks validation', () => {
  it('rejects an inconsistent spec instead of emitting broken CSS', () => {
    expect(() => multiviewGridTracks({ columns: 3, rows: 0, placeholders: 0 })).toThrow(
      InvalidMultiviewLayoutError,
    )
    expect(() => multiviewGridTracks({ columns: 3, rows: 3, placeholders: 9 })).toThrow(
      InvalidMultiviewLayoutError,
    )
    expect(() => multiviewGridTracks({ columns: 1.5, rows: 1, placeholders: 0 })).toThrow(
      InvalidMultiviewLayoutError,
    )
  })
})
