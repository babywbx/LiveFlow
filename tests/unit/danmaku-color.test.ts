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
  it('weights each color channel when enforcing the contrast threshold', () => {
    expect(contrastRatio('#f00', '#000')).toBeCloseTo(5.252, 8)
    expect(contrastRatio('#0f0', '#000')).toBeCloseTo(15.304, 8)
    expect(contrastRatio('#00f', '#000')).toBeCloseTo(2.444, 8)
    expect(resolveAccessibleTextColor('#00f', '#000', '#ABC')).toBe('#aabbcc')
  })
})
