// Ouvre l'étape <étape> de l'animation <nom> et exécute une action : node anim-step.mjs <scratch> <pid> <nom> <étape> [shot|cotracker-run|bones-validate|lbs-compute|lbs-validate|compute|click:<texte>]
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
import { readFileSync } from 'node:fs'
const [S, pid, name, step, action = 'shot'] = process.argv.slice(2)
const custom = readFileSync(`${S}/custom-token.txt`, 'utf8').trim(); const cfg = JSON.parse(readFileSync(`${S}/fbconfig.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 } }); const p = await ctx.newPage()
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
p.on('console', m => { if (m.type() === 'error' && !/firebasestorage.*404/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 240)) })
p.on('dialog', async d => { console.log('DIALOG', d.type(), d.message().replace(/\n/g, ' | ').slice(0, 160)); await d.accept() })
const tag = `${step.replace(/[^a-z0-9]/gi, '')}-${action.replace(/[^a-z0-9]/gi, '')}`
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
await card.locator('button', { hasText: 'Éditer' }).first().click(); await p.waitForTimeout(4000)
await p.getByText(step, { exact: true }).last().click({ timeout: 10000 }); await p.waitForTimeout(8000)
const busyGone = async (re, ms = 1800000) => p.waitForFunction((src) => !new RegExp(src).test(document.body.innerText), re, { timeout: ms })
for (const act of action.split(';')) {
  const t0 = Date.now()
  if (act === 'cotracker-run') {
    const btn = p.getByRole('button', { name: /Lancer CoTracker3|Recalculer — toutes les frames/ }).first()
    console.log('bouton :', await btn.innerText().catch(() => '?'), 'désactivé :', await btn.isDisabled().catch(() => 'n/a'))
    await btn.click(); await p.waitForTimeout(5000)
    // fin = le bouton redevient « Recalculer — toutes les frames » et plus aucun bouton désactivé n'affiche une phase
    await p.waitForFunction(() => { const bs = [...document.querySelectorAll('button')]; const b = bs.find(x => /Recalculer — toutes les frames/.test(x.innerText)); return !!b && !b.disabled }, null, { timeout: 1800000 })
    await p.waitForTimeout(4000); console.log('CoTracker terminé en', Math.round((Date.now() - t0) / 1000), 's')
  } else if (/^click(#\d+)?:/.test(act)) {
    const m = act.match(/^click(?:#(\d+))?:(.*)$/); const label = m[2]; const nth = m[1] ? parseInt(m[1]) - 1 : 0
    const btn = p.getByRole('button', { name: new RegExp(label) }).nth(nth)
    console.log('clic sur', JSON.stringify(await btn.innerText().catch(() => '?')), 'désactivé :', await btn.isDisabled().catch(() => 'n/a'))
    await btn.click(); await p.waitForTimeout(3000)
    await p.waitForFunction(() => ![...document.querySelectorAll('button')].some(x => /Calcul…|Calcul\.\.\.|Sauvegarde\.\.\.|^…$|en cours/.test(x.innerText)), null, { timeout: 1800000 })
    await p.waitForTimeout(3000); console.log('terminé en', Math.round((Date.now() - t0) / 1000), 's')
  } else if (act.startsWith('wait:')) { await p.waitForTimeout(parseInt(act.slice(5))) }
  else if (act.startsWith('shots:')) {   // shots:N:ms — N captures du canvas de preview espacées de ms
    const [, n, ms] = act.split(':'); const cv = p.locator('canvas').first()
    for (let k = 0; k < parseInt(n); k++) { await cv.screenshot({ path: `${S}/anim-${tag}-s${k}.png` }); await p.waitForTimeout(parseInt(ms)) }
    console.log('captures série :', n)
  }
  else if (act.startsWith('expect:')) {
    const re = act.slice(7)
    try { await p.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re, { timeout: 180000 }); console.log('attendu trouvé :', re) }
    catch { const t = await p.innerText('body'); const i = t.search(/Erreur|erreur|doit|sans barycentre|introuvable/); console.log('ATTENDU ABSENT :', re, '| contexte :', i >= 0 ? t.slice(Math.max(0, i - 80), i + 200).replace(/\n+/g, ' | ') : '(aucun message)') }
  }
}
const txt = await p.innerText('body'); const i = txt.indexOf(step); console.log('TEXTE', txt.slice(Math.max(0, i), i + 900).replace(/\n+/g, ' | '))
await p.screenshot({ path: `${S}/anim-${tag}.png`, fullPage: true }); console.log('capture', `anim-${tag}.png`)
await b.close()
