import { describe, expect, it } from 'vitest'

import {
  contrastRatio,
  normalizeHexColor,
  resolveAccessibleTextColor,
} from '../../src/danmaku/renderers/index.js'

describe('danmaku colors', () => {
  it('normalizes only bounded hexadecimal colors', () => {
    expect(normalizeHexColor('#AbC')).toBe('#aabbcc')
    expect(normalizeHexColor('#12Fe90')).toBe('#12fe90')
    expect(normalizeHexColor('red')).toBeNull()
  })

  it('uses the fallback when the requested text does not meet contrast', () => {
    expect(resolveAccessibleTextColor('#111111', '#000000', '#ffffff')).toBe('#ffffff')
    expect(resolveAccessibleTextColor('#ffffff', '#000000', '#eeeeee')).toBe('#ffffff')
  })

  it('computes the known black and white contrast ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
  })
})
