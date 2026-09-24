// Joue le film complet d'un projet dans l'app play (caméra simulée) et récupère la vidéo
// ENREGISTRÉE par l'app elle-même (canvas + bus audio → MediaRecorder → IndexedDB).
// Usage : PROJECT=<id> CAM=<y4m> OUT=<fichier> node e2e-record.mjs
import { chromium } from '/Users/nicolasrocher/.royalties-tools/node_modules/playwright/index.mjs'
import { writeFileSync } from 'node:fs'
const here = '/private/tmp/claude-501/-Users-nicolasrocher-Documents-claude-code-projects-PicoPop/ec4ef121-9ce2-4ef4-b6b1-c5271048de6d/scratchpad/proto'
const PROJECT = process.env.PROJECT, CAM = process.env.CAM || `${here}/cam-scene.y4m`, OUT = process.env.OUT
const WAIT = +(process.env.WAIT || 95000)
const t0 = Date.now(); const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a)
const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`, '--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] })
const page = await ctx.newPage()
page.on('pageerror', e => { if (!/Maximum call stack/.test(e.message)) log('PAGEERROR', e.message) })
await page.goto(`https://localhost:5175/p/${PROJECT}?autocam=1`, { waitUntil: 'domcontentloaded' })
const stage = () => page.evaluate(() => document.body.dataset.scanStage ?? null)
async function waitStage(target, timeout) { const s0 = Date.now(); while (Date.now() - s0 < timeout) { if (await stage() === target) return true; await page.waitForTimeout(250) } return false }
await waitStage('camera', 15000)
if (!await waitStage('processing', 12000)) { await page.locator('button.btn-capture').first().click().catch(() => {}); await waitStage('processing', 8000) }
await waitStage('preview', 90000)
const go = page.locator('button', { hasText: /voir|see/i }).first()
await go.click({ timeout: 120000, force: true })
await waitStage('animation', 20000)
log('film démarré')
// échantillons de la sonde pour le journal des plans
const samples = []
const iv = setInterval(() => { page.evaluate(() => window.__filmDebug ? { ...window.__filmDebug, now: performance.now() } : null).then(d => { if (d) samples.push(d) }).catch(() => {}) }, 200)
await page.waitForTimeout(WAIT)
clearInterval(iv)
log('fin d\'attente, stage =', await stage(), 'url =', await page.evaluate(() => location.pathname))
// plan → intervalle de temps film
const plans = {}
for (const d of samples) { if (!d.started) continue; const k = d.planIndex; plans[k] = plans[k] || { from: d.tMs, to: d.tMs, phases: new Set() }; plans[k].to = d.tMs; plans[k].phases.add(d.phase) }
log('plans observés :', Object.entries(plans).map(([k, v]) => `p${k} ${(v.from / 1000).toFixed(1)}→${(v.to / 1000).toFixed(1)}s [${[...v.phases].join(',')}]`).join(' | '))
// récupération de la vidéo enregistrée
const rec = await page.evaluate(async (pid) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('picopop-film-videos', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const row = await new Promise((res, rej) => { const tx = db.transaction('videos', 'readonly'); const g = tx.objectStore('videos').get(pid); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error) })
  if (!row) return null
  const buf = new Uint8Array(await row.blob.arrayBuffer())
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  return { mimeType: row.mimeType, durationMs: row.durationMs, size: buf.length, b64: btoa(s) }
}, PROJECT).catch(e => ({ error: String(e) }))
if (rec && rec.b64) { writeFileSync(OUT, Buffer.from(rec.b64, 'base64')); log(`vidéo enregistrée : ${rec.mimeType} ${(rec.size / 1048576).toFixed(1)} Mo, ${(rec.durationMs / 1000).toFixed(1)} s → ${OUT}`) }
else log('pas de vidéo enregistrée :', JSON.stringify(rec))
await browser.close()
process.exit(0)
