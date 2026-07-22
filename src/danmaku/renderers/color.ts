const DEFAULT_BACKGROUND = '#000000'
const DEFAULT_FOREGROUND = '#ffffff'

export function normalizeHexColor(input: string): string | null {
  const short = /^#([\da-f]{3})$/i.exec(input)
  if (short !== null) {
    const digits = short[1]
    if (digits === undefined) {
      return null
    }
    return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`.toLowerCase()
  }
  return /^#[\da-f]{6}$/i.test(input) ? input.toLowerCase() : null
}

export function contrastRatio(first: string, second: string): number | null {
  const firstRgb = parseHexColor(first)
  const secondRgb = parseHexColor(second)
  if (firstRgb === null || secondRgb === null) {
    return null
  }
  const firstLuminance = relativeLuminance(firstRgb)
  const secondLuminance = relativeLuminance(secondRgb)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

export function resolveAccessibleTextColor(
  requested: string | undefined,
  background = DEFAULT_BACKGROUND,
  fallback = DEFAULT_FOREGROUND,
  minimumRatio = 4.5,
): string {
  const safeBackground = normalizeHexColor(background) ?? DEFAULT_BACKGROUND
  const safeFallback = normalizeHexColor(fallback) ?? DEFAULT_FOREGROUND
  if (requested === undefined) {
    return safeFallback
  }
  const safeRequested = normalizeHexColor(requested)
  if (safeRequested === null) {
    return safeFallback
  }
  const ratio = contrastRatio(safeRequested, safeBackground)
  return ratio !== null && ratio >= minimumRatio ? safeRequested : safeFallback
}

interface Rgb {
  readonly red: number
  readonly green: number
  readonly blue: number
}

function parseHexColor(input: string): Rgb | null {
  const normalized = normalizeHexColor(input)
  if (normalized === null) {
    return null
  }
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  return { red, green, blue }
}

function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * linearize(color.red) + 0.7152 * linearize(color.green) + 0.0722 * linearize(color.blue)
  )
}

function linearize(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
}
