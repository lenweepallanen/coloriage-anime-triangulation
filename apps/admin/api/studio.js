/**
 * GET /api/studio?days=7|30|0 — chiffres du dashboard « PicoPop Studio » (admin uniquement).
 *
 * Sécurité : l'admin envoie son jeton Firebase (`Authorization: Bearer <idToken>`). Le jeton est vérifié ici
 * (signature RS256 contre les certificats publics Google, audience/émetteur/expiration), puis l'appartenance à
 * l'allowlist `admins/{uid}` est contrôlée en lisant le document Firestore AVEC ce même jeton (les règles
 * n'autorisent cette lecture qu'aux admins). Aucun compte de service Firebase n'est nécessaire.
 *
 * Sources (clés dans les variables d'environnement Vercel du projet admin, jamais dans le code) :
 *   - Brevo        BREVO_API_KEY, BREVO_LIST_ID          → leads par jour, événements des mails 1/2/3
 *   - Apple        ASC_ISSUER_ID, ASC_SALES_KEY_ID, ASC_SALES_KEY_P8, ASC_VENDOR_NUMBER → rapports de ventes (téléchargements)
 *   - Google Play  PLAY_SA_JSON, PLAY_STATS_BUCKET, PLAY_PACKAGE → CSV d'installations du bucket de la console
 *   - Firestore    `siteClicks` (clics /go du site), lus avec le jeton de l'admin
 *
 * Cache mémoire par instance : 10 min pour l'agrégat, et définitif pour les rapports Apple/Google des jours passés.
 * Les sources indisponibles renvoient `null` + un message dans `errors` : le dashboard reste utilisable.
 */
import { createPublicKey, createPrivateKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const FIREBASE_PROJECT = 'picopop-app'
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/coloriages/documents`
const APPLE_APP_ID = '6800906467'
const LAUNCH_DAY = '2026-08-20' // début de l'historique « Tout »
const ALLOWED_ORIGINS = [/^https:\/\/coloriage-anime-admin\.vercel\.app$/, /^https:\/\/localhost(:\d+)?$/, /^https:\/\/192\.168\.\d+\.\d+(:\d+)?$/]

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const dayStr = (d) => d.toISOString().slice(0, 10)
const addDays = (day, n) => dayStr(new Date(Date.parse(day) + n * 86400000))

// ---------------------------------------------------------------------------------------------------------------
// 1. Authentification
// ---------------------------------------------------------------------------------------------------------------
let googleCerts = { exp: 0, keys: {} }
async function getGoogleCerts() {
  if (Date.now() < googleCerts.exp) return googleCerts.keys
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com')
  const keys = await r.json()
  const maxAge = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '')
  googleCerts = { exp: Date.now() + (maxAge ? +maxAge[1] * 1000 : 3600000), keys }
  return keys
}

async function verifyIdToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('jeton malformé')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  if (header.alg !== 'RS256') throw new Error('algorithme inattendu')
  const certs = await getGoogleCerts()
  const cert = certs[header.kid]
  if (!cert) throw new Error('certificat inconnu')
  const ok = cryptoVerify('sha256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey(cert), Buffer.from(parts[2], 'base64url'))
  if (!ok) throw new Error('signature invalide')
  const now = Math.floor(Date.now() / 1000)
  if (payload.aud !== FIREBASE_PROJECT || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT}`) throw new Error('émetteur inattendu')
  if (!(payload.exp > now) || !(payload.iat <= now + 60) || !payload.sub) throw new Error('jeton expiré')
  return payload.sub
}

