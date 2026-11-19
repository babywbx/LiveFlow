import { expect, test } from '@playwright/test'

import { type DistServer, startDistServer } from './dist-server.js'

let server: DistServer
let origin = ''

test.beforeAll(async () => {
  server = await startDistServer(fixtureHtml)
  origin = server.origin
})

test.afterAll(async () => {
  await server.close()
})

interface InlineImageResults {
  readonly plainWidth: number
  readonly imageWidth: number
  readonly missingWidth: number
  readonly mountedWidth: number
  readonly loadedImage: { readonly width: number; readonly height: number }
  readonly missingImage: { readonly width: number; readonly visibility: string }
  readonly unknownText: string
  readonly oneLineHeight: number
  readonly wrappedHeight: number
}

function isResults(value: unknown): value is InlineImageResults {
  return typeof value === 'object' && value !== null && 'plainWidth' in value
}

test('measures inline images from their declared size and keeps that box after loading', async ({
  page,
}) => {
  await page.goto(origin)
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true')
  const results: unknown = JSON.parse(
    (await page.locator('body').getAttribute('data-results')) ?? '',
  )
  if (!isResults(results)) throw new Error('missing results')

  const imageBox = 20 * 1.2
  expect(results.imageWidth - results.plainWidth).toBeCloseTo(imageBox * (9 / 8), 0)
  expect(results.missingWidth - results.plainWidth).toBeCloseTo(imageBox * 2, 0)
  expect(results.mountedWidth).toBeCloseTo(results.imageWidth, 0)
  expect(results.loadedImage.width).toBeCloseTo(imageBox * (9 / 8), 0)
  expect(results.loadedImage.height).toBeCloseTo(imageBox, 0)
  expect(results.missingImage).toEqual({
    width: expect.closeTo(imageBox * 2, 0),
    visibility: 'hidden',
  })
  expect(results.unknownText).toBe('ab[unknown]')
  expect(results.wrappedHeight).toBeGreaterThan(results.oneLineHeight * 1.5)
})

const fixtureHtml = `<!doctype html>
<html>
  <body style="margin:0;background:#000;color:#fff">
    <div id="lanes" style="position:relative;width:640px;height:120px;font:20px/1.5 sans-serif"></div>
    <div id="stack" style="position:relative;width:120px;height:240px;font:20px/1.5 sans-serif"></div>
    <script type="module">
      import { createDomDanmakuRenderer } from '/danmaku/renderers/index.js'
      import { createInlineImageRenderer } from '/danmaku/inline-images.js'

      const canvas = document.createElement('canvas')
      canvas.width = 90
      canvas.height = 80
      canvas.getContext('2d').fillRect(0, 0, 90, 80)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      const blobUrl = URL.createObjectURL(blob)
      const textRenderer = createInlineImageRenderer({
        pattern: /\\[\\w+\\]/g,
        reducedMotion: true,
        resolve(token) {
          if (token === '[ok]') return { src: blobUrl, aspectRatio: 9 / 8 }
          if (token === '[missing]') return { src: '/missing.png', aspectRatio: 2 }
          return null
        },
      })
      const message = (id, text) => ({ id, receivedAt: 0, text, mode: 'scroll', priority: 0 })
      const width = (renderer, text) => renderer.measure([message(text, text)])[0].width
      const height = (renderer, text) => renderer.measure([message(text, text)])[0].height

      const lanes = createDomDanmakuRenderer({
        container: document.querySelector('#lanes'),
        reducedMotion: true,
        textRenderer,
      })
      const plainWidth = width(lanes, 'ab')
      const imageWidth = width(lanes, 'ab[ok]')
      const missingWidth = width(lanes, 'ab[missing]')
      const mounts = ['ab[ok]', 'ab[missing]', 'ab[unknown]'].map((text, lane) => ({
        message: message(text, text),
        lane,
        x: 0,
        y: lane * 30,
        width: 1,
        height: 30,
      }))
      lanes.render({ timestamp: 0, mounts, updates: [], unmounts: [] })
      const [okNode, missingNode, unknownNode] = [
        ...document.querySelectorAll('#lanes .liveflow-danmaku__message'),
      ].filter((node) => node.textContent !== '')
      const loaded = okNode.querySelector('img')
      await loaded.decode()
      const missing = missingNode.querySelector('img')
      if (missing.style.visibility !== 'hidden') {
        await new Promise((resolve) => missing.addEventListener('error', resolve, { once: true }))
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const loadedBox = loaded.getBoundingClientRect()

      const stack = createDomDanmakuRenderer({
        container: document.querySelector('#stack'),
        layout: 'stack',
        reducedMotion: true,
        textRenderer,
      })
      stack.resize({ width: 120, height: 240 })

      document.body.dataset.results = JSON.stringify({
        plainWidth,
        imageWidth,
        missingWidth,
        mountedWidth: okNode.getBoundingClientRect().width,
        loadedImage: { width: loadedBox.width, height: loadedBox.height },
        missingImage: {
          width: missing.getBoundingClientRect().width,
          visibility: missing.style.visibility,
        },
        unknownText: unknownNode.textContent,
        oneLineHeight: height(stack, 'a[ok]'),
        wrappedHeight: height(stack, '[ok][ok][ok][ok][ok][ok][ok][ok]'),
      })
      document.body.dataset.ready = 'true'
    </script>
  </body>
</html>`
