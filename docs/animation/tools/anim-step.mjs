// Ouvre l'étape <étape> de l'animation <nom> et exécute une action : node anim-step.mjs <scratch> <pid> <nom> <étape> [shot|cotracker-run|bones-validate|lbs-compute|lbs-validate|compute|click:<texte>]
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright-core/index.mjs'
import { readFileSync } from 'node:fs'
const [S, pid, name, step, action = 'shot'] = process.argv.slice(2)
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a)
const custom = readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/custom-token.txt`, 'utf8').trim(); const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.picopop-keys/admin-test/fbconfig.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/Users/nicolasrocher/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 } }); const p = await ctx.newPage()
p.on('pageerror', e => log('PAGEERROR', e.message.slice(0, 200)))
p.on('console', m => { if (m.type() === 'error' && !/firebasestorage.*404/.test(m.text())) log('CONSOLE', m.text().slice(0, 240)) })
p.on('dialog', async d => { log('DIALOG', d.type(), d.message().replace(/\n/g, ' | ').slice(0, 160)); await d.accept() })
const tag = `${step.replace(/[^a-z0-9]/gi, '')}-${action.replace(/[^a-z0-9]/gi, '').slice(0, 40)}`
await p.goto('https://coloriage-anime-admin.vercel.app/login', { waitUntil: 'domcontentloaded' })
await p.evaluate(async ({ cfg, custom }) => {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js')
  const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js')
  await signInWithCustomToken(getAuth(initializeApp(cfg)), custom)
}, { cfg, custom })
await p.waitForTimeout(800)
await p.goto(`https://coloriage-anime-admin.vercel.app/admin/${pid}`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => /Animations/.test(document.body.innerText) && !/Chargement/.test(document.body.innerText), null, { timeout: 60000 }); await p.waitForTimeout(500)
await p.getByText('Animations', { exact: true }).first().click({ timeout: 15000 }); await p.locator('button', { hasText: 'Éditer' }).first().waitFor({ timeout: 30000 })
const card = p.getByText(name, { exact: true }).first().locator('xpath=ancestor::*[.//button[contains(., "Éditer")]][1]')
await card.locator('button', { hasText: 'Éditer' }).first().click(); await p.locator('nav.pipeline-stepper').waitFor({ timeout: 30000 }); await p.waitForTimeout(500)
const stepBtn = (lbl) => p.locator('nav.pipeline-stepper button.pipeline-step', { has: p.locator('.pipeline-step-label', { hasText: new RegExp('^' + lbl + '$') }) }).first()
await stepBtn(step).click({ timeout: 10000, noWaitAfter: true }); await p.waitForTimeout(2500)
const busyGone = async (re, ms = 1800000) => p.waitForFunction((src) => !new RegExp(src).test(document.body.innerText), re, { timeout: ms })
for (const act of action.split(';')) {
  const t0 = Date.now()
  if (act.startsWith('cotracker-run')) {   // cotracker-run[:<regex du bouton>] (défaut : toutes les frames)
    const btnRe = act.includes(':') ? new RegExp(act.slice(act.indexOf(':') + 1)) : /Lancer CoTracker3|Recalculer — toutes les frames/
    const btn = p.getByRole('button', { name: btnRe }).first()
    log('bouton :', await btn.innerText().catch(() => '?'), 'désactivé :', await btn.isDisabled().catch(() => 'n/a'))
    await btn.click(); await p.waitForTimeout(5000)
    // fin = bouton « Recalculer — toutes les frames » actif ; journal de la phase toutes les 15 s ; arrêt sur message d'erreur
    for (let k = 0; k < 60; k++) {
      const st = await p.evaluate(() => { const bs = [...document.querySelectorAll('button')]; const b = bs.find(x => /Recalculer — toutes les frames/.test(x.innerText)); const busy = bs.filter(x => x.disabled && /CoTracker|Tracking|%|…/.test(x.innerText)).map(x => x.innerText.trim()); const err = (document.body.innerText.match(/(Erreur|Error|échec|failed|timeout)[^\n]{0,160}/i) || [])[0]; return { done: !!b && !b.disabled, busy, err } })
      log('phase', JSON.stringify(st.busy).slice(0, 120), st.err ? '| ERREUR : ' + st.err : '')
      if (st.done) break
      if (st.err) throw new Error('CoTracker : ' + st.err)
      await p.waitForTimeout(15000)
    }
    await p.waitForTimeout(3000); log('CoTracker terminé en', Math.round((Date.now() - t0) / 1000), 's')
  } else if (/^click(#\d+)?:/.test(act)) {
    const m = act.match(/^click(?:#(\d+))?:(.*)$/); const label = m[2]; const nth = m[1] ? parseInt(m[1]) - 1 : 0
    const btn = p.getByRole('button', { name: new RegExp(label) }).nth(nth)
    log('clic sur', JSON.stringify(await btn.innerText().catch(() => '?')), 'désactivé :', await btn.isDisabled().catch(() => 'n/a'))
    await btn.click(); await p.waitForTimeout(1200)
    await p.waitForFunction(() => ![...document.querySelectorAll('button')].some(x => /Calcul…|Calcul\.\.\.|Sauvegarde\.\.\.|^…$|en cours/.test(x.innerText)), null, { timeout: 300000 })
    await p.waitForTimeout(1200); log('terminé en', Math.round((Date.now() - t0) / 1000), 's')
  } else if (act.startsWith('wait:')) { await p.waitForTimeout(parseInt(act.slice(5))) }
  else if (act.startsWith('step:')) {   // changement d'étape SANS recharger (l'app garde ses calculs en mémoire)
    const lbl = act.slice(5); await stepBtn(lbl).click({ timeout: 10000, noWaitAfter: true }); await p.waitForTimeout(2500); log('étape', lbl)
  }
  else if (act.startsWith('shots:')) {   // shots:N:ms — N captures du canvas de preview espacées de ms
    const [, n, ms] = act.split(':'); const cv = p.locator('canvas').first()
    for (let k = 0; k < parseInt(n); k++) { await cv.screenshot({ path: `${S}/anim-${tag}-s${k}.png` }); await p.waitForTimeout(parseInt(ms)) }
    log('captures série :', n)
  }
  else if (act.startsWith('expect:')) {
    const re = act.slice(7)
    try { await p.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re, { timeout: 45000 }); log('attendu trouvé :', re) }
    catch { const t = await p.innerText('body'); const i = t.search(/Erreur|erreur|doit|sans barycentre|introuvable/); log('ATTENDU ABSENT :', re, '| contexte :', i >= 0 ? t.slice(Math.max(0, i - 80), i + 200).replace(/\n+/g, ' | ') : '(aucun message)') }
  }
}
const txt = await p.innerText('body'); const i = txt.indexOf(step); log('TEXTE', txt.slice(Math.max(0, i), i + 900).replace(/\n+/g, ' | '))
await p.screenshot({ path: `${S}/anim-${tag}.png`, fullPage: true }); log('capture', `anim-${tag}.png`)
await b.close()
