import { fileURLToPath } from 'node:url'
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
import { writeFileSync } from 'node:fs'
const S = fileURLToPath(new URL('.', import.meta.url))
const names = process.argv.slice(2)
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
for (const name of names) {
  const p = await b.newPage({ viewport: { width: 1024, height: 1024 } })
  p.on('console', m => { if (/error|Worker auto-zones/i.test(m.text())) console.log('CONSOLE', m.text().slice(0, 300)) })
  await p.goto(`http://127.0.0.1:8777/harness.html?img=${encodeURIComponent(name)}`)
  await p.waitForFunction(() => window.__done === true, null, { timeout: 180000 })
  const r = await p.evaluate(() => window.__result)
  console.log(name, JSON.stringify(r))
  const raw = await p.evaluate(() => window.__raw)
  if (raw) writeFileSync(`${S}out/${name}.json`, JSON.stringify(raw))
  await p.locator('#c').screenshot({ path: `${S}out/${name}.png` })
  await p.close()
}
await b.close()
