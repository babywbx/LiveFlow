import { InvalidOverlayConfigurationError, InvalidOverlayEventError } from './errors.js'
import type { BannerTextFit, BannerTextMeasure } from './event-banner-types.js'

export const MAX_BANNER_FONT_STEPS = 8

const ELLIPSIS = '…'

export function normalizeBannerText(value: string, maxLength: number, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidOverlayEventError(field)
  }
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length === 0 || text.length > maxLength) {
    throw new InvalidOverlayEventError(field)
  }
  return text
}

export function validateBannerFontSizes(fontSizes: readonly number[]): readonly number[] {
  // Narrowing a readonly array through Array.isArray widens the element type to any.
  const candidate: unknown = fontSizes
  if (
    !Array.isArray(candidate) ||
    fontSizes.length === 0 ||
    fontSizes.length > MAX_BANNER_FONT_STEPS
  ) {
    throw new InvalidOverlayConfigurationError('layout.fontSizes')
  }
  let previous = Number.POSITIVE_INFINITY
  for (const fontSize of fontSizes) {
    if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize >= previous) {
      throw new InvalidOverlayConfigurationError('layout.fontSizes')
    }
    previous = fontSize
  }
  return [...fontSizes]
}

export function smallestBannerFontSize(fontSizes: readonly number[]): number {
  const smallest = fontSizes[fontSizes.length - 1]
  if (smallest === undefined) {
    throw new InvalidOverlayConfigurationError('layout.fontSizes')
  }
  return smallest
}

export function fitBannerText(
  text: string,
  maxWidth: number,
  fontSizes: readonly number[],
  measure: BannerTextMeasure,
): BannerTextFit {
  const steps = validateBannerFontSizes(fontSizes)
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    throw new InvalidOverlayConfigurationError('layout.maxTextWidth')
  }
  if (text.length === 0) {
    throw new InvalidOverlayEventError('content.text')
  }

  for (const fontSize of steps) {
    if (measuredWidth(text, fontSize, measure) <= maxWidth) {
      return { text, fontSize, truncated: false }
    }
  }

  const fontSize = smallestBannerFontSize(steps)
  const graphemes = splitGraphemes(text)
  let low = 0
  let high = graphemes.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${graphemes.slice(0, middle).join('')}${ELLIPSIS}`
    if (measuredWidth(candidate, fontSize, measure) <= maxWidth) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  const truncated = `${graphemes.slice(0, Math.max(0, low)).join('')}${ELLIPSIS}`
  if (measuredWidth(truncated, fontSize, measure) > maxWidth) {
    throw new InvalidOverlayConfigurationError('layout.maxTextWidth')
  }
  return { text: truncated, fontSize, truncated: true }
}

function measuredWidth(text: string, fontSize: number, measure: BannerTextMeasure): number {
  const width = measure(text, fontSize)
  if (!Number.isFinite(width) || width < 0) {
    throw new InvalidOverlayConfigurationError('measureText')
  }
  return width
}

function splitGraphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(value), (entry) => entry.segment)
}
