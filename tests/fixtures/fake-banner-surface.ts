import type {
  BannerElement,
  BannerElementKind,
  BannerFont,
  BannerImageElement,
  BannerSurface,
} from '../../src/overlay/banner.js'

export type FakeBannerElementKind = BannerElementKind | 'image'

export class FakeBannerElement implements BannerImageElement {
  readonly kind: FakeBannerElementKind
  readonly attributes = new Map<string, string>()
  readonly styles = new Map<string, string>()
  readonly children: FakeBannerElement[] = []
  parent: FakeBannerElement | null = null
  text: string | null = null
  source: string | null = null
  mounted = false
  removed = false
  removeCallCount = 0
  private loadErrorBindingFailures = 0
  private removeFailures = 0
  private readonly loadErrorListeners: (() => void)[] = []

  constructor(kind: FakeBannerElementKind) {
    this.kind = kind
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  setStyle(property: string, value: string): void {
    this.styles.set(property, value)
  }

  setText(text: string): void {
    this.text = text
  }

  append(child: BannerElement): void {
    if (!(child instanceof FakeBannerElement)) {
      throw new Error('foreign banner element')
    }
    child.parent = this
    this.children.push(child)
  }

  remove(): void {
    this.removeCallCount += 1
    if (this.removeFailures > 0) {
      this.removeFailures -= 1
      throw new Error('banner removal failed')
    }
    this.removed = true
    this.loadErrorListeners.length = 0
    const parent = this.parent
    if (parent !== null) {
      const index = parent.children.indexOf(this)
      if (index >= 0) {
        parent.children.splice(index, 1)
      }
      this.parent = null
    }
  }

  isMounted(): boolean {
    if (this.removed) {
      return false
    }
    return this.parent === null ? this.mounted : this.parent.isMounted()
  }

  setSource(url: string): void {
    this.source = url
  }

  onLoadError(listener: () => void): void {
    if (this.loadErrorBindingFailures > 0) {
      this.loadErrorBindingFailures -= 1
      throw new Error('banner load error binding failed')
    }
    this.loadErrorListeners.push(listener)
  }

  triggerLoadError(): void {
    for (const listener of this.loadErrorListeners.splice(0)) {
      listener()
    }
  }

  failNextRemove(): void {
    this.removeFailures += 1
  }

  failNextLoadErrorBinding(): void {
    this.loadErrorBindingFailures += 1
  }

  descendants(): FakeBannerElement[] {
    const collected: FakeBannerElement[] = []
    for (const child of this.children) {
      collected.push(child, ...child.descendants())
    }
    return collected
  }

  findByKind(kind: FakeBannerElementKind): FakeBannerElement | null {
    return this.descendants().find((element) => element.kind === kind) ?? null
  }
}

export interface FakeBannerSurfaceOptions {
  readonly baseUrl?: string
  readonly widthPerFontUnit?: number
}

export class FakeBannerSurface implements BannerSurface {
  readonly baseUrl: string
  readonly images: FakeBannerElement[] = []
  readonly roots: FakeBannerElement[] = []
  readonly measurements: { text: string; fontSize: number; font: BannerFont }[] = []
  private readonly widthPerFontUnit: number
  private nextImageLoadErrorBindingFailures = 0
  private nextImageRemoveFailures = 0

  constructor(options: FakeBannerSurfaceOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://example.test/watch/'
    this.widthPerFontUnit = options.widthPerFontUnit ?? 0.5
  }

  createElement(kind: BannerElementKind): BannerElement {
    return new FakeBannerElement(kind)
  }

  createImage(): BannerImageElement {
    const image = new FakeBannerElement('image')
    if (this.nextImageLoadErrorBindingFailures > 0) {
      this.nextImageLoadErrorBindingFailures -= 1
      image.failNextLoadErrorBinding()
    }
    if (this.nextImageRemoveFailures > 0) {
      this.nextImageRemoveFailures -= 1
      image.failNextRemove()
    }
    this.images.push(image)
    return image
  }

  failNextCreatedImageLoadErrorBinding(): void {
    this.nextImageLoadErrorBindingFailures += 1
  }

  failNextCreatedImageRemove(): void {
    this.nextImageRemoveFailures += 1
  }

  mount(element: BannerElement): void {
    if (!(element instanceof FakeBannerElement)) {
      throw new Error('foreign banner element')
    }
    element.mounted = true
    this.roots.push(element)
  }

  measureText(text: string, fontSize: number, font: BannerFont): number {
    this.measurements.push({ text, fontSize, font })
    return text.length * fontSize * this.widthPerFontUnit
  }

  mountedRoots(): FakeBannerElement[] {
    return this.roots.filter((root) => !root.removed)
  }

  lastRoot(): FakeBannerElement {
    const root = this.roots[this.roots.length - 1]
    if (root === undefined) {
      throw new Error('no banner was mounted')
    }
    return root
  }

  textOf(root: FakeBannerElement): FakeBannerElement {
    const text = root.findByKind('text')
    if (text === null) {
      throw new Error('banner has no text element')
    }
    return text
  }
}
