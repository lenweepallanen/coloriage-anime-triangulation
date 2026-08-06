import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Animation, MeshData, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { detectFootstepFrames } from '../../utils/footstepSync'
import { getSharedAudioContext } from '../../utils/mouthAudioAnalyser'

const FPS = 24

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/**
 * Étape « Bruits de pas » (fin du pipeline marche) : l'admin valide À LA MAIN les
 * frames de contact au sol (bande de frames cliquable, pré-remplie par
 * auto-détection) et attache les sons pas1/pas2 À L'ANIMATION. Pendant la
 * lecture en boucle de la preview, chaque marqueur déclenche un son (alternance
 * pas1/pas2, volume + décalage) → réglage à l'oreille. Le film ne porte plus
 * qu'une case « Jouer les bruits de pas ».
 *
 * Sauvegarde : mesh.footstepFrames/Volume/OffsetMs/Validated +
 * Animation.footstepSound1/2Blob (Storage footstep1|footstep2).
 */
export default function MarcheFootstepsStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation

  const bodyFrames = mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null
  const zoneFrames = mesh?.walkZoneFramesSmoothed ?? mesh?.walkZoneFrames ?? null
  const rawTotal = bodyFrames?.length ?? mesh?.videoFramesMesh?.length ?? 0
  // Cycle VISUEL de la LoopPlayback : les crossfadeFrames de fin sont fondues
  // dans le début (même convention que computeFootstepSchedule).
  const visualTotal = Math.max(1, rawTotal - (mesh?.crossfadeFrames ?? 7))

  const legZoneIds = useMemo(() => Object.keys(zoneFrames ?? {}), [zoneFrames])
  const zoneLabel = useCallback((zid: string) =>
    tri?.zones.find(z => z.id === zid)?.label
    ?? ({ 'leg-fl': 'Patte AVG', 'leg-fr': 'Patte AVD', 'leg-bl': 'Patte ARG', 'leg-br': 'Patte ARD' } as Record<string, string>)[zid]
    ?? zid, [tri])

  // ─── États édition ───
  const [markers, setMarkers] = useState<number[]>(() => [...(mesh?.footstepFrames ?? [])].sort((a, b) => a - b))
  const [sound1, setSound1] = useState<Blob | null>(animation.footstepSound1Blob ?? null)
  const [sound2, setSound2] = useState<Blob | null>(animation.footstepSound2Blob ?? null)
  const [soundNames, setSoundNames] = useState<[string, string]>(['pas 1', 'pas 2'])
  const [volume, setVolume] = useState<number>(mesh?.footstepVolume ?? 1)
  const [offsetMs, setOffsetMs] = useState<number>(mesh?.footstepOffsetMs ?? 0)
  const [detectZones, setDetectZones] = useState<Set<string>>(() => new Set(legZoneIds))
  const [playing, setPlaying] = useState(true)
  const [frame, setFrame] = useState(0)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)

  // Sync des zones cochées si la liste change (nouveau calcul en amont).
  useEffect(() => { setDetectZones(new Set(legZoneIds)) }, [legZoneIds])

  // ─── Audio : décodage des sons + lecture d'un pas ───
  const buffersRef = useRef<(AudioBuffer | null)[]>([null, null])
  const stepCounterRef = useRef(0)
  useEffect(() => {
    let cancelled = false
    const decode = async (blob: Blob | null, slot: 0 | 1) => {
      if (!blob) { buffersRef.current[slot] = null; return }
      try {
        const ctx = getSharedAudioContext()
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
        if (!cancelled) buffersRef.current[slot] = buf
      } catch { buffersRef.current[slot] = null }
    }
    void decode(sound1, 0)
    void decode(sound2, 1)
    return () => { cancelled = true }
  }, [sound1, sound2])

  const volumeRef = useRef(volume)
  volumeRef.current = volume
  const playStepSound = useCallback(() => {
    const bufs = buffersRef.current.filter((b): b is AudioBuffer => b != null)
    if (bufs.length === 0) return
    const buf = bufs[stepCounterRef.current++ % bufs.length]
    const ctx = getSharedAudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buf
    const gain = ctx.createGain()
    source.connect(gain)
    gain.connect(ctx.destination)
    // Un pas = UN impact : attaque max 450 ms, fondu 60 ms (comme le scheduler film).
    const playSec = Math.min(buf.duration, 0.45)
    const now = ctx.currentTime
    gain.gain.setValueAtTime(volumeRef.current, now)
    if (buf.duration > playSec) {
      gain.gain.setValueAtTime(volumeRef.current, now + playSec - 0.06)
      gain.gain.linearRampToValueAtTime(0, now + playSec)
    }
    source.onended = () => { try { gain.disconnect() } catch { /* */ } }
    source.start(now)
    source.stop(now + playSec)
  }, [])

  // ─── Image de fond ───
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const maskW = tri?.maskWidth ?? 1
  const maskH = tri?.maskHeight ?? 1
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImageLoaded(true)
      requestAnimationFrame(() => fitToCanvas(maskW, maskH))
    }
    img.src = url
    return () => {
      imageRef.current = null
      setImageLoaded(false)
      URL.revokeObjectURL(url)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob, maskW, maskH])

  // ─── Boucle preview : temps dans le cycle + déclenchement des pas ───
  const timeRef = useRef(0)              // ms dans le cycle visuel
  const lastTsRef = useRef(0)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const markersRef = useRef(markers)
  markersRef.current = markers
  const offsetRef = useRef(offsetMs)
  offsetRef.current = offsetMs
  const frameRef = useRef(0)
  const animFrameRef = useRef(0)

  const cycleMs = (visualTotal / FPS) * 1000

  const drawFrame = useCallback((f: number) => {
    const canvas = canvasRef.current
    const ctx2d = canvas?.getContext('2d')
    const img = imageRef.current
    if (!canvas || !ctx2d) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
    const t = transformRef.current
    ctx2d.clearRect(0, 0, rect.width, rect.height)
    ctx2d.fillStyle = '#1a1b2e'
    ctx2d.fillRect(0, 0, rect.width, rect.height)
    ctx2d.save()
    ctx2d.translate(t.offsetX, t.offsetY)
    ctx2d.scale(t.scale, t.scale)
    if (img) {
      ctx2d.globalAlpha = 0.25
      ctx2d.drawImage(img, 0, 0, maskW, maskH)
      ctx2d.globalAlpha = 1
    }
    const wire = (points: Point2D[] | undefined, triangles: [number, number, number][] | undefined, color: string) => {
      if (!points || !triangles) return
      ctx2d.strokeStyle = color
      ctx2d.lineWidth = 1 / t.scale
      ctx2d.beginPath()
      for (const [a, b, c] of triangles) {
        const pa = points[a], pb = points[b], pc = points[c]
        if (!pa || !pb || !pc) continue
        ctx2d.moveTo(pa.x, pa.y)
        ctx2d.lineTo(pb.x, pb.y)
        ctx2d.lineTo(pc.x, pc.y)
        ctx2d.closePath()
      }
      ctx2d.stroke()
    }
    if (bodyFrames && tri) {
      wire(bodyFrames[f], tri.bodyTriangles, '#06b6d4')
      if (zoneFrames) {
        const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']
        Object.keys(zoneFrames).forEach((zid, i) => {
          wire(zoneFrames[zid]?.[f], tri.zoneTriangles[zid], palette[i % palette.length])
        })
      }
    } else if (mesh?.videoFramesMesh) {
      wire(mesh.videoFramesMesh[f], mesh.triangles, '#06b6d4')
    }
    ctx2d.restore()
  }, [bodyFrames, zoneFrames, tri, mesh, maskW, maskH, transformRef])

  useEffect(() => {
    const tick = (timestamp: number) => {
      const prevMs = timeRef.current
      if (playingRef.current) {
        const dt = lastTsRef.current ? timestamp - lastTsRef.current : 0
        timeRef.current = (timeRef.current + dt) % cycleMs
        // Déclenchement des pas franchis dans (prev, now] (cyclique), décalage inclus.
        const events = markersRef.current
          .map(f => ((f / FPS) * 1000 + offsetRef.current) % cycleMs)
          .map(e => (e + cycleMs) % cycleMs)
        const now = timeRef.current
        for (const e of events) {
          const crossed = prevMs <= now
            ? (e > prevMs && e <= now)
            : (e > prevMs || e <= now) // wrap de fin de cycle
          if (crossed) playStepSound()
        }
      }
      lastTsRef.current = timestamp
      const f = Math.min(visualTotal - 1, Math.floor((timeRef.current / cycleMs) * visualTotal))
      if (f !== frameRef.current) {
        frameRef.current = f
        setFrame(f)
      }
      drawFrame(frameRef.current)
      animFrameRef.current = requestAnimationFrame(tick)
    }
    animFrameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [cycleMs, visualTotal, drawFrame, playStepSound])

  const seekFrame = (f: number) => {
    const clamped = Math.max(0, Math.min(visualTotal - 1, f))
    timeRef.current = (clamped / visualTotal) * cycleMs
    frameRef.current = clamped
    setFrame(clamped)
  }

  // ─── Marqueurs (bande de frames) ───
  const stripRef = useRef<HTMLDivElement>(null)
  const toggleMarkerAt = (clientX: number) => {
    const strip = stripRef.current
    if (!strip) return
    const rect = strip.getBoundingClientRect()
    const f = Math.max(0, Math.min(visualTotal - 1, Math.floor(((clientX - rect.left) / rect.width) * visualTotal)))
    setMarkers(prev => {
      const near = prev.find(m => Math.abs(m - f) <= 1)
      if (near != null) return prev.filter(m => m !== near)
      return [...prev, f].sort((a, b) => a - b)
    })
  }

  const handleAutoDetect = () => {
    const zoneIds = detectZones.size > 0 && detectZones.size < legZoneIds.length ? [...detectZones] : undefined
    const detected = detectFootstepFrames(animation, zoneIds).filter(f => f < visualTotal)
    setMarkers(detected.sort((a, b) => a - b))
  }

  // ─── Import / retrait des sons ───
  const importSound = (slot: 0 | 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (slot === 0) setSound1(file); else setSound2(file)
    setSoundNames(prev => slot === 0 ? [file.name, prev[1]] : [prev[0], file.name])
  }

  // ─── Sauvegarde ───
  async function handleValidate() {
    if (!mesh) return
    setSaving(true)
    try {
      const updatedMesh: MeshData = {
        ...mesh,
        footstepFrames: [...markers].sort((a, b) => a - b),
        footstepVolume: volume,
        footstepOffsetMs: offsetMs,
        footstepValidated: true,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id
          ? { ...a, mesh: updatedMesh, footstepSound1Blob: sound1, footstepSound2Blob: sound2 }
          : a,
      )
      const hints: UploadHint[] = []
      if (sound1) hints.push({ animationId: animation.id, field: 'footstep1' })
      if (sound2) hints.push({ animationId: animation.id, field: 'footstep2' })
      await onSave({ ...project, animations: updatedAnims }, hints)
      setSavedAt(new Date().toLocaleTimeString())
    } finally {
      setSaving(false)
    }
  }

  if (!mesh || rawTotal === 0) {
    return (
      <div style={{ padding: 20, color: '#9ca3af' }}>
        Calcule d'abord l'animation (étapes <strong>LBS</strong> / <strong>Calcul Animation</strong>) avant de régler les bruits de pas.
      </div>
    )
  }

  const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }
  const LBL: React.CSSProperties = { fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      {/* ─── Preview + bande de frames ─── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            aspectRatio: `${maskW} / ${maskH}`,
            maxHeight: '58vh',
            display: 'block',
            borderRadius: 8,
          }}
        />
        <div style={ROW}>
          <button className="btn-sm btn-secondary" onClick={() => {
            const ctx = getSharedAudioContext()
            if (ctx.state === 'suspended') void ctx.resume()
            setPlaying(p => !p)
          }}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <input
            type="range" min={0} max={visualTotal - 1} step={1}
            value={frame}
            onChange={e => { setPlaying(false); seekFrame(parseInt(e.target.value, 10)) }}
            style={{ flex: 1, minWidth: 120 }}
          />
          <span style={{ ...LBL, width: 90, textAlign: 'right' }}>
            Frame {frame} / {visualTotal - 1}
          </span>
        </div>
        {/* Bande de frames : clic = ajouter/retirer un marqueur de contact */}
        <div
          ref={stripRef}
          onClick={(e) => toggleMarkerAt(e.clientX)}
          title="Clic : ajouter/retirer un marqueur de contact au sol à cette frame"
          style={{ position: 'relative', height: 46, background: '#111827', border: '1px solid #374151', borderRadius: 8, cursor: 'crosshair', userSelect: 'none', overflow: 'hidden' }}
        >
          {/* Playhead */}
          <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, background: '#3b82f6', left: `${((frame + 0.5) / visualTotal) * 100}%`, pointerEvents: 'none' }} />
          {markers.map(f => (
            <div
              key={f}
              onClick={(e) => { e.stopPropagation(); setMarkers(prev => prev.filter(m => m !== f)) }}
              title={`Contact frame ${f} — cliquer pour retirer`}
              style={{
                position: 'absolute', top: 4, bottom: 4, width: 10,
                left: `${((f + 0.5) / visualTotal) * 100}%`, transform: 'translateX(-50%)',
                background: '#f59e0b', borderRadius: 3, cursor: 'pointer',
              }}
            />
          ))}
        </div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>
          {markers.length} contact(s)/cycle aux frames [{markers.join(', ')}] — cycle {visualTotal} frames ≈ {Math.round(cycleMs)} ms.
          Pendant la lecture, chaque marqueur joue un son (alternance pas 1 / pas 2).
        </div>
      </div>

      {/* ─── Panneau réglages ─── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Bruits de pas 🦶</h3>

        {legZoneIds.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={LBL} title="Pattes qui PORTENT (contact au sol). Bipède type T-Rex : cochez uniquement les pattes ARRIÈRE.">
              Pattes au sol (auto-détection)
            </span>
            <div style={ROW}>
              {legZoneIds.map(zid => (
                <label key={zid} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={detectZones.has(zid)}
                    onChange={(e) => setDetectZones(prev => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(zid); else next.delete(zid)
                      return next
                    })}
                  />
                  {zoneLabel(zid)}
                </label>
              ))}
            </div>
          </div>
        )}
        <button className="btn-sm btn-secondary" onClick={handleAutoDetect}>
          ⚙ Auto-détecter les contacts
        </button>

        {/* Sons pas 1 / pas 2 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LBL}>Sons (alternés)</span>
          <div style={ROW}>
            {([0, 1] as const).map(slot => {
              const blob = slot === 0 ? sound1 : sound2
              return blob ? (
                <span key={slot} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, border: '1px solid #374151', borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                  🦶{slot + 1} <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{soundNames[slot]}</span>
                  <button
                    className="btn-icon btn-sm btn-danger"
                    onClick={() => { if (slot === 0) setSound1(null); else setSound2(null) }}
                    title="Retirer ce son"
                  >&times;</button>
                </span>
              ) : (
                <label key={slot} className="btn-secondary btn-sm" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  + pas{slot + 1}.mp3
                  <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={importSound(slot)} />
                </label>
              )
            })}
          </div>
        </div>

        <div style={ROW}>
          <span style={LBL}>Volume : {Math.round(volume * 100)}%</span>
          <input
            type="range" min={0} max={1} step={0.05}
            value={volume}
            onChange={e => setVolume(parseFloat(e.target.value))}
            style={{ flex: 1, minWidth: 100 }}
          />
        </div>
        <div style={ROW}>
          <span style={LBL} title="Négatif = le son part plus tôt, positif = plus tard">Décalage (ms)</span>
          <input
            type="number" step={10}
            value={offsetMs}
            onChange={e => {
              const v = parseInt(e.target.value, 10)
              setOffsetMs(Number.isFinite(v) ? v : 0)
            }}
            style={{ width: 90, flexShrink: 0 }}
          />
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '4px 0' }} />

        <button className="btn-primary" onClick={handleValidate} disabled={saving} style={{ width: '100%' }}>
          {saving ? 'Sauvegarde…' : 'Valider'}
        </button>
        {savedAt && (
          <span style={{ color: '#22c55e', fontSize: 12 }}>✓ Sauvegardé à {savedAt}</span>
        )}
        {mesh.footstepValidated && !savedAt && (
          <span style={{ color: '#22c55e', fontSize: 12 }}>✓ Bruits de pas déjà validés</span>
        )}
        {!imageLoaded && !project.originalImageBlob && (
          <span style={{ fontSize: 11, opacity: 0.6 }}>Image du coloriage absente — preview wireframe seule.</span>
        )}
      </div>
    </div>
  )
}
