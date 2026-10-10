// Crée un coloriage dans l'admin, envoie l'image du coloriage (Paramètres) et l'image de référence (Triangulation, étape 1).
// node project-create.mjs <dossier sorties> <nom> <png>
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
import { readFileSync } from 'node:fs'
const [S, name, png] = process.argv.slice(2)
const custom = readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/custom-token.txt`, 'utf8').trim(); const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/fbconfig.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 } }); const p = await ctx.newPage()
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
p.on('dialog', async d => { console.log('DIALOG', d.type(), d.message().slice(0, 80)); await d.accept(name) })
await p.goto('https://coloriage-anime-admin.vercel.app/login', { waitUntil: 'domcontentloaded' })
await p.evaluate(async ({ cfg, custom }) => {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js')
  const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js')
  await signInWithCustomToken(getAuth(initializeApp(cfg)), custom)
}, { cfg, custom })
await p.waitForTimeout(800)
await p.goto('https://coloriage-anime-admin.vercel.app/', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !/Chargement/.test(document.body.innerText), null, { timeout: 90000 }); await p.waitForTimeout(1000)
const input = p.locator('input[type=text]').filter({ has: p.locator('xpath=.') }).first()
const inputs = await p.locator('input[type=text], input:not([type])').all(); console.log('champs texte :', inputs.length)
let target = null
for (const i of inputs) { const ph = (await i.getAttribute('placeholder')) || ''; console.log('  placeholder', JSON.stringify(ph)); if (/coloriage|nom|projet/i.test(ph)) target = i }
if (!target) target = inputs[0]
await target.fill(name)
await p.getByRole('button', { name: /Créer un coloriage/ }).first().click()
await p.waitForTimeout(5000)
console.log('URL après création :', p.url())
if (!/\/admin\//.test(p.url())) { await p.getByText(name, { exact: true }).first().click({ timeout: 15000 }); await p.waitForTimeout(4000); console.log('URL projet :', p.url()) }
const pid = p.url().split('/admin/')[1]?.split(/[/?#]/)[0]; console.log('PROJECT_ID', pid)
// image du coloriage (Paramètres → section import)
await p.getByText('Paramètres', { exact: true }).first().click({ timeout: 10000 }); await p.waitForTimeout(2000)
const fi = p.locator('input[type=file][accept="image/png,image/jpeg"]').first(); console.log('champ image coloriage :', await fi.count())
await fi.setInputFiles(png); await p.waitForTimeout(12000)
// image de référence (Triangulation, étape 1)
await p.getByText('Triangulation', { exact: true }).first().click({ timeout: 10000 }); await p.waitForTimeout(3000)
const fr = p.locator('input[type=file][accept="image/png,image/jpeg"]').first(); console.log('champ image référence :', await fr.count())
await fr.setInputFiles(png); await p.waitForFunction(() => /Image importée/.test(document.body.innerText), null, { timeout: 120000 }); await p.waitForTimeout(3000)
await p.screenshot({ path: `${S}/project-create.png` }); console.log('fait')
await b.close()
