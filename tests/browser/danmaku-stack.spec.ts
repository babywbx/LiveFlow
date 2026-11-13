import { expect, test } from '@playwright/test'

import { type DistServer, startDistServer } from './dist-server.js'

const STACK_GAP = 4

let server: DistServer
let origin = ''

test.beforeAll(async () => {
  server = await startDistServer(fixtureHtml)
  origin = server.origin
})

test.afterAll(async () => {
  await server.close()
})

interface RowBox {
  readonly top: number
  readonly bottom: number
  readonly right: number
  readonly height: number
}

test('stacks wrapped rows from the bottom edge without overlap and drops rows that leave', async ({
  page,
}) => {
  await page.goto(origin)
  const fixture = page.locator('#fixture')
  await expect(fixture).toHaveAttribute('data-ready', 'true')

  const rows = fixture.locator('.liveflow-danmaku__message:not([aria-hidden])')
  await expect(rows).toHaveCount(3)
  await expect(fixture).toHaveAttribute('data-settled', 'true')

  const frame = await fixture.boundingBox()
  if (frame === null) throw new Error('fixture is not visible')
  const boxes = await rows.evaluateAll((nodes): RowBox[] =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, right: rect.right, height: rect.height }
    }),
  )
  const [short, long, last] = boxes
  if (short === undefined || long === undefined || last === undefined) {
    throw new Error('expected three rows')
  }
  expect(long.height).toBeGreaterThan(short.height * 1.5)
  expect(long.right).toBeLessThanOrEqual(frame.x + frame.width + 0.5)
  expect(long.top).toBeGreaterThanOrEqual(short.bottom - 0.5)
  expect(last.top).toBeGreaterThanOrEqual(long.bottom - 0.5)
  expect(Math.abs(last.bottom - (frame.y + frame.height))).toBeLessThanOrEqual(1)

  const sender = rows.nth(2).locator('.liveflow-danmaku__sender')
  await expect(sender).toHaveText('viewer')
  await expect(sender).toHaveCSS('color', 'rgb(255, 76, 102)')
  await expect(rows.nth(2).locator('img.liveflow-danmaku__avatar')).toHaveAttribute('src', /^blob:/)

  await page.getByRole('button', { name: 'flood' }).click()
  await expect(fixture).toHaveAttribute('data-flooded', 'true')
  await expect(rows.last()).toContainText('flood 11')
  await expect.poll(async () => rows.count()).toBeLessThan(10)
  const tops = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().bottom),
  )
  for (const bottom of tops) expect(bottom).toBeGreaterThan(frame.y - STACK_GAP - 0.5)

  await expect(page.locator('#reduced')).toHaveAttribute('data-offset', '0')
})

const fixtureHtml = `<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; background: #000; font: 16px/20px sans-serif; }
      .box { position: relative; width: 240px; height: 120px; }
      .liveflow-danmaku__avatar { width: 20px; height: 20px; vertical-align: top; }
    </style>
  </head>
  <body>
    <div id="fixture" class="box"></div>
    <div id="reduced" class="box"></div>
    <button id="flood">flood</button>
    <script type="module">
      import { createDanmakuEngine } from '/danmaku/index.js'
      import { createDomDanmakuRenderer } from '/danmaku/renderers/index.js'
      import { CONTRACT_VERSION } from '/overlay/index.js'

      const avatar = URL.createObjectURL(
        new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], {
          type: 'image/svg+xml',
        }),
      )
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const message = (id, text, sender) => ({
        id,
        receivedAt: performance.now(),
        text,
        mode: 'scroll',
        priority: 0,
        ...(sender === undefined ? {} : { sender }),
      })
      const create = (container, reducedMotion) =>
        createDanmakuEngine({
          contractVersion: CONTRACT_VERSION,
          layout: 'stack',
          viewport: { width: 240, height: 120 },
          policy: { stackGap: ${String(STACK_GAP)}, stackGlideMs: 200 },
          renderer: createDomDanmakuRenderer({
            container,
            layout: 'stack',
            reducedMotion,
            backgroundColor: '#000000',
            assetResolver: { resolve: () => avatar },
          }),
        })

      const fixture = document.querySelector('#fixture')
      const engine = create(fixture, false)
      engine.push(message('short', 'short row'))
      engine.push(message('long', 'a long synthetic row that has to wrap onto another line here'))
      engine.push(
        message('last', 'last row', { displayName: 'viewer', color: '#ff4c66', avatarKey: 'a' }),
      )
      fixture.dataset.ready = 'true'
      setTimeout(() => {
        fixture.dataset.settled = 'true'
      }, 600)

      document.querySelector('#flood').addEventListener('click', async () => {
        for (let index = 0; index < 12; index += 1) {
          engine.push(message('flood-' + String(index), 'flood ' + String(index)))
          await nextFrame()
        }
        fixture.dataset.flooded = 'true'
      }, { once: true })

      const reduced = document.querySelector('#reduced')
      const still = create(reduced, true)
      still.push(message('still', 'reduced motion row'))
      await nextFrame()
      await nextFrame()
      const row = reduced.querySelector('.liveflow-danmaku__message:not([aria-hidden])')
      const offset = row === null
        ? Number.NaN
        : reduced.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom
      reduced.dataset.offset = String(Math.round(offset))
    </script>
  </body>
</html>`
