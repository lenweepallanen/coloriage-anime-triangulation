// Duplique un projet depuis la HomePage de l'admin (logique de l'app : Firestore + Storage) et affiche l'id de la copie.
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
import { readFileSync } from 'node:fs'
const S = process.argv[2]; const srcName = process.argv[3]
const custom = readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/custom-token.txt`, 'utf8').trim(); const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/fbconfig.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1200 } }); const p = await ctx.newPage()
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
p.on('dialog', async d => { console.log('DIALOG', d.message().slice(0, 120)); await d.accept() })
await p.goto('https://coloriage-anime-admin.vercel.app/login', { waitUntil: 'domcontentloaded' })
await p.evaluate(async ({ cfg, custom }) => {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js')
  const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js')
  await signInWithCustomToken(getAuth(initializeApp(cfg)), custom)
}, { cfg, custom })
await p.waitForTimeout(1500)
await p.goto('https://coloriage-anime-admin.vercel.app/', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !/Chargement/.test(document.body.innerText), null, { timeout: 90000 }); await p.waitForTimeout(3000)
const before = await p.getByText(`${srcName} (copie)`, { exact: true }).count()
if (before > 0) { console.log('une copie existe déjà — abandon'); await b.close(); process.exit(2) }
const title = p.getByText(srcName, { exact: true }).first()
if (await title.count() === 0) { console.log('projet source introuvable sur la HomePage'); await p.screenshot({ path: `${S}/home-dup.png` }); await b.close(); process.exit(1) }
// la carte = ancêtre le plus proche contenant un bouton « Dupliquer »
const card = title.locator('xpath=ancestor::*[.//button[@title="Dupliquer"]][1]')
await card.locator('button[title="Dupliquer"]').first().click()
console.log('duplication lancée…')
await p.getByText(`${srcName} (copie)`, { exact: true }).first().waitFor({ timeout: 120000 })
await p.waitForTimeout(2000)
await p.getByText(`${srcName} (copie)`, { exact: true }).first().click(); await p.waitForTimeout(4000)
console.log('NOUVEL_ID', p.url().split('/admin/')[1]?.split(/[/?#]/)[0] ?? '(url inattendue : ' + p.url() + ')')
await b.close()
