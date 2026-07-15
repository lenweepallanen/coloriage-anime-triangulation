import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { useParams, Navigate, useSearchParams, useNavigate } from 'react-router-dom'
import PauseOverlay, { SettingsButton } from '../components/scan/PauseOverlay'
import { useProject } from '../hooks/useProject'
import CameraView from '../components/scan/CameraView'
import CornerAdjustment from '../components/scan/CornerAdjustment'
import { useScanProcessor } from '../components/scan/ScanProcessor'
// PIXI (plusieurs centaines de Ko) n'est tiré QUE par ces deux players. On les charge
// en lazy → ils sortent du bundle initial (menu livre / accueil play, qui n'en ont pas
// besoin). On les précharge ensuite en tâche de fond dès l'entrée sur la page scan
// (cf. effet dans ScanFlow), comme OpenCV, pour que l'étape preview/animation reste
// sans temps mort. importXxx réutilisé pour le préchargement (le bundler déduplique).
const importAnimationPlayer = () => import('../components/scan/AnimationPlayer')
const importScenePlayer = () => import('../components/scan/ScenePlayer')
const AnimationPlayer = lazy(importAnimationPlayer)
const ScenePlayer = lazy(importScenePlayer)
import { generateLimbMask, generateLimbMaskFromContours } from '../utils/limbMaskGenerator'
import { requestLamaInpainting } from '../utils/lamaInpainting'
import { renderIsolatedLimbDebug } from '../utils/hiddenFaceTexture'
import type { Point2D, Project } from '../types/project'

interface ScanPageProps {
  /** Si fourni, court-circuite useProject (utilisé par play pour passer un projet light). */
  project?: Project | null
  loading?: boolean
  /** Si false, indique que des blobs (image, JSON) sont encore en train de charger en arrière-plan.
   *  Quand true, on peut afficher l'animation. Tant que false, l'UI scan tolère les blobs null. */
  deferredLoaded?: boolean
  /** 'admin' (défaut) : flux complet avec écran debug. 'play' : flux simplifié
   *  (calcul en arrière-plan + écran de validation frame 0, sans étapes intermédiaires). */
  mode?: 'admin' | 'play'
}

export default function ScanPage({ project: projectProp, loading: loadingProp, deferredLoaded, mode = 'admin' }: ScanPageProps = {}) {
  const { projectId } = useParams<{ projectId: string }>()
  const fallback = useProject(projectProp === undefined ? projectId : null)
  const project = projectProp !== undefined ? projectProp : fallback.project
  const loading = loadingProp !== undefined ? loadingProp : fallback.loading

  if (loading) return <div className="loading">Chargement...</div>
  if (!project) return <Navigate to="/" replace />

  // Géométrie disponible : soit pipeline legacy (mesh.triangles), soit pipeline autonome.
  const hasLegacyMesh = project.animations.some(a => a.mesh != null && (a.mesh.triangles?.length ?? 0) > 0)
  const hasProjectTri = project.projectTriangulation?.step3Validated === true
  const hasMesh = hasLegacyMesh || hasProjectTri

  // En mode play avec deferred-loading, ne pas afficher l'erreur "aucune image" tant que
  // la phase 2 n'est pas finie (l'image arrive en arrière-plan).
  const skipImageCheck = deferredLoaded === false

  if ((!skipImageCheck && !project.originalImageBlob) || !hasMesh) {
    return (
      <div className="scan-page">
        <h2>{project.name} — Mode Coloriage</h2>
        <div className="placeholder">
          {!skipImageCheck && !project.originalImageBlob && 'Aucune image importée. '}
          {!hasMesh && 'Aucun mesh défini. '}
          Configurez le projet dans le mode Admin d'abord.
        </div>
      </div>
    )
  }

  return <ScanFlow project={project} deferredLoaded={deferredLoaded} mode={mode} />
}

