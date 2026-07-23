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

test('renders structured messages and event cards as safe text, then releases every node', async ({
  page,
}) => {
  await page.goto(origin)
  await expect(page.locator('#fixture')).toHaveAttribute('data-ready', 'true')

  const message = page.locator('.liveflow-danmaku__message')
  await expect(message).toHaveCount(1)
  await expect(message.locator('.liveflow-danmaku__identity')).toHaveCount(2)
  await expect(message.locator('.liveflow-danmaku__sender')).toHaveText('viewer')
  await expect(message.locator('.liveflow-danmaku__text')).toHaveText(
    '<img src=x onerror=alert(1)>',
  )
  await expect(message.locator('img')).toHaveCount(0)
  await expect(message.locator('.liveflow-danmaku__text')).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(page.locator('.liveflow-danmaku')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('.liveflow-danmaku')).toHaveAttribute('data-reduced-motion', 'true')
  const overlayCard = page.locator('[data-liveflow-overlay-card]')
  await expect(overlayCard).toHaveCount(1)
  await expect(overlayCard).toContainText('<script>window.compromised=true</script>')
  await expect(overlayCard.locator('script')).toHaveCount(0)
  await expect(overlayCard.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false)
  await expect(page.locator('#identity-failure')).toHaveAttribute('data-cleanups', '1')
  await expect(page.locator('#identity-failure .liveflow-danmaku__message')).toHaveCount(0)

  await page.getByRole('button', { name: 'destroy' }).click()

  await expect(page.locator('.liveflow-danmaku')).toHaveCount(0)
  await expect(page.locator('[data-liveflow-overlay-card]')).toHaveCount(0)
})

const fixtureHtml = `<!doctype html>
<html>
  <body style="margin:0;background:#000">
    <div id="fixture" style="position:relative;width:640px;height:120px"></div>
    <div id="identity-failure" style="position:relative;width:320px;height:80px"></div>
    <div id="overlay"></div>
    <button id="destroy">destroy</button>
    <script type="module">
      import { createDomDanmakuRenderer } from '/danmaku/renderers/index.js'
      import { createOverlayEngine } from '/overlay/index.js'

      const container = document.querySelector('#fixture')
      const renderer = createDomDanmakuRenderer({
        container,
        maxPoolSize: 2,
        reducedMotion: true,
        backgroundColor: '#000000',
      })
      renderer.resize({ width: 640, height: 120 })
      const message = {
        id: 'synthetic-message',
        receivedAt: 0,
        text: '<img src=x onerror=alert(1)>',
        mode: 'scroll',
        priority: 0,
        color: '#111111',
        sender: { displayName: 'viewer' },
        identities: [
          { kind: 'fan-badge', label: 'Badge', level: 8 },
          { kind: 'user-level', label: 'Level', level: 16 },
        ],
      }
      renderer.render({
        timestamp: 0,
        mounts: [{
          message,
          lane: 0,
          x: 640,
          y: 0,
          width: 300,
          height: 24,
        }],
        updates: [{ id: message.id, x: 620, y: 0 }],
        unmounts: [],
      })
      const overlay = createOverlayEngine({
        contractVersion: 1,
        instanceId: 'browser-safe-dom',
        container: document.querySelector('#overlay'),
        assetResolver: {
          resolve() {
            return 'javascript:window.compromised=true'
          },
        },
      })
      overlay.submit({
        id: 'synthetic-event',
        kind: 'milestone',
        receivedAt: performance.now(),
        priority: 80,
        durationMs: 30_000,
        nodes: [{
          type: 'text',
          role: 'message',
          text: '<script>window.compromised=true<\\/script>',
        }, {
          type: 'asset',
          role: 'badge',
          assetKey: 'unsafe-scheme',
          alt: 'unsafe asset',
        }],
      })
      const failureContainer = document.querySelector('#identity-failure')
      let identityCleanups = 0
      const failureRenderer = createDomDanmakuRenderer({
        container: failureContainer,
        reducedMotion: true,
        identityRenderer: {
          render(identity, identityContainer) {
            if (identity.label === 'throw') {
              throw new Error('synthetic identity failure')
            }
            const label = document.createElement('span')
            label.textContent = identity.label
            identityContainer.append(label)
            return {
              destroy() {
                identityCleanups += 1
                label.remove()
              },
            }
          },
        },
      })
      try {
        failureRenderer.render({
          timestamp: 0,
          mounts: [{
            message: {
              id: 'failing-message',
              receivedAt: 0,
              text: 'body',
              mode: 'scroll',
              priority: 0,
              identities: [
                { kind: 'first', label: 'created' },
                { kind: 'second', label: 'throw' },
              ],
            },
            lane: 0,
            x: 320,
            y: 0,
            width: 120,
            height: 24,
          }],
          updates: [],
          unmounts: [],
        })
      } catch {
        failureContainer.dataset.cleanups = String(identityCleanups)
      }
      failureRenderer.destroy()
      container.dataset.ready = 'true'
      document.querySelector('#destroy').addEventListener('click', () => {
        renderer.destroy()
        overlay.destroy()
      }, { once: true })
    </script>
  </body>
</html>`
