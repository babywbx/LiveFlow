import { describe, expect, it } from 'vitest'

import {
  fitBannerText,
  MAX_BANNER_FONT_STEPS,
  normalizeBannerText,
  validateBannerFontSizes,
} from '../../src/overlay/banner.js'
import {
  InvalidOverlayConfigurationError,
  InvalidOverlayEventError,
} from '../../src/overlay/index.js'

const FONT_SIZES = [28, 26, 24, 22]

function measureBy(widthPerFontUnit: number): (text: string, fontSize: number) => number {
  return (text: string, fontSize: number): number => text.length * fontSize * widthPerFontUnit
}

describe('event banner text fitting', () => {
  it('returns the first ladder step that fits the caller maximum width', () => {
    const measure = measureBy(0.5)

    expect(fitBannerText('a'.repeat(5), 510, FONT_SIZES, measure)).toEqual({
      text: 'a'.repeat(5),
      fontSize: 28,
      truncated: false,
    })
    expect(fitBannerText('a'.repeat(38), 510, FONT_SIZES, measure)).toEqual({
      text: 'a'.repeat(38),
      fontSize: 26,
      truncated: false,
    })
    expect(fitBannerText('a'.repeat(42), 510, FONT_SIZES, measure).fontSize).toBe(24)
  })

  it('truncates at the smallest step and keeps the longest fitting prefix', () => {
    const fit = fitBannerText('a'.repeat(60), 510, FONT_SIZES, measureBy(0.5))

    expect(fit.truncated).toBe(true)
    expect(fit.fontSize).toBe(22)
    expect(fit.text).toBe(`${'a'.repeat(45)}…`)
    expect(fit.text.length * fit.fontSize * 0.5).toBeLessThanOrEqual(510)
  })

  it('never splits a grapheme cluster while truncating', () => {
    const fit = fitBannerText('🙂'.repeat(40), 200, FONT_SIZES, measureBy(0.5))

    expect(fit.truncated).toBe(true)
    for (const character of Array.from(fit.text)) {
      const codePoint = character.codePointAt(0) ?? 0
      expect(codePoint >= 0xd800 && codePoint <= 0xdfff).toBe(false)
    }
  })

  it('collapses whitespace into a single line and rejects empty or oversized text', () => {
    expect(normalizeBannerText('  first \n  second  ', 64, 'content.text')).toBe('first second')
    expect(() => normalizeBannerText('   ', 64, 'content.text')).toThrow(InvalidOverlayEventError)
    expect(() => normalizeBannerText('a'.repeat(65), 64, 'content.text')).toThrow(
      InvalidOverlayEventError,
    )
  })

  it('rejects a ladder that is empty, unsorted, non-finite or too long', () => {
    expect(validateBannerFontSizes(FONT_SIZES)).toEqual(FONT_SIZES)
    expect(() => validateBannerFontSizes([])).toThrow(InvalidOverlayConfigurationError)
    expect(() => validateBannerFontSizes([22, 26])).toThrow(InvalidOverlayConfigurationError)
    expect(() => validateBannerFontSizes([28, 28])).toThrow(InvalidOverlayConfigurationError)
    expect(() => validateBannerFontSizes([Number.POSITIVE_INFINITY])).toThrow(
      InvalidOverlayConfigurationError,
    )
    expect(() =>
      validateBannerFontSizes(
        Array.from({ length: MAX_BANNER_FONT_STEPS + 1 }, (_unused, index) => 32 - index),
      ),
    ).toThrow(InvalidOverlayConfigurationError)
  })

  it('reports a configuration error instead of rendering text that cannot fit', () => {
    expect(() => fitBannerText('abcdef', 4, FONT_SIZES, measureBy(0.5))).toThrow(
      InvalidOverlayConfigurationError,
    )
    expect(() => fitBannerText('abcdef', 0, FONT_SIZES, measureBy(0.5))).toThrow(
      InvalidOverlayConfigurationError,
    )
  })

  it('rejects a measurement function that returns a non-finite width', () => {
    expect(() => fitBannerText('abcdef', 510, FONT_SIZES, () => Number.NaN)).toThrow(
      InvalidOverlayConfigurationError,
    )
    expect(() => fitBannerText('abcdef', 510, FONT_SIZES, () => -1)).toThrow(
      InvalidOverlayConfigurationError,
    )
  })
})
