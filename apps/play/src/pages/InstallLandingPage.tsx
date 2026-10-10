/**
 * Page d'atterrissage WEB d'un QR (coloriage `/p/:id` ou livre `/livre/:id`) : le lecteur web n'est plus
 * proposé (zéro scan web observé) ; on pousse l'installation de l'app, qui seule anime le coloriage.
 *  - iOS : la bannière Safari (meta apple-itunes-app) affiche « OUVRIR » si PicoPop est installée ;
 *  - Android : « Ouvrir dans PicoPop » = intent:// (ouvre l'app si installée, sinon Play Store) ;
 *  - les liens stores passent par picopop.app/go (comptés, campagne, Install Referrer avec le coloriage).
 * `?web=1` garde l'ancien lecteur web (tests).
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { firebaseRest } from '@shared/db/firebase'
import Mascot from '@shared/components/mascot/Mascot'
import LoadingScreen from '../components/LoadingScreen'
import { useI18n } from '../i18n'

const GO = 'https://picopop.app/go'
const PLAY_PACKAGE = 'app.picopop.mobile'

function platformOf(): 'ios' | 'android' | 'other' {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'other'
}

export default function InstallLandingPage({ kind }: { kind: 'project' | 'book' }) {
  const { t } = useI18n()
  const { projectId, bookId } = useParams<{ projectId?: string; bookId?: string }>()
  const id = (kind === 'project' ? projectId : bookId) ?? ''
  const [state, setState] = useState<{ loading: boolean; name: string | null; thumb: string | null; ok: boolean }>({ loading: true, name: null, thumb: null, ok: true })

  useEffect(() => {
    let cancelled = false
    // Firestore REST (lecture publique d'un document publié) : ~200 ms, sans attendre l'initialisation du SDK
    // (18 s observées en navigation privée). Rien d'autre n'est chargé : la page redirige vers l'app ou le store.
    const coll = kind === 'project' ? 'projects' : 'books'
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseRest.projectId}/databases/${firebaseRest.database}/documents/${coll}/${encodeURIComponent(id)}?key=${firebaseRest.apiKey}&mask.fieldPaths=name&mask.fieldPaths=published&mask.fieldPaths=hasThumbnail`
    ;(async () => {
      try {
        const r = await fetch(url)
        const doc = r.ok ? await r.json() : null
        const f = doc?.fields ?? {}
        const ok = !!doc && f.published?.booleanValue === true
        const thumb = ok && kind === 'project' && f.hasThumbnail?.booleanValue !== false
          ? `https://firebasestorage.googleapis.com/v0/b/${firebaseRest.storageBucket}/o/${encodeURIComponent(`projects/${id}/thumbnail`)}?alt=media`
          : null
        if (!cancelled) setState({ loading: false, name: f.name?.stringValue ?? null, thumb, ok })
      } catch {
        if (!cancelled) setState({ loading: false, name: null, thumb: null, ok: false })
      }
    })()
    return () => { cancelled = true }
  }, [kind, id])

  const platform = platformOf()
  const ref = kind === 'project' ? `&p=${encodeURIComponent(id)}` : `&b=${encodeURIComponent(id)}`
  const iosUrl = `${GO}?src=qr-web&to=ios${ref}`
  const androidUrl = `${GO}?src=qr-web&to=android${ref}`
  // Android : l'app si installée (App Link), sinon le Play Store (avec le coloriage dans le referrer)
  const openAndroid = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=${PLAY_PACKAGE};S.browser_fallback_url=${encodeURIComponent(androidUrl)};end`

  // Sur téléphone, on n'attend pas de clic : direction le store (qui affiche « Ouvrir » si l'app est installée). La carte reste
  // affichée derrière (retour arrière, ou si le navigateur bloque la redirection).
  useEffect(() => {
    if (state.loading || !state.ok || platform === 'other') return
    // Store via /go (compté ; Android : le coloriage voyage dans le referrer). Pas d'intent:// sans geste utilisateur
    // (Chrome le bloque) : « Ouvrir dans PicoPop » reste disponible au tap.
    const t = setTimeout(() => { location.href = platform === 'android' ? androidUrl : iosUrl }, 900)
    return () => clearTimeout(t)
  }, [state.loading, state.ok, platform, androidUrl, iosUrl])

  // Pas de barre d'onglets ni de menu sur cette page (visiteur web, pas d'app)
  useEffect(() => {
    document.body.dataset.installLanding = '1'
    return () => { delete document.body.dataset.installLanding }
  }, [])

  if (state.loading) return <LoadingScreen />
  const title = state.ok ? (kind === 'project' ? t('install.title') : t('install.titleBook')) : t('unavailable.title')

  return (
    <div className="install-page">
      <div className="install-card soft-card">
        {state.thumb ? <img className="install-thumb" src={state.thumb} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} /> : <Mascot size={96} mood={state.ok ? 'happy' : 'oops'} />}
        <h1 className="install-title">{title}</h1>
        {state.ok && state.name && <p className="install-sub">{state.name}</p>}
        <p className={state.ok ? 'install-sub' : 'install-have'}>{state.ok ? t('install.sub') : t('unavailable.text')}</p>
        {state.ok && <ol className="install-steps">
          <li><b>1</b><span>{t('install.step1')}</span></li>
          <li><b>2</b><span>{t('install.step2')}</span></li>
          <li><b>3</b><span>{t('install.step3')}</span></li>
        </ol>}
        <div className="install-actions">
          {platform === 'android' && <a className="soft-btn install-btn install-btn--mint" href={openAndroid}>{t('install.open')}</a>}
          {platform !== 'android' && <a className="soft-btn install-btn" href={iosUrl}>{t('install.ios')}</a>}
          {platform !== 'ios' && <a className={`soft-btn install-btn${platform === 'android' ? '' : ' install-btn--ghost'}`} href={androidUrl}>{t('install.android')}</a>}
          {platform === 'ios' && <a className="soft-btn install-btn install-btn--ghost" href={androidUrl}>{t('install.android')}</a>}
        </div>
        <p className="install-free">{t('install.free')}</p>
        <p className="install-have">{t('install.have')}</p>
      </div>
    </div>
  )
}
