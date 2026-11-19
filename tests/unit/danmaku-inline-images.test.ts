import { describe, expect, it } from 'vitest'

import {
  createInlineImageRenderer,
  EMOJI_PATTERN,
  type InlineImage,
  type InlineImageRendererOptions,
} from '../../src/danmaku/inline-images.js'
import { InvalidDanmakuConfigurationError } from '../../src/danmaku/index.js'

interface FakeImage {
  className: string
  alt: string
  decoding: string
  draggable: boolean
  src: string
  readonly style: Record<string, string>
  readonly listeners: Map<string, () => void>
  addEventListener(type: string, listener: () => void): void
}

interface Fixture {
  readonly container: HTMLElement
  readonly nodes: (string | FakeImage)[]
}

function isContainer(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && 'ownerDocument' in value
}

function createFixture(prefersReducedMotion = false): Fixture {
  const nodes: (string | FakeImage)[] = []
  const document = {
    baseURI: 'https://example.test/live/',
    defaultView: {
      matchMedia: (): { matches: boolean } => ({ matches: prefersReducedMotion }),
    },
    createElement(): FakeImage {
      return {
        className: '',
        alt: '',
        decoding: '',
        draggable: true,
        src: '',
        style: {},
        listeners: new Map(),
        addEventListener(type, listener): void {
          this.listeners.set(type, listener)
        },
      }
    },
  }
  const container = {
    ownerDocument: document,
    append(...children: (string | FakeImage)[]): void {
      nodes.push(...children)
    },
  }
  if (!isContainer(container)) throw new Error('invalid fixture')
  return { container, nodes }
}

const IMAGES: Readonly<Record<string, InlineImage>> = {
  '[smile]': { src: '/emotes/smile.png', aspectRatio: 9 / 8 },
  '[wave]': { src: 'https://cdn.example.test/wave.gif', stillSrc: '/emotes/wave.png', alt: 'wave' },
}

function renderer(overrides: Partial<InlineImageRendererOptions> = {}): {
  render(text: string, fixture?: Fixture): (string | FakeImage)[]
  readonly errors: string[]
} {
  const errors: string[] = []
  const textRenderer = createInlineImageRenderer({
    pattern: /\[\w+\]/gu,
    resolve: (token) => IMAGES[token] ?? null,
    onError: (token) => errors.push(token),
    ...overrides,
  })
  return {
    errors,
    render(text, fixture = createFixture()) {
      textRenderer.render(text, fixture.container)
      return fixture.nodes
    },
  }
}

function sources(nodes: readonly (string | FakeImage)[]): string[] {
  return nodes.map((node) => (typeof node === 'string' ? node : `<${node.src}>`))
}

