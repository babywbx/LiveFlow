import { normalizeHexColor } from '../hex-color.js'

export { normalizeHexColor }

const DEFAULT_BACKGROUND = '#000000'
const DEFAULT_FOREGROUND = '#ffffff'

export function contrastRatio(first: string, second: string): number | null {
  const firstColor = normalizeHexColor(first)
  const secondColor = normalizeHexColor(second)
  return firstColor === null || secondColor === null ? null : contrast(firstColor, secondColor)
}

export function resolveAccessibleTextColor(
  requested: string | undefined,
  background = DEFAULT_BACKGROUND,
  fallback = DEFAULT_FOREGROUND,
  minimumRatio = 4.5,
): string {
  const safeRequested = requested === undefined ? null : normalizeHexColor(requested)
  if (safeRequested !== null) {
    const safeBackground = normalizeHexColor(background) ?? DEFAULT_BACKGROUND
    if (contrast(safeRequested, safeBackground) >= minimumRatio) return safeRequested
  }
  return normalizeHexColor(fallback) ?? DEFAULT_FOREGROUND
}

function contrast(first: string, second: string): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function relativeLuminance(color: string): number {
  const rgb = Number.parseInt(color.slice(1), 16)
  return (
    0.2126 * linearize(rgb >> 16) +
    0.7152 * linearize((rgb >> 8) & 255) +
    0.0722 * linearize(rgb & 255)
  )
}

function linearize(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
}