function ScanFlow({ project, deferredLoaded, mode }: { project: Project; deferredLoaded?: boolean; mode: 'admin' | 'play' }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const bookId = searchParams.get('book')
  const [paused, setPaused] = useState(false)

  // Orientation responsive : on ne verrouille PAS l'orientation (cf. soucis iOS) ;
  // le layout s'adapte au choix du user (téléphone vertical → portrait, horizontal
  // → canvas à gauche + HUD à droite). Sert aussi de clé de remount pour refit PIXI.
  const [landscape, setLandscape] = useState(
    typeof window !== 'undefined' && window.matchMedia?.('(orientation: landscape)').matches
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(orientation: landscape)')
    const onChange = () => setLandscape(mq.matches)
    mq.addEventListener?.('change', onChange)
    window.addEventListener('resize', onChange)
    return () => {
      mq.removeEventListener?.('change', onChange)
      window.removeEventListener('resize', onChange)
    }
  }, [])

  // Préchargement non bloquant de PIXI + players (même logique qu'OpenCV au démarrage
  // caméra) : pendant que l'utilisateur cadre puis prend sa photo, le gros chunk
  // d'animation se télécharge en arrière-plan → l'étape preview/animation s'affiche
  // sans temps mort. Échec silencieux : Suspense couvrira le cas au moment du rendu.
  useEffect(() => {
    void importAnimationPlayer().catch(() => {})
    void importScenePlayer().catch(() => {})
  }, [])

  function handleBack() {
    if (bookId) navigate(`/livre/${bookId}`)
    else navigate(-1)
  }
  type ScanStage = 'camera' | 'adjust' | 'processing' | 'debug' | 'preview' | 'animation'
  type LamaStatus = 'idle' | 'generating-mask' | 'warmup' | 'inpainting' | 'done' | 'error' | 'not-needed'

  const [stage, setStage] = useState<ScanStage>('camera')
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  // URL de la photo capturée (visuel « scan en cours » du mode play)
  const capturedUrl = useMemo(
    () => (capturedBlob ? URL.createObjectURL(capturedBlob) : null),
    [capturedBlob],
  )
  useEffect(() => () => { if (capturedUrl) URL.revokeObjectURL(capturedUrl) }, [capturedUrl])
  const [detectedCorners, setDetectedCorners] = useState<Point2D[] | null>(null)
  const [lamaCanvas, setLamaCanvas] = useState<HTMLCanvasElement | null>(null)
  const [lamaStatus, setLamaStatus] = useState<LamaStatus>('idle')
  const [lamaError, setLamaError] = useState<string | null>(null)
  const [lamaMaskUrl, setLamaMaskUrl] = useState<string | null>(null)
  const [lamaResultUrl, setLamaResultUrl] = useState<string | null>(null)
  const [limbExtDebugImages, setLimbExtDebugImages] = useState<{ label: string; isolatedUrl: string }[]>([])
  const lamaStartedRef = useRef(false)
  const processor = useScanProcessor(project)

  // Transition from processing to debug (admin) / validation preview (play) when rectified canvas is ready
  useEffect(() => {
    if (processor.rectifiedCanvas && stage === 'processing' && !processor.processing) {
      setStage(mode === 'play' ? 'preview' : 'debug')
    }
  }, [processor.rectifiedCanvas, processor.processing, stage, mode])

  // Marque le coloriage comme scanné dès qu'on entre dans l'animation
  useEffect(() => {
    if (stage === 'animation') {
      try { localStorage.setItem(`scanned:${project.id}`, '1') } catch { /* ignore */ }
    }
  }, [stage, project.id])

  // Trigger LaMa inpainting after rectified canvas is ready
  useEffect(() => {
    if (!processor.rectifiedCanvas || lamaStartedRef.current) return
    lamaStartedRef.current = true

    // Sources possibles de zones pattes : (1) animation walk avec Bézier,
    // (2) projectTriangulation avec contours SAM 2 (members-bones-v3 etc.)
    const walkAnim = project.animations.find(
      a => a.type === 'walk' && a.mesh?.walkLimbSeparation?.zones?.length
    )
    const sep = walkAnim?.mesh?.walkLimbSeparation ?? null
    const tri = project.projectTriangulation
    const triLegZoneIds = tri?.contours
      ? tri.zones.filter(z => z.id !== 'body').map(z => z.id).filter(id => tri.contours![id]?.length)
      : []
    const hasTriLegs = !!tri?.contours && triLegZoneIds.length > 0

    if (!sep && !hasTriLegs) {
      setLamaStatus('not-needed')
      return
    }

    if (sep) {
      console.log('[LimbExt] sep keys:', Object.keys(sep), 'hiddenFaceLimbZones:', sep.hiddenFaceLimbZones, 'hiddenFaceZones:', sep.hiddenFaceZones?.length)
    }
    const scanCanvas = processor.rectifiedCanvas

    ;(async () => {
      try {
        setLamaStatus('generating-mask')

        // Génération du masque : priorité walk Bézier, sinon contours SAM 2 projet
        const maskCanvas = sep
          ? generateLimbMask(
              sep.zones,
              scanCanvas.width, scanCanvas.height,
              scanCanvas.width, scanCanvas.height,
              processor.contentAlignment ?? undefined,
            )
          : generateLimbMaskFromContours(
              tri!.contours!,
              triLegZoneIds,
              scanCanvas.width, scanCanvas.height,
              scanCanvas.width, scanCanvas.height,
              processor.contentAlignment ?? undefined,
            )
        setLamaMaskUrl(maskCanvas.toDataURL())

        setLamaStatus('warmup')

        // Call LaMa Cloud Function (ping warmup + inpainting)
        const result = await requestLamaInpainting(scanCanvas, maskCanvas, {
          onPhase: (phase) => setLamaStatus(phase),
        })
        setLamaCanvas(result)
        setLamaResultUrl(result.toDataURL())
        setLamaStatus('done')
      } catch (err) {
        console.warn('[LaMa] Inpainting failed, will use Laplacian fallback:', err)
        setLamaError(err instanceof Error ? err.message : 'Erreur LaMa')
        setLamaStatus('error')
      }

      // Generate limb extension debug images
      // Search ALL walk animations for hiddenFaceLimbZones, then fallback to projectTriangulation (CoTracker3/V3)
      const debugImgs: { label: string; isolatedUrl: string }[] = []
      for (const wa of project.animations) {
        if (wa.type !== 'walk') continue
        const wSep = wa.mesh?.walkLimbSeparation
        if (!wSep?.hiddenFaceLimbZones?.length) continue
        for (const hfl of wSep.hiddenFaceLimbZones) {
          const zonePts = wSep.zonePoints[hfl.limbZoneId]
          const zoneTris = wSep.zoneTriangles[hfl.limbZoneId]
          if (!zonePts || !zoneTris) continue
          const zone = wSep.zones.find(z => z.id === hfl.limbZoneId)
          const label = zone?.label ?? hfl.limbZoneId

          const isolatedCanvas = renderIsolatedLimbDebug(
            scanCanvas, hfl, zonePts, zoneTris,
            scanCanvas.width, scanCanvas.height,
            processor.contentAlignment ?? undefined,
          )

          debugImgs.push({
            label,
            isolatedUrl: isolatedCanvas.toDataURL(),
          })
        }
      }
      if (debugImgs.length === 0 && tri?.hiddenFaceLimbZones?.length) {
        for (const hfl of tri.hiddenFaceLimbZones) {
          const zonePts = tri.zonePoints?.[hfl.limbZoneId]
          const zoneTris = tri.zoneTriangles?.[hfl.limbZoneId]
          if (!zonePts || !zoneTris) continue
          const zone = tri.zones.find(z => z.id === hfl.limbZoneId)
          const label = zone?.label ?? hfl.limbZoneId

          const isolatedCanvas = renderIsolatedLimbDebug(
            scanCanvas, hfl, zonePts, zoneTris,
            scanCanvas.width, scanCanvas.height,
            processor.contentAlignment ?? undefined,
          )

          debugImgs.push({
            label,
            isolatedUrl: isolatedCanvas.toDataURL(),
          })
        }
      }
      if (debugImgs.length > 0) setLimbExtDebugImages(debugImgs)
    })()
  }, [processor.rectifiedCanvas, processor.contentAlignment, project.animations])

  const onCameraCapture = useCallback(
    (blob: Blob, corners: Point2D[] | null) => {
      setCapturedBlob(blob)
      setDetectedCorners(corners)
      if (mode === 'play') {
        // Play : pas d'ajustement manuel des coins — on lance tout le calcul
        // (correction perspective + LaMa) en arrière-plan dès la prise de photo.
        setStage('processing')
        void processor.handleCapture(blob, corners)
      } else {
        setStage('adjust')
      }
    },
    [mode, processor]
  )

  const onCornersConfirmed = useCallback(
    async (adjustedCorners: Point2D[]) => {
      if (!capturedBlob) return
      setStage('processing')
      await processor.handleCapture(capturedBlob, adjustedCorners)
    },
    [capturedBlob, processor]
  )

  function handleRetake() {
    processor.reset()
    setCapturedBlob(null)
    setDetectedCorners(null)
    setLamaCanvas(null)
    setLamaStatus('idle')
    setLamaError(null)
    setLamaMaskUrl(null)
    setLamaResultUrl(null)
    lamaStartedRef.current = false
    setStage('camera')
  }

  return (
    <div className="scan-page">
      {mode === 'play' && stage !== 'animation' && (
        <button className="scan-back-btn" onClick={() => window.history.back()} aria-label="Retour">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5 8 12l7 7" />
          </svg>
        </button>
      )}
      {stage !== 'animation' && stage !== 'preview' && (
        mode === 'play' ? (
          <header className="scan-header">
            <h2 className="scan-header-title">SCAN</h2>
            <p className="scan-header-sub">
              {stage === 'camera'
                ? 'Scanne ton coloriage pour le voir prendre vie !'
                : stage === 'adjust'
                  ? 'Ajuste les coins de ton coloriage'
                  : 'On scanne ton coloriage…'}
            </p>
          </header>
        ) : (
          <h2>{project.name} — Mode Coloriage</h2>
        )
      )}

      {stage === 'camera' && (
        <CameraView onCapture={onCameraCapture} title={`${project.name} — Mode Coloriage`} />
      )}

      {stage === 'adjust' && capturedBlob && (
        <CornerAdjustment
          imageBlob={capturedBlob}
          initialCorners={detectedCorners}
          onConfirm={onCornersConfirmed}
          onRetake={handleRetake}
        />
      )}

      {stage === 'processing' && (
        <div className={mode === 'play' ? 'scan-processing scan-processing--play' : 'scan-processing'}>
          {mode === 'play' && capturedUrl && !processor.error && (
            <div className="scan-processing-frame">
              <img src={capturedUrl} alt="" />
              <div className="scan-frame-corners" aria-hidden="true"><i /><i /><i /><i /></div>
              <div className="scan-line" aria-hidden="true" />
            </div>
          )}
          {mode === 'play' && !processor.error ? (
            <div className="scan-progress-pill">
              <span className="scan-progress-star" aria-hidden="true">⭐</span>
              Scan en cours…
            </div>
          ) : (
            <div className="loading">
              {processor.error
                ? `Erreur : ${processor.error}`
                : processor.processing
                  ? 'Traitement du scan...'
                  : 'Préparation...'}
            </div>
          )}
          {processor.error && (
            <button className="sketch-btn sketch-btn--go" onClick={handleRetake} style={{ marginTop: 16 }}>
              Réessayer
            </button>
          )}
        </div>
      )}

      {stage === 'debug' && processor.debugImages && (
        <div className="scan-debug" style={{ padding: 16, overflowY: 'auto', maxHeight: '80vh' }}>
          <h3>Debug — Pipeline de scan</h3>

          {(lamaStatus === 'generating-mask' || lamaStatus === 'warmup' || lamaStatus === 'inpainting' || lamaStatus === 'done' || lamaStatus === 'error') && (
            <div style={{
              marginBottom: 16, padding: '10px 16px', borderRadius: 8,
              background: lamaStatus === 'done' ? '#e6f9e6' : lamaStatus === 'error' ? '#fff3cd' : '#e8f4fd',
              border: `1px solid ${lamaStatus === 'done' ? '#7bc67b' : lamaStatus === 'error' ? '#e8a735' : '#8ec8f0'}`,
              fontSize: 14,
            }}>
              {lamaStatus === 'generating-mask' && 'LaMa : Génération du masque...'}
              {lamaStatus === 'warmup' && 'LaMa : Lancement instance...'}
              {lamaStatus === 'inpainting' && 'LaMa : Calcul inpainting...'}
              {lamaStatus === 'done' && 'LaMa : Terminé'}
              {lamaStatus === 'error' && `LaMa : Erreur (fallback Laplacien) — ${lamaError}`}
            </div>
          )}

          <div style={{ marginBottom: 24 }}>
            <h4>1. Photo capturée (brute)</h4>
            <img
              src={processor.debugImages.capturedUrl}
              alt="Photo brute"
              style={{ maxWidth: '100%', maxHeight: 300, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <h4>2. Après correction perspective (2048×2048 avec marges)</h4>
            <img
              src={processor.debugImages.raw2048Url}
              alt="Correction perspective brute"
              style={{ maxWidth: '100%', maxHeight: 300, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <h4>3. Redressée & croppée (dimensions originales)</h4>
            <img
              src={processor.debugImages.rectifiedUrl}
              alt="Redressée croppée"
              style={{ maxWidth: '100%', maxHeight: 300, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <h4>4. Redressée + Triangulation (frame 0)</h4>
            <img
              src={processor.debugImages.meshOverlayUrl}
              alt="Overlay maillage"
              style={{ maxWidth: '100%', maxHeight: 400, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          {lamaStatus !== 'idle' && lamaStatus !== 'not-needed' && (
            <div style={{ marginBottom: 24 }}>
              <h4>5. LaMa Inpainting — Scan sans pattes</h4>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 200px', maxWidth: 400 }}>
                  <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>Masque (zones pattes)</div>
                  {lamaMaskUrl ? (
                    <img
                      src={lamaMaskUrl}
                      alt="Masque LaMa"
                      style={{ width: '100%', maxHeight: 300, objectFit: 'contain', border: '1px solid #999', borderRadius: 8 }}
                    />
                  ) : (
                    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #ccc', borderRadius: 8, color: '#999', fontSize: 13 }}>
                      Génération du masque...
                    </div>
                  )}
                </div>
                <div style={{ flex: '1 1 200px', maxWidth: 400 }}>
                  <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>Résultat inpainting</div>
                  {lamaResultUrl ? (
                    <img
                      src={lamaResultUrl}
                      alt="Résultat LaMa"
                      style={{ width: '100%', maxHeight: 300, objectFit: 'contain', border: '1px solid #999', borderRadius: 8 }}
                    />
                  ) : lamaStatus === 'error' ? (
                    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #e8a735', borderRadius: 8, background: '#fff8e8', color: '#8a6d00', fontSize: 13, padding: 12, textAlign: 'center' }}>
                      Erreur LaMa — fallback Laplacien<br/><span style={{ fontSize: 11, color: '#999' }}>{lamaError}</span>
                    </div>
                  ) : (
                    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #ccc', borderRadius: 8, color: '#999', fontSize: 13 }}>
                      {lamaStatus === 'warmup' ? 'Démarrage instance...' : lamaStatus === 'inpainting' ? 'Calcul inpainting...' : 'En attente...'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {lamaStatus !== 'idle' && lamaStatus !== 'not-needed' && (
            <div style={{ marginBottom: 24 }}>
              <h4>6. Inpainting extensions de pattes</h4>
              {limbExtDebugImages.length === 0 && (
                <div style={{ color: '#999', fontSize: 13, padding: 12, border: '1px dashed #ccc', borderRadius: 8 }}>
                  Aucune face cachee jambe definie. (hiddenFaceLimbZones absent du walk et de projectTriangulation)
                </div>
              )}
              {limbExtDebugImages.map((img, i) => (
                <div key={i} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: '#666', marginBottom: 4, fontWeight: 600 }}>{img.label}</div>
                  <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>Bas = texture scan, haut = inpainting depuis la patte. Contour rouge = zone extension.</div>
                  <img
                    src={img.isolatedUrl}
                    alt={`Patte isolee ${img.label}`}
                    style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain', border: '1px solid #999', borderRadius: 8 }}
                  />
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              onClick={() => setStage('animation')}
              disabled={lamaStatus === 'generating-mask' || lamaStatus === 'warmup' || lamaStatus === 'inpainting' || deferredLoaded === false}
            >
              {deferredLoaded === false
                ? 'Chargement des animations...'
                : lamaStatus === 'warmup' || lamaStatus === 'inpainting'
                  ? 'Inpainting en cours...'
                  : 'Lancer l\'animation'}
            </button>
            <button onClick={handleRetake}>
              Rescanner
            </button>
          </div>
        </div>
      )}

      {stage === 'preview' && processor.rectifiedCanvas && (
        <div className={`scan-validate${landscape ? ' scan-validate--landscape' : ''}`}>
          <Suspense fallback={<div className="loading">Chargement…</div>}>
            <AnimationPlayer
              // Remount au changement d'orientation → PIXI refit la nouvelle taille de conteneur
              key={landscape ? 'ls' : 'pt'}
              project={project}
              scanCanvas={processor.rectifiedCanvas}
              lamaCanvas={lamaCanvas}
              contentAlignment={processor.contentAlignment}
              onClose={handleRetake}
              previewFrame0
              previewAnimated
            />
          </Suspense>
          <div className="scan-validate-name">{project.name}</div>
          <div className="scan-validate-bar">
            <h2 className="scan-validate-title">
              {mode === 'play' ? 'Parfait ! Ton coloriage est prêt !' : 'Tu valides la photo ?'}
            </h2>
            <div className="scan-validate-actions">
              <button
                className="btn-primary btn-lg"
                onClick={() => setStage('animation')}
                disabled={deferredLoaded === false}
              >
                {deferredLoaded === false ? 'Chargement…' : mode === 'play' ? 'Voir mon coloriage prendre vie !' : 'Oui'}
              </button>
              <button className="btn-secondary btn-lg" onClick={handleRetake}>
                {mode === 'play' ? 'Reprendre la photo' : 'Non, je reprends'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Play : la scène se joue désormais en PORTRAIT (canvas carré, pas de plein
          écran ni de lock d'orientation → fiable sur iOS). Plus de RotateDeviceHint. */}
      {stage === 'animation' && (
        <>
          {/* En scène, le ⚙ est intégré dans le ScenePlayer (onSettings).
              Le bouton standalone n'est gardé que pour le fallback AnimationPlayer. */}
          {!(project.scene && project.scene.background && project.scene.restPoint != null) && (
            <SettingsButton onClick={() => setPaused(true)} />
          )}
          {paused && (
            <PauseOverlay
              onContinue={() => setPaused(false)}
              onBack={handleBack}
              backLabel={bookId ? 'Revenir aux coloriages' : 'Quitter'}
            />
          )}
        </>
      )}

      {stage === 'animation' && processor.rectifiedCanvas && (
        // Choix du player basé sur la STRUCTURE de la scène (dispo dès la phase 1),
        // pas sur la présence du blob de fond (chargé en différé). Sinon, en play,
        // on tombe à tort sur AnimationPlayer (mauvais HUD + perso non rendu) tant
        // que le blob n'est pas hydraté. Le blob est garanti chargé au clic « Oui »
        // (bouton gated sur deferredLoaded).
        <Suspense fallback={<div className="loading">Chargement…</div>}>
          {project.scene && !!project.scene.background && project.scene.restPoint != null
            ? <ScenePlayer
                project={project}
                scanCanvas={processor.rectifiedCanvas}
                lamaCanvas={lamaCanvas}
                contentAlignment={processor.contentAlignment}
                onClose={handleRetake}
                onSettings={() => setPaused(true)}
                onExit={handleBack}
              />
            : <AnimationPlayer
                project={project}
                scanCanvas={processor.rectifiedCanvas}
                lamaCanvas={lamaCanvas}
                contentAlignment={processor.contentAlignment}
                onClose={handleRetake}
              />}
        </Suspense>
      )}
    </div>
  )
}

