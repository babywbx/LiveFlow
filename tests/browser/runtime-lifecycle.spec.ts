import { expect, test } from '@playwright/test'

import { type DistServer, startDistServer } from './dist-server.js'

let server: DistServer

test.beforeAll(async () => {
  server = await startDistServer(fixtureHtml)
})

test.afterAll(async () => {
  await server.close()
})

test('preserves one engine across resize, pause, resume and container moves', async ({ page }) => {
  await page.goto(server.origin)

  await page.getByRole('button', { name: 'mount' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveCount(1)
  await expect(page.locator('.liveflow-danmaku')).toHaveAttribute('data-instance', 'stable')

  await page.getByRole('button', { name: 'resize' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveCSS('width', '320px')
  await expect(page.locator('.liveflow-danmaku')).toHaveCSS('height', '96px')

  await page.getByRole('button', { name: 'pause' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveAttribute('data-paused', 'true')
  await page.getByRole('button', { name: 'resume' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveAttribute('data-paused', 'false')

  await page.getByRole('button', { name: 'move' }).click()
  await expect(page.locator('#second .liveflow-danmaku')).toHaveCount(1)
  await expect(page.locator('.liveflow-danmaku')).toHaveAttribute('data-instance', 'stable')

  await page.getByRole('button', { name: 'destroy' }).click()
  await page.getByRole('button', { name: 'destroy' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveCount(0)

  await page.getByRole('button', { name: 'mount' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveCount(1)
  await page.getByRole('button', { name: 'destroy' }).click()
  await expect(page.locator('.liveflow-danmaku')).toHaveCount(0)
})

test('keeps four and nine real DOM instances within shared budgets', async ({ page }) => {
  await page.goto(server.origin)

  await page.getByRole('button', { name: 'profile 4' }).click()
  await expect(page.locator('#fixture')).toHaveAttribute('data-profile-complete', '4')
  await expect(page.locator('#fixture')).toHaveAttribute('data-bounded', 'true')
  await expect(page.locator('#fixture')).toHaveAttribute('data-released', 'true')

  await page.getByRole('button', { name: 'profile 9' }).click()
  await expect(page.locator('#fixture')).toHaveAttribute('data-profile-complete', '9')
  await expect(page.locator('#fixture')).toHaveAttribute('data-bounded', 'true')
  await expect(page.locator('#fixture')).toHaveAttribute('data-released', 'true')
})

const fixtureHtml = `<!doctype html>
<html>
  <body>
    <div id="fixture">
      <div id="first"></div>
      <div id="second"></div>
      <div id="profiles"></div>
    </div>
    <button id="mount">mount</button>
    <button id="resize">resize</button>
    <button id="pause">pause</button>
    <button id="resume">resume</button>
    <button id="move">move</button>
    <button id="destroy">destroy</button>
    <button id="profile-4">profile 4</button>
    <button id="profile-9">profile 9</button>
    <script type="module">
      import { CONTRACT_VERSION } from '/index.js'
      import { createDanmakuEngine } from '/danmaku/index.js'
      import { createDomDanmakuRenderer } from '/danmaku/renderers/index.js'
      import { createOverlayBudgetCoordinator, createOverlayEngine } from '/overlay/index.js'

      const fixture = document.querySelector('#fixture')
      const first = document.querySelector('#first')
      const second = document.querySelector('#second')
      const profiles = document.querySelector('#profiles')
      let host = null
      let engine = null

      document.querySelector('#mount').addEventListener('click', () => {
        if (engine !== null) {
          return
        }
        host = document.createElement('div')
        host.style.position = 'relative'
        host.style.width = '640px'
        host.style.height = '160px'
        first.append(host)
        const renderer = createDomDanmakuRenderer({
          container: host,
          maxPoolSize: 24,
          reducedMotion: true,
        })
        engine = createDanmakuEngine({
          contractVersion: CONTRACT_VERSION,
          renderer,
          viewport: { width: 640, height: 160 },
          limits: {
            maxPending: 32,
            maxVisible: 16,
            maxPoolSize: 24,
          },
        })
        host.querySelector('.liveflow-danmaku').dataset.instance = 'stable'
        engine.push({
          id: 'lifecycle-message',
          receivedAt: performance.now(),
          text: 'lifecycle',
          mode: 'top',
          priority: 1,
        })
      })

      document.querySelector('#resize').addEventListener('click', () => {
        engine?.resize({ width: 320, height: 96 })
      })
      document.querySelector('#pause').addEventListener('click', () => {
        engine?.pause()
      })
      document.querySelector('#resume').addEventListener('click', () => {
        engine?.resume()
      })
      document.querySelector('#move').addEventListener('click', () => {
        if (host !== null) {
          second.append(host)
        }
      })
      document.querySelector('#destroy').addEventListener('click', () => {
        engine?.destroy()
        engine = null
        host?.remove()
        host = null
      })
      document.querySelector('#profile-4').addEventListener('click', () => {
        void runProfile(4)
      })
      document.querySelector('#profile-9').addEventListener('click', () => {
        void runProfile(9)
      })

      async function runProfile(instanceCount) {
        fixture.dataset.profileComplete = ''
        fixture.dataset.bounded = 'false'
        fixture.dataset.released = 'false'
        profiles.replaceChildren()
        const coordinator = createOverlayBudgetCoordinator({
          maxInstances: instanceCount,
          maxActiveCards: 3,
          maxFullCards: 1,
          maxHighCostAnimations: 1,
        })
        const resources = []
        for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
          const shell = document.createElement('section')
          const danmakuHost = document.createElement('div')
          danmakuHost.style.position = 'relative'
          danmakuHost.style.width = '480px'
          danmakuHost.style.height = '128px'
          const overlayHost = document.createElement('div')
          shell.append(danmakuHost, overlayHost)
          profiles.append(shell)
          const renderer = createDomDanmakuRenderer({
            container: danmakuHost,
            maxPoolSize: 24,
          })
          const danmaku = createDanmakuEngine({
            contractVersion: CONTRACT_VERSION,
            renderer,
            viewport: { width: 480, height: 128 },
            limits: {
              maxPending: 32,
              maxVisible: 16,
              maxPoolSize: 24,
              maxIntakePerSecond: 64,
              maxDisplayPerSecond: 32,
            },
          })
          const overlay = createOverlayEngine({
            contractVersion: CONTRACT_VERSION,
            instanceId: 'browser-profile-' + String(instanceCount) + '-' + String(instanceIndex),
            instanceState: {
              weight: instanceCount - instanceIndex,
              focused: instanceIndex === 0,
              visible: true,
            },
            coordinator,
            container: overlayHost,
            limits: {
              maxPending: 8,
              maxVisible: 1,
            },
          })
          resources.push({ danmaku, overlay, danmakuHost })
          for (let messageIndex = 0; messageIndex < 160; messageIndex += 1) {
            danmaku.push({
              id: 'd-' + String(instanceIndex) + '-' + String(messageIndex),
              receivedAt: performance.now(),
              text: 'bounded message ' + String(messageIndex),
              mode: messageIndex % 9 === 0 ? 'top' : 'scroll',
              priority: messageIndex % 11 === 0 ? 90 : 10,
            })
          }
          for (let eventIndex = 0; eventIndex < 12; eventIndex += 1) {
            overlay.submit({
              id: 'o-' + String(instanceIndex) + '-' + String(eventIndex),
              kind: 'milestone',
              receivedAt: performance.now(),
              priority: eventIndex === 0 ? 90 : 10,
              durationMs: 10_000,
              nodes: [{
                type: 'text',
                role: 'message',
                text: 'bounded overlay',
              }],
            })
          }
        }

        await new Promise((resolve) => {
          setTimeout(resolve, 250)
        })
        const budget = coordinator.getMetrics()
        const bounded = resources.every(({ danmaku, overlay, danmakuHost }) => {
          const danmakuMetrics = danmaku.getMetrics()
          const overlayMetrics = overlay.getMetrics()
          return danmakuMetrics.pendingDepth <= 32
            && danmakuMetrics.visible <= 16
            && overlayMetrics.pendingDepth <= 8
            && overlayMetrics.visible <= 1
            && danmakuHost.querySelectorAll('.liveflow-danmaku__message').length <= 16
        })
          && budget.registeredInstances <= instanceCount
          && budget.activeCards <= 3
          && budget.activeFull <= 1
          && budget.activeHighCost <= 1

        for (const resource of resources) {
          resource.danmaku.destroy()
          resource.overlay.destroy()
        }
        coordinator.destroy()
        const releasedBudget = coordinator.getMetrics()
        const released = profiles.querySelectorAll('.liveflow-danmaku').length === 0
          && profiles.querySelectorAll('[data-liveflow-overlay-card]').length === 0
          && releasedBudget.registeredInstances === 0
          && releasedBudget.activeCards === 0
        profiles.replaceChildren()
        fixture.dataset.bounded = String(bounded)
        fixture.dataset.released = String(released)
        fixture.dataset.profileComplete = String(instanceCount)
      }
    </script>
  </body>
</html>`
