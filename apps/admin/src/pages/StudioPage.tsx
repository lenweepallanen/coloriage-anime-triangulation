import { useCallback, useEffect, useMemo, useState } from 'react'
import { auth } from '../db/firebase'
import { getAllProjects, getProjectCardThumbnail } from '../db/projectsStore'
import { getAllBooks } from '../db/booksStore'

/**
 * PicoPop Studio — tableau de bord du funnel Free Dinosaur (leads, mails, clics stores,
 * téléchargements) + emplacements pour les événements anonymes de l'app (livres installés,
 * scans, partages) qui arriveront avec l'app 1.1.
 *
 * Les chiffres viennent de `/api/studio` (fonction Vercel du projet admin, voir apps/admin/api/studio.js),
 * appelée avec le jeton Firebase de l'admin connecté. En dev (Vite), on appelle la fonction déployée.
 */

type Period = 7 | 30 | 0

interface EmailStat { tag: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; unsubscribed: number }
interface StudioData {
  generatedAt: number
  cached?: boolean
  period: { from: string; to: string; days: number }
  leads: { total: number; inPeriod: number; today: number; byDay: Record<string, number>; bySource: Record<string, number> } | null
  emails: EmailStat[] | null
  downloads: {
    apple: { total: number; byDay: Record<string, number>; byCountry: Record<string, number>; lastDay?: string | null } | null
    google: { total: number; byDay: Record<string, number>; lastDay?: string | null } | null
  }
  clicks: { total: number; pdfOpens: number; doubles?: number; byDay: Record<string, number>; bySrc: Record<string, { ios: number; android: number; desktop: number }>; byPlatform: Record<string, number> } | null
  app: {
    events: number; installs: number; installsNative?: number; installsWeb?: number; byPlatform: Record<string, number>
    bookInstalls: number; scanners: number; sharers: number; scans: number; shares: number
    byDay: Record<string, { installs: number; scans: number; shares: number }>
    byBook: Record<string, number>
    byProject: Record<string, { scans: number; scanners: number; shares: number; sharers: number }>
  } | null
  errors: Record<string, string>
}

const API_BASE = import.meta.env.VITE_STUDIO_API_URL || (import.meta.env.DEV ? 'https://coloriage-anime-admin.vercel.app' : '')

const EMAIL_LABELS: Record<string, { title: string; when: string }> = {
  'email-1': { title: 'PDF + app', when: 'à l’inscription' },
  'email-2': { title: 'Relance', when: 'J+1' },
  'email-3': { title: 'Partage', when: 'J+3' },
}
const SRC_LABELS: Record<string, string> = {
  thanks: 'Page merci', 'thanks-qr': 'Page merci (QR)', 'thanks-pdf': 'Page merci (PDF)',
  home: 'Accueil site', 'home-fr': 'Accueil site (FR)', 'free-dinosaur': 'Landing Free Dinosaur',
  'email-1': 'Mail 1', 'email-2': 'Mail 2', 'email-3': 'Mail 3', 'pdf-qr': 'QR du PDF', app: 'Lien /app',
}

const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('fr-FR'))
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)} %` : '—')
const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`
function addDays(day: string, n: number) { return new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10) }

