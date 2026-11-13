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
