import { expect, test } from '@playwright/test'

import { type DistServer, startDistServer } from './dist-server.js'

let server: DistServer

test.beforeAll(async () => {
  server = await startDistServer(fixtureHtml)
})

test.afterAll(async () => {
  await server.close()
})

test('stages a hidden native candidate and removes only adapter-owned nodes', async ({ page }) => {
  await page.goto(server.origin)

  await page.getByRole('button', { name: 'prepare' }).click()
  await expect(page.locator('#fixture')).toHaveAttribute('data-prepared', 'true')
  await expect(page.locator('#fixture video')).toHaveCount(2)
  await expect(page.locator('#fixture video').nth(1)).toBeHidden()

  await page.getByRole('button', { name: 'discard' }).click()
  await expect(page.locator('#fixture')).toHaveAttribute('data-discarded', 'true')
  await expect(page.locator('#fixture video')).toHaveCount(1)

  await page.getByRole('button', { name: 'destroy' }).click()
  await expect(page.locator('#fixture')).toHaveAttribute('data-destroyed', 'true')
  await expect(page.locator('#fixture video')).toHaveCount(1)
  await expect(page.locator('#initial')).not.toHaveAttribute('src')

  await page.getByRole('button', { name: 'destroy' }).click()
  await expect(page.locator('#fixture video')).toHaveCount(1)
})

const fixtureHtml = `<!doctype html>
<html>
  <body>
    <div id="fixture">
      <video id="initial" class="live-surface" controls playsinline></video>
    </div>
    <button id="prepare">prepare</button>
    <button id="discard">discard</button>
    <button id="destroy">destroy</button>
    <script type="module">
      import { createNativeVideoAdapter } from '/adapters/native-video.js'

      const fixture = document.querySelector('#fixture')
      const initial = document.querySelector('#initial')
      const adapter = createNativeVideoAdapter({ video: initial })
      let prepared = null

      document.querySelector('#prepare').addEventListener('click', async () => {
        prepared = await adapter.prepare({
          url: 'data:video/mp4;base64,',
          kind: 'synthetic',
        }, 1)
        fixture.dataset.prepared = 'true'
      })
      document.querySelector('#discard').addEventListener('click', async () => {
        if (prepared !== null) {
          await adapter.discard(prepared)
        }
        fixture.dataset.discarded = 'true'
      })
      document.querySelector('#destroy').addEventListener('click', async () => {
        await adapter.destroy()
        fixture.dataset.destroyed = 'true'
      })
    </script>
  </body>
</html>`
