import { describe, expect, it, vi } from 'vitest'

import { createEventBannerPresenter } from '../../src/overlay/banner.js'
import type { BannerLayout, EventBannerPresenter } from '../../src/overlay/banner.js'
import {
  InvalidOverlayConfigurationError,
  InvalidOverlayEventError,
  OverlayDestroyedError,
} from '../../src/overlay/index.js'
import { FakeBannerSurface } from '../fixtures/fake-banner-surface.js'
import { FakeClock } from '../fixtures/fake-clock.js'

const LAYOUT: BannerLayout = {
  width: 720,
  height: 140,
  textTop: 57,
  textLeft: 94,
  maxTextWidth: 510,
  fontSizes: [28, 26, 24, 22],
  fontFamily: 'system-ui',
}

function createPresenter(
  surface: FakeBannerSurface,
  overrides: Partial<Parameters<typeof createEventBannerPresenter>[0]> = {},
): EventBannerPresenter {
  return createEventBannerPresenter({
    surface,
    layout: LAYOUT,
    clock: new FakeClock(),
    reducedMotion: true,
    ...overrides,
  })
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

describe('event banner presenter', () => {
  it('evicts the oldest banner once the active bound is reached', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface, { maxActiveBanners: 2 })

    presenter.present({ text: 'first' }, 'compact')
    presenter.present({ text: 'second' }, 'compact')
    presenter.present({ text: 'third' }, 'compact')

    expect(presenter.activeCount()).toBe(2)
    presenter.destroy()
    expect(presenter.activeCount()).toBe(0)
  })

  it('mounts nothing at all for a suppressed presentation', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface)

    const handle = presenter.present({ text: 'hidden' }, 'suppressed')

    expect(presenter.activeCount()).toBe(0)
    expect(surface.mountedRoots()).toHaveLength(0)
    expect(() => handle.destroy()).not.toThrow()
    presenter.destroy()
  })

  it('renders a compact banner without an asset error when no asset key is given', () => {
    const surface = new FakeBannerSurface()
    const onAssetError = vi.fn()
    const presenter = createPresenter(surface, { onAssetError })

    presenter.present({ text: 'plain' }, 'full')

    expect(onAssetError).not.toHaveBeenCalled()
    expect(surface.lastRoot().findByKind('image')).toBeNull()
    presenter.destroy()
  })

  it('falls back to compact and reports a typed error when the resolver fails', () => {
    const surface = new FakeBannerSurface()
    const onAssetError = vi.fn()
    const presenter = createPresenter(surface, {
      assetResolver: { resolve: (): string | null => null },
      onAssetError,
    })

    presenter.present({ text: 'with art', assetKey: 'banner-artwork' }, 'full')

    expect(onAssetError).toHaveBeenCalledTimes(1)
    expect(presenter.activeCount()).toBe(1)
    presenter.destroy()
  })

  it('downgrades an already mounted banner in place when the image fails to load', () => {
    const surface = new FakeBannerSurface()
    const onAssetError = vi.fn()
    const presenter = createPresenter(surface, {
      assetResolver: { resolve: (): string => 'https://assets.example/banner.png' },
      onAssetError,
    })

    presenter.present({ text: 'with art', assetKey: 'banner-artwork' }, 'full')
    const image = surface.lastRoot().findByKind('image')
    expect(image).not.toBeNull()
    const activeBefore = presenter.activeCount()

    image?.triggerLoadError()

    expect(onAssetError).toHaveBeenCalledTimes(1)
    expect(presenter.activeCount()).toBe(activeBefore)
    presenter.destroy()
  })

  it('writes upstream text through the text channel only', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface)
    const hostile = '<img src=x onerror=alert(1)>'

    presenter.present({ text: hostile }, 'compact')

    const root = surface.lastRoot()
    expect(surface.textOf(root).text).toContain(hostile)
    for (const element of [root, ...root.descendants()]) {
      expect([...element.styles.values()].join(' ')).not.toContain('<img')
      // Accessibility labels legitimately mirror the text; nothing else may carry it.
      const leaked = [...element.attributes.entries()].filter(
        ([name, value]) => value.includes(hostile) && name !== 'aria-label' && name !== 'title',
      )
      expect(leaked).toEqual([])
    }
    presenter.destroy()
  })

  it('walks the font ladder down before truncating', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface, {
      assetResolver: { resolve: (): string => 'https://assets.example/banner.png' },
    })

    presenter.present({ text: '一'.repeat(40), assetKey: 'banner-artwork' }, 'full')

    const tried = surface.measurements.map((entry) => entry.fontSize)
    expect(tried[0]).toBe(28)
    expect(tried.length).toBeGreaterThan(1)
    expect(tried.at(-1)).toBeLessThan(28)
    presenter.destroy()
  })

  it('rejects invalid layouts and content instead of degrading silently', () => {
    const surface = new FakeBannerSurface()

    expect(() => createPresenter(surface, { layout: { ...LAYOUT, fontSizes: [22, 26] } })).toThrow(
      InvalidOverlayConfigurationError,
    )
    expect(() => createPresenter(surface, { layout: { ...LAYOUT, width: 0 } })).toThrow(
      InvalidOverlayConfigurationError,
    )

    const presenter = createPresenter(surface)
    expect(() => presenter.present({ text: '   ' }, 'compact')).toThrow(InvalidOverlayEventError)
    presenter.destroy()
  })

  it('releases a single banner through its handle without touching the others', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface, { maxActiveBanners: 4 })

    const first = presenter.present({ text: 'first' }, 'compact')
    presenter.present({ text: 'second' }, 'compact')
    expect(presenter.activeCount()).toBe(2)

    first.destroy()
    first.destroy()

    expect(presenter.activeCount()).toBe(1)
    presenter.destroy()
  })

  it('places the full banner with the caller layout geometry', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface, {
      assetResolver: { resolve: (): string => 'https://assets.example/banner.png' },
    })

    presenter.present({ text: 'geometry', assetKey: 'banner-artwork' }, 'full')

    const root = surface.lastRoot()
    expect(root.styles.get('width')).toBe('min(92%, 720px)')
    expect(root.styles.get('aspect-ratio')).toBe('720 / 140')
    expect(root.styles.get('bottom')).toBe('12%')
    const text = surface.textOf(root)
    expect(text.styles.get('top')).toBe(`${String(round((57 / 140) * 100))}%`)
    expect(text.styles.get('left')).toBe(`${String(round((94 / 720) * 100))}%`)
    expect(text.styles.get('width')).toBe(`${String(round((510 / 720) * 100))}%`)
    presenter.destroy()
  })

  it('runs the entry animation on a frame and skips it under reduced motion', () => {
    const clock = new FakeClock()
    const animated = new FakeBannerSurface()
    const presenter = createPresenter(animated, { clock, reducedMotion: false })

    presenter.present({ text: 'moving' }, 'compact')
    const root = animated.lastRoot()
    expect(root.styles.get('opacity')).toBe('0')
    expect(root.styles.get('transform')).toBe('translate(-50%, 10px)')

    clock.advanceBy(16)
    expect(root.styles.get('opacity')).toBe('1')
    expect(root.styles.get('transform')).toBe('translate(-50%, 0)')
    presenter.destroy()

    const still = new FakeBannerSurface()
    const quiet = createPresenter(still)
    quiet.present({ text: 'static' }, 'compact')
    expect(still.lastRoot().styles.has('opacity')).toBe(false)
    expect(still.lastRoot().styles.has('transition')).toBe(false)
    quiet.destroy()
  })

  it('cancels pending frames and removes every node on destroy', () => {
    const clock = new FakeClock()
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface, { clock, reducedMotion: false })

    presenter.present({ text: 'first' }, 'compact')
    presenter.present({ text: 'second' }, 'compact')
    expect(clock.pendingTaskCount()).toBeGreaterThan(0)

    presenter.destroy()

    expect(clock.pendingTaskCount()).toBe(0)
    expect(surface.mountedRoots()).toHaveLength(0)
  })

  it('reports an asset error when the resolver throws or is missing', () => {
    const throwing = new FakeBannerSurface()
    const onThrowError = vi.fn()
    const thrower = createPresenter(throwing, {
      assetResolver: {
        resolve(): string {
          throw new Error('resolver exploded')
        },
      },
      onAssetError: onThrowError,
    })
    thrower.present({ text: 'art', assetKey: 'banner-artwork' }, 'full')
    expect(onThrowError).toHaveBeenCalledTimes(1)
    expect(throwing.lastRoot().findByKind('image')).toBeNull()
    thrower.destroy()

    const missing = new FakeBannerSurface()
    const onMissingError = vi.fn()
    const bare = createPresenter(missing, { onAssetError: onMissingError })
    bare.present({ text: 'art', assetKey: 'banner-artwork' }, 'full')
    expect(onMissingError).toHaveBeenCalledTimes(1)
    expect(missing.lastRoot().findByKind('image')).toBeNull()
    bare.destroy()
  })

  it('refuses to present after destroy and stays idempotent', () => {
    const surface = new FakeBannerSurface()
    const presenter = createPresenter(surface)

    presenter.present({ text: 'live' }, 'compact')
    presenter.destroy()
    presenter.destroy()

    expect(() => presenter.present({ text: 'late' }, 'compact')).toThrow(OverlayDestroyedError)
  })
})
