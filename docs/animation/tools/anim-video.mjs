// Ouvre l'animation <nom> (Éditer), passe en Loop, envoie la vidéo à l'étape Vidéo : node anim-video.mjs <scratch> <pid> <nom> <mp4>
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
import { readFileSync } from 'node:fs'
const [S, pid, name, mp4, mode] = process.argv.slice(2)
const custom = readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/custom-token.txt`, 'utf8').trim(); const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/fbconfig.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 } }); const p = await ctx.newPage()
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
p.on('console', m => { if (m.type() === 'error' && !/firebasestorage.*404/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 240)) })
p.on('dialog', async d => { console.log('DIALOG', d.type(), d.message().slice(0, 80)); await d.accept() })
await p.goto('https://coloriage-anime-admin.vercel.app/login', { waitUntil: 'domcontentloaded' })
await p.evaluate(async ({ cfg, custom }) => {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js')
  const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js')
  await signInWithCustomToken(getAuth(initializeApp(cfg)), custom)
}, { cfg, custom })
await p.waitForTimeout(1500)
await p.goto(`https://coloriage-anime-admin.vercel.app/admin/${pid}`, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000)
await p.getByText('Animations', { exact: true }).first().click({ timeout: 15000 }); await p.waitForTimeout(3000)
const card = p.getByText(name, { exact: true }).first().locator('xpath=ancestor::*[.//button[contains(., "Éditer")]][1]')
if (mode !== 'noloop' && await card.locator('button', { hasText: '→ Loop' }).count()) { await card.locator('button', { hasText: '→ Loop' }).first().click(); await p.waitForTimeout(4000); console.log('mode Loop activé') }
await card.locator('button', { hasText: 'Éditer' }).first().click(); await p.waitForTimeout(4000)
console.log('TEXTE', (await p.innerText('body')).replace(/\n+/g, ' | ').slice(0, 500))
const input = p.locator('input[type=file][accept="video/mp4,video/webm"]').first()
console.log('champ vidéo :', await input.count())
if (await input.count()) {
  await input.setInputFiles(mp4)
  await p.waitForFunction(() => /Vidéo : OK/.test(document.body.innerText), null, { timeout: 240000 })
  await p.waitForTimeout(4000); console.log('vidéo envoyée')
}
await p.screenshot({ path: `${S}/anim-3.png` })
await b.close()
