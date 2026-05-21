import { useState, useMemo } from 'react'
import { useAdminContext } from './AdminLayout'
import type { Prop, Project } from '../../types/project'
import PropContourStep from '../../components/admin/PropContourStep'
import PropAttachmentStep from '../../components/admin/PropAttachmentStep'
import PropSettingsStep from '../../components/admin/PropSettingsStep'

const STEPS = ['Contour', 'Attachement', 'Réglages'] as const
type PropStep = (typeof STEPS)[number]

function getStepStatus(step: PropStep, activeStep: PropStep, prop: Prop): 'done' | 'active' | 'pending' {
  if (step === activeStep) return 'active'
  switch (step) {
    case 'Contour': return prop.contourParts.length > 0 ? 'done' : 'pending'
    case 'Attachement': return prop.contourParts.length > 0 ? 'done' : 'pending'
    case 'Réglages': return prop.contourParts.length > 0 ? 'done' : 'pending'
    default: return 'pending'
  }
}

function makeEmptyProp(): Prop {
  return {
    id: crypto.randomUUID(),
    name: 'Accessoire',
    contourParts: [],
    attachment: { mode: 'fixed' },
    offset: { x: 0, y: 0 },
    scale: 1,
    zOrder: 1,
    createdAt: Date.now(),
  }
}

export default function PropsSection() {
  const { project, save } = useAdminContext()
  const [selectedId, setSelectedId] = useState<string | null>(project.props[0]?.id ?? null)
  const [activeStep, setActiveStep] = useState<PropStep>('Contour')

  const selected = useMemo(
    () => project.props.find(p => p.id === selectedId) ?? null,
    [project.props, selectedId],
  )

  const tri = project.projectTriangulation
  const step1Done = tri?.step1Validated === true
  const step3Done = tri?.step3Validated === true

  if (!step1Done) {
    return (
      <div className="props-warning">
        Validez d’abord l’étape <strong>Zones</strong> de la Triangulation projet pour gérer les accessoires.
      </div>
    )
  }

  async function handleAddProp() {
    const next = makeEmptyProp()
    const updated: Project = { ...project, props: [...project.props, next] }
    await save(updated)
    setSelectedId(next.id)
    setActiveStep('Contour')
  }

  async function handleDeleteProp(id: string) {
    if (!confirm('Supprimer cet accessoire ?')) return
    const updated: Project = { ...project, props: project.props.filter(p => p.id !== id) }
    await save(updated)
    if (selectedId === id) setSelectedId(updated.props[0]?.id ?? null)
  }

  async function handleUpdateProp(next: Prop) {
    const updated: Project = {
      ...project,
      props: project.props.map(p => (p.id === next.id ? next : p)),
    }
    await save(updated)
  }

  async function handleRename(id: string, name: string) {
    const found = project.props.find(p => p.id === id)
    if (!found) return
    await handleUpdateProp({ ...found, name })
  }

  return (
    <div className="props-section">
      {!step3Done && (
        <div className="props-warning" style={{ position: 'absolute', top: 8, right: 8, maxWidth: 360, fontSize: '0.85rem', zIndex: 10 }}>
          ⚠️ Pour les modes <strong>« suit 1/2 anchors »</strong>, validez d’abord la Triangulation projet
          jusqu’aux Faces cachées (étape 4) pour disposer des anchors par zone.
        </div>
      )}
      <aside className="props-sidebar">
        <div className="props-sidebar-header">
          <h3>Accessoires</h3>
          <button className="btn btn-primary btn-sm" onClick={handleAddProp}>+ Nouveau</button>
        </div>
        {project.props.length === 0 && (
          <p className="props-empty">Aucun accessoire. Cliquez sur « + Nouveau » pour en créer un.</p>
        )}
        <ul className="props-list">
          {project.props.map(p => {
            const isTri = p.source === 'triangulation'
            return (
              <li
                key={p.id}
                className={`props-list-item ${p.id === selectedId ? 'props-list-item--active' : ''}`}
                onClick={() => setSelectedId(p.id)}
                title={isTri ? 'Accessoire issu de la Triangulation projet (suppression/rename via la zone d’origine)' : undefined}
              >
                {isTri && <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>🔗</span>}
                <input
                  className="props-list-name"
                  value={p.name}
                  onChange={e => handleRename(p.id, e.target.value)}
                  onClick={e => e.stopPropagation()}
                  disabled={isTri}
                />
                {!isTri && (
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={e => { e.stopPropagation(); handleDeleteProp(p.id) }}
                    title="Supprimer"
                  >×</button>
                )}
              </li>
            )
          })}
        </ul>
      </aside>

      <div className="props-main">
        {!selected && (
          <p className="props-empty">Sélectionnez un accessoire ou créez-en un.</p>
        )}
        {selected && (
          <>
            <nav className="pipeline-stepper">
              {STEPS.map((step, i) => {
                const status = getStepStatus(step, activeStep, selected)
                return (
                  <button
                    key={step}
                    className={`pipeline-step pipeline-step--${status}`}
                    onClick={() => setActiveStep(step)}
                  >
                    <span className="pipeline-step-content">
                      <span className="pipeline-step-circle">
                        {status === 'done' ? '✓' : i + 1}
                      </span>
                      <span className="pipeline-step-label">{step}</span>
                    </span>
                    {i < STEPS.length - 1 && <span className="pipeline-step-connector" />}
                  </button>
                )
              })}
            </nav>

            <div className="pipeline-step-content-area">
              {activeStep === 'Contour' && (
                <PropContourStep project={project} prop={selected} onSave={handleUpdateProp} />
              )}
              {activeStep === 'Attachement' && (
                <PropAttachmentStep project={project} prop={selected} onSave={handleUpdateProp} />
              )}
              {activeStep === 'Réglages' && (
                <PropSettingsStep project={project} prop={selected} onSave={handleUpdateProp} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