async function isAdmin(uid, token) {
  const r = await fetch(`${FIRESTORE}/admins/${encodeURIComponent(uid)}`, { headers: { Authorization: `Bearer ${token}` } })
  return r.status === 200
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Brevo
// ---------------------------------------------------------------------------------------------------------------
async function brevo(path) {
  const r = await fetch('https://api.brevo.com/v3' + path, { headers: { 'api-key': process.env.BREVO_API_KEY, Accept: 'application/json' } })
  if (!r.ok) throw new Error(`Brevo ${r.status} sur ${path}`)
  return r.json()
}

async function brevoLeads() {
  const listId = process.env.BREVO_LIST_ID
  const byDay = {}, bySource = {}
  let offset = 0, total = 0
  for (;;) {
    const d = await brevo(`/contacts/lists/${listId}/contacts?limit=500&offset=${offset}`)
    for (const c of d.contacts || []) {
      const day = String(c.createdAt || '').slice(0, 10)
      byDay[day] = (byDay[day] || 0) + 1
      const src = (c.attributes && c.attributes.SOURCE) || 'inconnu'
      bySource[src] = (bySource[src] || 0) + 1
    }
    total = d.count || 0
    offset += 500
    if (offset >= total || !(d.contacts || []).length) break
  }
  return { total, byDay, bySource }
}

async function brevoEmails(from, to) {
  const tags = ['email-1', 'email-2', 'email-3']
  const out = []
  for (const tag of tags) {
    const uniq = { requests: new Set(), delivered: new Set(), opened: new Set(), clicks: new Set(), hardBounces: new Set(), unsubscribed: new Set() }
    let offset = 0
    for (;;) {
      const d = await brevo(`/smtp/statistics/events?limit=2500&offset=${offset}&startDate=${from}&endDate=${to}&tags=${tag}`)
      const evs = d.events || []
      for (const e of evs) if (uniq[e.event]) uniq[e.event].add(e.email)
      if (evs.length < 2500) break
      offset += 2500
    }
    out.push({ tag, sent: uniq.requests.size, delivered: uniq.delivered.size, opened: uniq.opened.size, clicked: uniq.clicks.size, bounced: uniq.hardBounces.size, unsubscribed: uniq.unsubscribed.size })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Apple — rapports de ventes quotidiens (téléchargements = lignes de type 1*)
// ---------------------------------------------------------------------------------------------------------------
let appleToken = { exp: 0, value: '' }
function appleJwt() {
  const now = Math.floor(Date.now() / 1000)
  if (now < appleToken.exp - 60) return appleToken.value
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_SALES_KEY_ID, typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }))
  const key = createPrivateKey(process.env.ASC_SALES_KEY_P8.replace(/\\n/g, '\n'))
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' })
  appleToken = { exp: now + 15 * 60, value: `${header}.${payload}.${b64url(sig)}` }
  return appleToken.value
}

const appleDayCache = new Map() // day → { units, byCountry } (jours passés : définitif)
async function appleDay(day) {
  if (appleDayCache.has(day)) return appleDayCache.get(day)
  const q = new URLSearchParams({ 'filter[frequency]': 'DAILY', 'filter[reportSubType]': 'SUMMARY', 'filter[reportType]': 'SALES', 'filter[vendorNumber]': process.env.ASC_VENDOR_NUMBER, 'filter[reportDate]': day })
  const r = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${q}`, { headers: { Authorization: `Bearer ${appleJwt()}`, Accept: 'application/a-gzip' } })
  let res = { units: 0, byCountry: {} }
  if (r.status === 200) {
    const txt = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')
    const lines = txt.trim().split('\n'); const hdr = lines[0].split('\t')
    for (const l of lines.slice(1)) {
      const row = Object.fromEntries(hdr.map((h, i) => [h, l.split('\t')[i]]))
      if (row['Apple Identifier'] !== APPLE_APP_ID || !String(row['Product Type Identifier'] || '').startsWith('1')) continue
      const u = parseInt(row.Units, 10) || 0
      res.units += u; res.byCountry[row['Country Code']] = (res.byCountry[row['Country Code']] || 0) + u
    }
  } else if (r.status !== 404) {
    throw new Error(`Apple ${r.status}`) // 404 = pas de rapport ce jour-là (aucune vente) → 0
  }
  // Les 2 derniers jours peuvent encore bouger (rapport pas finalisé) : on ne les fige pas.
  if (day < addDays(dayStr(new Date()), -2)) appleDayCache.set(day, res)
  return res
}

async function appleDownloads(from, to) {
  const days = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  const byDay = {}, byCountry = {}; let total = 0
  // 5 rapports en parallèle
  for (let i = 0; i < days.length; i += 5) {
    const chunk = await Promise.all(days.slice(i, i + 5).map(d => appleDay(d).then(r => [d, r])))
    for (const [d, r] of chunk) {
      byDay[d] = r.units; total += r.units
      for (const [c, u] of Object.entries(r.byCountry)) byCountry[c] = (byCountry[c] || 0) + u
    }
  }
  return { total, byDay, byCountry }
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Google Play — CSV « installs_<package>_<YYYYMM>_overview.csv » (UTF-16) du bucket de la console
// ---------------------------------------------------------------------------------------------------------------
let googleToken = { exp: 0, value: '' }
async function googleAccessToken() {
  const now = Math.floor(Date.now() / 1000)
  if (now < googleToken.exp - 60) return googleToken.value
  const sa = JSON.parse(process.env.PLAY_SA_JSON)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only', aud: sa.token_uri, iat: now, exp: now + 3600 }))
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), createPrivateKey(sa.private_key))
  const r = await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${payload}.${b64url(sig)}` }) })
  if (!r.ok) throw new Error(`Google OAuth ${r.status}`)
  const t = await r.json()
  googleToken = { exp: now + (t.expires_in || 3600), value: t.access_token }
  return t.access_token
}