describe('inline image text renderer', () => {
  it('rejects patterns that are not global and invalid image caps', () => {
    expect(() => renderer({ pattern: /\[\w+\]/u })).toThrow(InvalidDanmakuConfigurationError)
    for (const maxImagesPerMessage of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderer({ maxImagesPerMessage })).toThrow(InvalidDanmakuConfigurationError)
    }
  })

  it('replaces resolved tokens in order and keeps everything else as text', () => {
    const { render, errors } = renderer()

    expect(sources(render('hi[smile]there[nope][wave]!'))).toEqual([
      'hi',
      '<https://example.test/emotes/smile.png>',
      'there[nope]',
      '<https://cdn.example.test/wave.gif>',
      '!',
    ])
    expect(sources(render('[smile][smile]'))).toEqual([
      '<https://example.test/emotes/smile.png>',
      '<https://example.test/emotes/smile.png>',
    ])
    expect(render('plain text 😀')).toEqual(['plain text 😀'])
    expect(errors).toEqual([])
  })

  it('sizes images from the font size and their aspect ratio before they load', () => {
    const [smile, wave] = renderer()
      .render('[smile][wave]')
      .filter((node) => typeof node !== 'string')

    expect(smile).toMatchObject({
      className: 'liveflow-danmaku__image',
      alt: '[smile]',
      decoding: 'async',
      draggable: false,
      style: {
        display: 'inline-block',
        width: `calc(var(--liveflow-danmaku-image-size, 1.2em) * ${String(9 / 8)})`,
        objectFit: 'contain',
        height: 'var(--liveflow-danmaku-image-size, 1.2em)',
        verticalAlign:
          'var(--liveflow-danmaku-image-align, calc(0.35em - var(--liveflow-danmaku-image-size, 1.2em) / 2))',
      },
    })
    expect(wave).toMatchObject({
      alt: 'wave',
      style: { width: 'calc(var(--liveflow-danmaku-image-size, 1.2em) * 1)' },
    })
  })

  it('leaves unsafe or failing images as text and reports the token', () => {
    const { render, errors } = renderer({
      resolve(token) {
        if (token === '[script]') return { src: 'file:///etc/passwd' }
        if (token === '[flat]') return { src: '/flat.png', aspectRatio: 0 }
        if (token === '[huge]') return { src: '/huge.png', aspectRatio: Number.POSITIVE_INFINITY }
        throw new Error('resolver failed')
      },
    })

    expect(render('[script][flat][huge][boom]')).toEqual(['[script][flat][huge][boom]'])
    expect(errors).toEqual(['[script]', '[flat]', '[huge]', '[boom]'])
  })

  it('isolates failures thrown by the error callback', () => {
    const { render } = renderer({
      resolve: () => ({ src: 'data:image/png;base64,AA==' }),
      onError() {
        throw new Error('callback failed')
      },
    })

    expect(render('[smile]')).toEqual(['[smile]'])
  })

  it('stops resolving once a message reaches its image cap', () => {
    const resolved: string[] = []
    const { render } = renderer({
      maxImagesPerMessage: 2,
      resolve(token) {
        resolved.push(token)
        return IMAGES['[smile]'] ?? null
      },
    })

    expect(sources(render('[a][b][c][d]'))).toEqual([
      '<https://example.test/emotes/smile.png>',
      '<https://example.test/emotes/smile.png>',
      '[c][d]',
    ])
    expect(resolved).toEqual(['[a]', '[b]'])
  })

  it('ignores empty matches', () => {
    const { render } = renderer({ pattern: /x*/gu })

    expect(render('abc')).toEqual(['abc'])
  })

  it('uses still images when motion is reduced', () => {
    expect(sources(renderer({ reducedMotion: true }).render('[wave][smile]'))).toEqual([
      '<https://example.test/emotes/wave.png>',
      '<https://example.test/emotes/smile.png>',
    ])
    expect(sources(renderer().render('[wave]', createFixture(true)))).toEqual([
      '<https://example.test/emotes/wave.png>',
    ])
    expect(
      sources(renderer({ reducedMotion: false }).render('[wave]', createFixture(true))),
    ).toEqual(['<https://cdn.example.test/wave.gif>'])
  })

  it('hides an image that fails to load without changing its box', () => {
    const { render, errors } = renderer()
    const [image] = render('[smile]')
    if (image === undefined || typeof image === 'string') throw new Error('missing image')

    image.listeners.get('error')?.()

    expect(image.style.visibility).toBe('hidden')
    expect(image.style.height).toBe('var(--liveflow-danmaku-image-size, 1.2em)')
    expect(errors).toEqual(['[smile]'])
  })
})

describe('emoji pattern', () => {
  it('matches whole emoji sequences one token at a time', () => {
    const tokens = (text: string): string[] => [...text.matchAll(EMOJI_PATTERN)].map((m) => m[0])

    expect(tokens('a👍🏽b👨‍👩‍👧c🇨🇳d1️⃣e❤️f😂😂')).toEqual(['👍🏽', '👨‍👩‍👧', '🇨🇳', '1️⃣', '❤️', '😂', '😂'])
    expect(tokens('plain 123 text，中文')).toEqual([])
  })
})
