import type { Film, FilmPlan } from '../../../types/project'
import { transitionToKey } from './filmEditorShared'

/**
 * Storyboard du film : bandeau des plans (cartes réordonnables) avec le sélecteur
 * de transition ENTRE les cartes, + gestion du décor du plan actif
 * (arrière-plan obligatoire, avant-plan chroma optionnel).
 */
export default function FilmStoryboard({
  film, plan, onSelectPlan, onAddPlan, onMovePlan, onRemovePlan, onRenamePlan,
  onTransitionChange, onImportDecor, onRemoveOverlay, onPreviewPlan,
}: {
  film: Film
  plan: FilmPlan
  onSelectPlan: (id: string) => void
  /** Prévisualiser UNIQUEMENT ce plan (sans rejouer le reste du film). */
  onPreviewPlan: (id: string) => void
  onAddPlan: () => void
  onMovePlan: (id: string, dir: -1 | 1) => void
  onRemovePlan: (id: string) => void
  onRenamePlan: (id: string, name: string) => void
  onTransitionChange: (planId: string, key: string, durationMs?: number) => void
  onImportDecor: (file: File, kind: 'backdrop' | 'overlay') => void
  onRemoveOverlay: () => void
}) {
  const plans = film.plans
  const planIndex = plans.findIndex(pl => pl.id === plan.id)
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Plans du film</div>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 6 }}>
        Un plan = une séquence du film (au sens cinéma) : son décor, son cadrage caméra et son chemin de points.
        Enchaînez plusieurs plans avec des transitions pour raconter une histoire.
      </div>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
        {plans.map((pl, i) => {
          const active = pl.id === plan.id
          return (
            <div key={pl.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                onClick={() => onSelectPlan(pl.id)}
                style={{
                  border: active ? '2px solid var(--color-primary, #42a5f5)' : '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 8,
                  minWidth: 140,
                  cursor: 'pointer',
                  background: active ? 'rgba(66,165,245,0.08)' : 'transparent',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 12 }}>🎬 {i + 1}</span>
                  <input
                    value={pl.name ?? ''}
                    placeholder={`Plan ${i + 1}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onRenamePlan(pl.id, e.target.value)}
                    style={{ width: 80, fontSize: 12, border: 'none', background: 'transparent', borderBottom: '1px dashed var(--border)' }}
                  />
                </div>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  {pl.points.length} point{pl.points.length > 1 ? 's' : ''}
                  {pl.backdrop == null && <span style={{ color: 'var(--color-warning, #ffa726)' }}> · sans décor</span>}
                  {pl.backdrop != null && pl.points.length === 0 && (
                    <span style={{ color: 'var(--color-warning, #ffa726)' }} title="Un plan sans point est IGNORÉ à la lecture — posez au moins un point du chemin."> · ignoré (0 point)</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn-icon btn-sm"
                    onClick={() => onPreviewPlan(pl.id)}
                    disabled={pl.backdrop == null || pl.points.length === 0}
                    title="Prévisualiser CE plan uniquement"
                  >▶</button>
                  <button className="btn-icon btn-sm" onClick={() => onMovePlan(pl.id, -1)} disabled={i === 0} title="Plan plus tôt">◀</button>
                  <button className="btn-icon btn-sm" onClick={() => onMovePlan(pl.id, +1)} disabled={i === plans.length - 1} title="Plan plus tard">▶</button>
                  <button className="btn-icon btn-sm btn-danger" onClick={() => onRemovePlan(pl.id)} disabled={plans.length <= 1} title="Supprimer le plan">&times;</button>
                </div>
              </div>
              {i < plans.length - 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title="Transition vers le plan suivant">
                  <span style={{ fontSize: 14 }}>→</span>
                  <select
                    value={transitionToKey(pl.transitionToNext)}
                    onChange={(e) => {
                      const cur = pl.transitionToNext
                      const durationMs = cur && cur.kind !== 'cut' ? cur.durationMs : undefined
                      onTransitionChange(pl.id, e.target.value, durationMs)
                    }}
                    style={{ fontSize: 11 }}
                  >
                    <option value="cut">Cut</option>
                    <option value="fadeBlack">Fondu noir</option>
                    <option value="crossfade">Fondu enchaîné</option>
                    <option value="wipe-left">Volet ←</option>
                    <option value="wipe-right">Volet →</option>
                    <option value="wipe-up">Volet ↑</option>
                    <option value="wipe-down">Volet ↓</option>
                    <option value="iris">Iris</option>
                  </select>
                  {pl.transitionToNext && pl.transitionToNext.kind !== 'cut' && (
                    <input
                      type="number" min={0.1} step={0.1}
                      placeholder={pl.transitionToNext.kind === 'iris' ? '0.7' : '0.5'}
                      value={pl.transitionToNext.durationMs != null ? pl.transitionToNext.durationMs / 1000 : ''}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        const ms = Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : undefined
                        onTransitionChange(pl.id, transitionToKey(pl.transitionToNext), ms)
                      }}
                      style={{ width: 52, fontSize: 11 }}
                      title="Durée de la transition (s)"
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
        <button className="btn-secondary btn-sm" onClick={onAddPlan} style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>+ Plan</button>
      </div>

      {/* Décor du plan actif : arrière-plan (obligatoire) + avant-plan (optionnel) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Décor du plan {planIndex + 1} :</span>
        <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          {plan.backdrop ? 'Changer l’arrière-plan' : 'Importer l’arrière-plan'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onImportDecor(file, 'backdrop')
            }}
          />
        </label>
        {plan.backdrop && (
          <>
            <span className="scene-editor-dimensions">
              {plan.backdrop.width}×{plan.backdrop.height}{plan.backdrop.videoBlob ? ' (vidéo)' : ''}
            </span>
            <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }} title="Calque devant le personnage (PNG transparent ou vidéo chroma key)">
              {plan.overlay ? 'Changer l’avant-plan' : '+ Avant-plan'}
              <input
                type="file"
                accept="image/png,image/webp,video/mp4,video/webm"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) onImportDecor(file, 'overlay')
                }}
              />
            </label>
            {plan.overlay && (
              <button className="btn-icon btn-sm btn-danger" onClick={onRemoveOverlay} title="Retirer l’avant-plan du plan">FG &times;</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