const googleMonthCache = new Map() // YYYYMM → { day: installs } (mois passés : définitif)
async function googleMonth(ym) {
  if (googleMonthCache.has(ym)) return googleMonthCache.get(ym)
  const object = encodeURIComponent(`stats/installs/installs_${process.env.PLAY_PACKAGE}_${ym}_overview.csv`)
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${process.env.PLAY_STATS_BUCKET}/o/${object}?alt=media`, { headers: { Authorization: `Bearer ${await googleAccessToken()}` } })
  const res = {}
  if (r.status === 200) {
    const buf = Buffer.from(await r.arrayBuffer())
    const txt = buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString('utf16le') : buf.toString('utf8')
    const lines = txt.trim().split(/\r?\n/); const hdr = lines[0].split(',')
    const iDate = hdr.indexOf('Date'), iInst = hdr.findIndex(h => /Daily Device Installs/i.test(h))
    for (const l of lines.slice(1)) { const c = l.split(','); if (c[iDate]) res[c[iDate]] = (res[c[iDate]] || 0) + (parseInt(c[iInst], 10) || 0) }
  } else if (r.status !== 404) {
    throw new Error(`Google Play ${r.status}`)
  }
  if (ym < dayStr(new Date()).slice(0, 7).replace('-', '')) googleMonthCache.set(ym, res)
  return res
}

async function googleInstalls(from, to) {
  const months = new Set()
  for (let d = from; d <= to; d = addDays(d, 1)) months.add(d.slice(0, 7).replace('-', ''))
  const byDay = {}; let total = 0
  for (const ym of months) {
    const m = await googleMonth(ym)
    for (const [d, n] of Object.entries(m)) if (d >= from && d <= to) { byDay[d] = n; total += n }
  }
  return { total, byDay }
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Clics du site (Firestore `siteClicks`, lus avec le jeton de l'admin)
// ---------------------------------------------------------------------------------------------------------------
async function siteClicks(token, from, to) {
  const body = { structuredQuery: { from: [{ collectionId: 'siteClicks' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'day' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
    { fieldFilter: { field: { fieldPath: 'day' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } } ] } }, limit: 20000 } }
  const r = await fetch(`${FIRESTORE}:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`Firestore ${r.status}`)
  const rows = (await r.json()).map(x => x.document && x.document.fields).filter(Boolean)
  const byDay = {}, bySrc = {}, byPlatform = {}; let total = 0, pdf = 0
  for (const f of rows) {
    const src = f.src?.stringValue || '?', platform = f.platform?.stringValue || '?', day = f.day?.stringValue || '?'
    if (platform === 'pdf') { pdf++; continue } // ouverture du PDF : pas un clic store
    total++
    byDay[day] = (byDay[day] || 0) + 1
    byPlatform[platform] = (byPlatform[platform] || 0) + 1
    bySrc[src] = bySrc[src] || { ios: 0, android: 0, desktop: 0 }
    bySrc[src][platform] = (bySrc[src][platform] || 0) + 1
  }
  return { total, pdfOpens: pdf, byDay, bySrc, byPlatform }
}

// ---------------------------------------------------------------------------------------------------------------
// Agrégat + cache
// ---------------------------------------------------------------------------------------------------------------
const cache = new Map() // days → { at, data }
async function buildStats(days, token) {
  const to = dayStr(new Date())
  const from = days > 0 ? addDays(to, -(days - 1)) : LAUNCH_DAY
  const errors = {}
  const safe = (name, p) => p.catch(e => { errors[name] = String(e.message || e); return null })
  const [leads, emails, apple, google, clicks] = await Promise.all([
    safe('brevoLeads', brevoLeads()),
    safe('brevoEmails', brevoEmails(from, to)),
    process.env.ASC_SALES_KEY_P8 ? safe('apple', appleDownloads(from, addDays(to, -1))) : Promise.resolve(null),
    process.env.PLAY_SA_JSON ? safe('google', googleInstalls(from, to)) : Promise.resolve(null),
    safe('siteClicks', siteClicks(token, from, to)),
  ])
  if (leads) {
    // leads dans la période (le total reste « tout temps »)
    let inPeriod = 0, today = 0
    for (const [d, n] of Object.entries(leads.byDay)) { if (d >= from && d <= to) inPeriod += n; if (d === to) today += n }
    leads.inPeriod = inPeriod; leads.today = today
  }
  return { generatedAt: Date.now(), period: { from, to, days }, leads, emails, downloads: { apple, google }, clicks, app: null, errors }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.some(re => re.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Authorization')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET uniquement' })
  res.setHeader('Cache-Control', 'no-store')

  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  let uid
  try { uid = await verifyIdToken(token) } catch (e) { return res.status(401).json({ error: `non authentifié (${e.message})` }) }
  if (!(await isAdmin(uid, token))) return res.status(403).json({ error: 'accès réservé aux admins' })

  const url = new URL(req.url, 'https://x')
  const days = [7, 30, 0].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30
  const refresh = url.searchParams.get('refresh') === '1'
  const hit = cache.get(days)
  if (hit && !refresh && Date.now() - hit.at < 10 * 60 * 1000) return res.status(200).json({ ...hit.data, cached: true })
  try {
    const data = await buildStats(days, token)
    cache.set(days, { at: Date.now(), data })
    return res.status(200).json(data)
  } catch (e) {
    console.error('[studio]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
}
