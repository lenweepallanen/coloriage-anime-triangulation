import { fileURLToPath } from 'node:url'
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
const S = fileURLToPath(new URL('.', import.meta.url)); const [img, seeds, inflate, white, closing = '0'] = process.argv.slice(2)
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } })
p.on('console', m => console.log('P>', m.type(), m.text().slice(0, 200)))
p.on('worker', w => w.on('console', m => console.log('W>', m.text().slice(0, 200))))
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.goto(`http://127.0.0.1:8777/harness-canny.html?img=${img}&seeds=${seeds}&inflate=${inflate}&white=${white || 0}&closing=${closing}`)
await p.waitForFunction(() => window.__done === true, null, { timeout: 90000 })
console.log(JSON.stringify(await p.evaluate(() => window.__result)))
await p.locator('#c').screenshot({ path: `${S}out/canny-${img}-i${inflate}-w${white || 0}-c${closing}.png` }); await b.close()