export default function StudioPage() {
  const [period, setPeriod] = useState<Period>(30)
  const [data, setData] = useState<StudioData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string; bookId: string; bookName: string; thumb: string | null }[] | null>(null)

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError(null)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('non connecté')
      const token = await user.getIdToken()
      const r = await fetch(`${API_BASE}/api/studio?days=${period}${refresh ? '&refresh=1' : ''}`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  // Liste des coloriages publiés (pour la section « par coloriage », alimentée plus tard par l'app)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [projs, books] = await Promise.all([getAllProjects(), getAllBooks()])
        const bookName = new Map(books.filter(b => b.published).map(b => [b.id, b.name]))
        // coloriages publiés appartenant à un livre publié (les livres de test restent hors du Studio)
        const published = projs.filter(p => p.published && p.bookId && bookName.has(p.bookId)).sort((a, b) => (bookName.get(a.bookId!)! + a.name).localeCompare(bookName.get(b.bookId!)! + b.name))
        const rows = published.map(p => ({ id: p.id, name: p.name, bookId: p.bookId!, bookName: (p.bookId && bookName.get(p.bookId)) || '', thumb: null as string | null }))
        if (cancelled) return
        setProjects(rows)
        // vignettes en second temps, sans bloquer l'affichage des noms
        for (const p of published) {
          const blob = await getProjectCardThumbnail(p).catch(() => null)
          if (cancelled) return
          if (blob) setProjects(prev => prev && prev.map(r => (r.id === p.id ? { ...r, thumb: URL.createObjectURL(blob) } : r)))
        }
      } catch { if (!cancelled) setProjects([]) }
    })()
    return () => { cancelled = true }
  }, [])

  // Série quotidienne (barres) : leads / clics store / téléchargements
  const series = useMemo(() => {
    if (!data) return []
    const nDays = period === 7 ? 7 : period === 30 ? 30 : 30
    const to = data.period.to
    const out: { day: string; leads: number; clicks: number; downloads: number; scans: number }[] = []
    for (let i = nDays - 1; i >= 0; i--) {
      const day = addDays(to, -i)
      out.push({
        day,
        leads: data.leads?.byDay[day] ?? 0,
        clicks: data.clicks?.byDay[day] ?? 0,
        downloads: (data.downloads.apple?.byDay[day] ?? 0) + (data.downloads.google?.byDay[day] ?? 0),
        scans: data.app?.byDay[day]?.scans ?? 0,
      })
    }
    return out
  }, [data, period])

  const app = data?.app ?? null
  const apple = data?.downloads.apple ?? null
  const google = data?.downloads.google ?? null
  const downloadsTotal = apple || google ? (apple?.total ?? 0) + (google?.total ?? 0) : null
  const email1 = data?.emails?.find(e => e.tag === 'email-1')
  const emailClicks = data?.emails?.reduce((s, e) => s + e.clicked, 0) ?? 0
  const leadsIn = data?.leads?.inPeriod ?? 0
  const updatedAgo = data ? Math.max(0, Math.round((Date.now() - data.generatedAt) / 60000)) : null

  const funnel = data ? [
    { label: 'Leads', sub: 'formulaire picopop.app', n: leadsIn, color: 'var(--color-primary)' },
    { label: 'Mail 1 ouvert', sub: '', n: email1?.opened ?? 0, color: 'var(--color-primary)' },
    { label: 'Clic dans un mail', sub: 'mails 1, 2 et 3', n: emailClicks, color: 'var(--color-primary)' },
    { label: 'Clic vers un store', sub: 'page merci, mails, site', n: data.clicks?.total ?? 0, color: 'var(--color-primary)' },
    { label: 'Téléchargement', sub: 'Apple + Google', n: downloadsTotal, color: 'var(--color-type-bone)' },
    { label: 'App ouverte', sub: 'appareils, app ≥ 1.1', n: app ? app.installs : null, color: 'var(--color-type-physics)' },
    { label: 'Livre ajouté', sub: 'appareils', n: app ? app.bookInstalls : null, color: 'var(--color-type-physics)' },
    { label: 'Coloriage scanné', sub: 'appareils', n: app ? app.scanners : null, color: 'var(--color-type-physics)' },
    { label: 'Film partagé', sub: 'appareils', n: app ? app.sharers : null, color: 'var(--color-type-physics)' },
  ] : []
  const funnelMax = Math.max(1, ...funnel.map(f => f.n ?? 0))

  const periodLabel = period === 7 ? '7 derniers jours' : period === 30 ? '30 derniers jours' : 'depuis le lancement'
  const clickRows = data?.clicks ? Object.entries(data.clicks.bySrc).sort((a, b) => (b[1].ios + b[1].android + b[1].desktop) - (a[1].ios + a[1].android + a[1].desktop)) : []
  const chartMax = Math.max(1, ...series.map(s => Math.max(s.leads, s.clicks, s.downloads, s.scans)))

  return (
    <div className="studio">
      <div className="studio-head">
        <h1>PicoPop Studio</h1>
        <div className="studio-seg" role="tablist" aria-label="Période">
          {([7, 30, 0] as Period[]).map(p => (
            <button key={p} role="tab" aria-selected={period === p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
              {p === 0 ? 'Tout' : `${p} j`}
            </button>
          ))}
        </div>
        <span className="studio-upd">
          {loading ? 'Chargement…' : updatedAgo == null ? '' : updatedAgo === 0 ? 'À jour' : `Mis à jour il y a ${updatedAgo} min`}
        </span>
        <button className="btn-secondary btn-sm" onClick={() => load(true)} disabled={loading}>↻ Actualiser</button>
      </div>

      {error && <div className="studio-error">Impossible de charger les chiffres : {error}</div>}
      {data && Object.keys(data.errors).length > 0 && (
        <div className="studio-warn">Sources indisponibles : {Object.entries(data.errors).map(([k, v]) => `${k} (${v})`).join(' · ')}</div>
      )}

      <div className="studio-kpis">
        <div className="studio-card studio-kpi">
          <div className="lbl">Leads (Brevo) {data?.leads && data.leads.today > 0 && <span className="delta">+{data.leads.today} aujourd’hui</span>}</div>
          <div className="val">{fmt(data?.leads ? (period === 0 ? data.leads.total : data.leads.inPeriod) : null)}</div>
          <div className="sub">{data?.leads ? `${fmt(data.leads.total)} au total · ${periodLabel}` : periodLabel}</div>
        </div>
        <div className="studio-card studio-kpi">
          <div className="lbl">Clics vers les stores</div>
          <div className="val">{fmt(data?.clicks?.total)}</div>
          <div className="sub">
            {data?.clicks ? `iOS ${fmt(data.clicks.byPlatform.ios ?? 0)} · Android ${fmt(data.clicks.byPlatform.android ?? 0)} · PC ${fmt(data.clicks.byPlatform.desktop ?? 0)} · PDF ouvert ${fmt(data.clicks.pdfOpens)}${data.clicks.doubles ? ` · ${fmt(data.clicks.doubles)} doublons retirés` : ''}` : 'liens /go comptés depuis le 4 oct. 2026'}
          </div>
        </div>
        <div className="studio-card studio-kpi">
          <div className="lbl">Téléchargements app</div>
          <div className="val">{fmt(downloadsTotal)}</div>
          <div className="sub">
            App Store {fmt(apple?.total ?? null)}{apple?.lastDay ? ` (au ${apple.lastDay.slice(8)}/${apple.lastDay.slice(5, 7)})` : ''} · Google Play {google ? `${fmt(google.total)}${google.lastDay ? ` (au ${google.lastDay.slice(8)}/${google.lastDay.slice(5, 7)}, en retard)` : ''}` : 'en attente d’accès'}
            {apple && Object.keys(apple.byCountry).length > 0 && ` · ${Object.entries(apple.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c} ${n}`).join(', ')}`}
          </div>
        </div>
        <div className={`studio-card studio-kpi${app && app.events > 0 ? '' : ' dim'}`}>
          <div className="lbl">Scans de coloriages {!(app && app.events > 0) && <span className="soon">dès l’app 1.1</span>}</div>
          <div className="val">{fmt(app ? app.scans : null)}</div>
          <div className="sub">{app && app.events > 0 ? `${fmt(app.scanners)} appareils · ${fmt(app.shares)} partages · ${fmt(app.installsNative ?? app.installs)} appareils app (iOS ${fmt(app.byPlatform.ios ?? 0)}, Android ${fmt(app.byPlatform.android ?? 0)}) · ${fmt(app.installsWeb ?? app.byPlatform.web ?? 0)} visites web` : 'événements anonymes de l’app (livres ajoutés, scans, partages)'}</div>
        </div>
      </div>

      <div className="studio-grid2">
        <div className="studio-card">
          <h2>Entonnoir Free Dinosaur · {periodLabel}</h2>
          <div className="studio-funnel">
            {funnel.map(f => (
              <div key={f.label} className={`step${f.n == null ? ' app' : ''}`}>
                <span className="lbl">{f.label}{f.sub && <small>{f.sub}</small>}</span>
                <div className="bar"><i style={{ width: f.n == null ? 0 : `${Math.max(f.n > 0 ? 2 : 0, (f.n / funnelMax) * 100)}%`, background: f.color }} /></div>
                <span className="n">{fmt(f.n)}{f.n != null && leadsIn > 0 && f.label !== 'Leads' && <small>{pct(f.n, leadsIn)}</small>}</span>
              </div>
            ))}
          </div>
          <p className="studio-note">Les 4 dernières marches viennent des événements anonymes de l’app (version 1.1 et plus, identifiant d’installation aléatoire — aucune donnée personnelle) : elles ne couvrent que les appareils à jour.</p>
        </div>

        <div className="studio-card">
          <h2>Mails du funnel</h2>
          <table className="studio-table">
            <thead><tr><th>Mail</th><th className="r">Envoyés</th><th className="r">Ouverts</th><th className="r">Clics</th></tr></thead>
            <tbody>
              {(data?.emails ?? []).map((e, i) => (
                <tr key={e.tag}>
                  <td>{i + 1} · {EMAIL_LABELS[e.tag]?.title ?? e.tag}<br /><span className="studio-pill">{EMAIL_LABELS[e.tag]?.when ?? ''}</span></td>
                  <td className="r">{fmt(e.sent)}</td>
                  <td className="r">{fmt(e.opened)} {e.delivered > 0 && <span className="studio-pill">{pct(e.opened, e.delivered)}</span>}</td>
                  <td className="r">{fmt(e.clicked)}</td>
                </tr>
              ))}
              {!data?.emails && <tr><td colSpan={4} className="studio-empty">—</td></tr>}
            </tbody>
          </table>
          <h2 style={{ marginTop: 20 }}>Origine des clics store</h2>
          <table className="studio-table">
            <thead><tr><th>Origine</th><th className="r">iOS</th><th className="r">Android</th><th className="r">PC (QR)</th></tr></thead>
            <tbody>
              {clickRows.map(([src, v]) => (
                <tr key={src}><td>{SRC_LABELS[src] ?? src}</td><td className="r">{fmt(v.ios)}</td><td className="r">{fmt(v.android)}</td><td className="r">{fmt(v.desktop)}</td></tr>
              ))}
              {clickRows.length === 0 && <tr><td colSpan={4} className="studio-empty">Aucun clic sur la période</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="studio-card" style={{ marginBottom: 20 }}>
        <h2>Par jour · {series.length} derniers jours</h2>
        <div className="studio-legend">
          <span><i style={{ background: 'var(--color-primary)' }} />Leads</span>
          <span><i style={{ background: 'var(--color-type-bone)' }} />Clics store</span>
          <span><i style={{ background: 'var(--color-warning)' }} />Téléchargements</span>
          <span><i style={{ background: 'var(--color-type-physics)' }} />Scans</span>
        </div>
        <div className="studio-chart" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(0, 1fr))` }}>
          {series.map((s, idx) => (
            <div key={s.day} className="col" title={`${dayLabel(s.day)} : ${s.leads} leads, ${s.clicks} clics, ${s.downloads} téléchargements, ${s.scans} scans`}>
              <div className="bars">
                <i style={{ height: `${(s.leads / chartMax) * 100}%`, background: 'var(--color-primary)' }} />
                <i style={{ height: `${(s.clicks / chartMax) * 100}%`, background: 'var(--color-type-bone)' }} />
                <i style={{ height: `${(s.downloads / chartMax) * 100}%`, background: 'var(--color-warning)' }} />
                <i style={{ height: `${(s.scans / chartMax) * 100}%`, background: 'var(--color-type-physics)' }} />
              </div>
              <span className={`day${series.length > 14 && idx % 2 ? ' hide2' : ''}${idx % 5 ? ' hide5' : ''}`}>{dayLabel(s.day)}</span>
            </div>
          ))}
        </div>
        <p className="studio-note">Échelle : {chartMax} par jour au maximum. Les téléchargements Apple arrivent avec un jour de décalage (rapports de ventes).</p>
      </div>

      <div className="studio-card">
        <h2>Par coloriage {!(app && app.events > 0) && <span className="soon">dès l’app 1.1</span>}</h2>
        <div className="studio-projects">
          {(projects ?? []).map(p => (
            <div key={p.id} className="proj">
              <div className="th">{p.thumb && <img src={p.thumb} alt="" />}</div>
              <div><b>{p.name}</b><span>{p.bookName ? `${p.bookName} · ` : ''}livre {fmt(app ? (app.byBook[p.bookId] ?? 0) : null)} · scans {fmt(app ? (app.byProject[p.id]?.scans ?? 0) : null)} · partages {fmt(app ? (app.byProject[p.id]?.shares ?? 0) : null)}</span></div>
            </div>
          ))}
          {projects === null && <div className="studio-empty">Chargement des coloriages…</div>}
          {projects && projects.length === 0 && <div className="studio-empty">Aucun coloriage publié</div>}
        </div>
        <p className="studio-note">« livre » = appareils ayant ajouté le livre ; scans et partages = nombre d’événements sur le coloriage. Alimenté par l’app à partir de la version 1.1 (événements anonymes, identifiant d’installation aléatoire).</p>
      </div>
    </div>
  )
}
