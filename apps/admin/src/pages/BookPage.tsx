import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getBook, getAllBooks, updateBook, deleteBook, duplicateProjectIntoBook } from '../db/booksStore'
import { getProjectsByBook, getProjectCardThumbnail, setProjectBook, duplicateProject } from '../db/projectsStore'
import { buildBookPlayUrl, buildBookPlayUrlLocal, setBookPublished } from '../db/publishProject'
import { downloadQrPng } from '../utils/qrGenerator'
import type { Book, Project } from '../types/project'

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [book, setBook] = useState<Book | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)

  /** Message de confirmation éphémère sous le titre de la liste (envoi / copie). */
  function flash(message: string) {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000)
  }
  const [name, setName] = useState('')
  const [amazonUrl, setAmazonUrl] = useState('')
  const [bonusUrl, setBonusUrl] = useState('')
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [bonusImgUrl, setBonusImgUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bookId) return
    load()
  }, [bookId])

  async function load() {
    if (!bookId) return
    setLoading(true)
    try {
      const [b, ps, all] = await Promise.all([getBook(bookId), getProjectsByBook(bookId), getAllBooks()])
      if (!b) {
        alert('Livre introuvable')
        navigate('/')
        return
      }
      setBook(b)
      setName(b.name)
      setAmazonUrl(b.amazonUrl || 'amazon.com')
      setBonusUrl(b.bonusUrl || 'amazon.com')
      setProjects(ps)
      setBooks(all.sort((x, y) => x.name.localeCompare(y.name, 'fr')))
      if (b.coverImageBlob) setCoverUrl(URL.createObjectURL(b.coverImageBlob))
      if (b.bonusImageBlob) setBonusImgUrl(URL.createObjectURL(b.bonusImageBlob))
    } catch (err) {
      alert('Erreur chargement : ' + (err instanceof Error ? err.message : err))
    }
    setLoading(false)
  }

  async function handleRename() {
    if (!book) return
    const next = name.trim()
    if (!next || next === book.name) return
    try {
      await updateBook({ ...book, name: next })
      setBook({ ...book, name: next })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleSaveAmazon() {
    if (!book) return
    const next = amazonUrl.trim()
    if (next === (book.amazonUrl || '')) return
    try {
      await updateBook({ ...book, amazonUrl: next })
      setBook({ ...book, amazonUrl: next })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleCoverUpload(file: File) {
    if (!book) return
    try {
      const next = { ...book, coverImageBlob: file }
      await updateBook(next, ['cover'])
      setBook(next)
      if (coverUrl) URL.revokeObjectURL(coverUrl)
      setCoverUrl(URL.createObjectURL(file))
    } catch (err) {
      alert('Erreur upload cover : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleSaveBonusUrl() {
    if (!book) return
    const next = bonusUrl.trim()
    if (next === (book.bonusUrl || '')) return
    try {
      await updateBook({ ...book, bonusUrl: next })
      setBook({ ...book, bonusUrl: next })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleBonusUpload(file: File) {
    if (!book) return
    try {
      const next = { ...book, bonusImageBlob: file }
      await updateBook(next, ['bonus'])
      setBook(next)
      if (bonusImgUrl) URL.revokeObjectURL(bonusImgUrl)
      setBonusImgUrl(URL.createObjectURL(file))
    } catch (err) {
      alert('Erreur upload bonus : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleTogglePublish() {
    if (!book || busy) return
    setBusy(true)
    try {
      const next = !book.published
      await setBookPublished(book.id, next)
      setBook({ ...book, published: next, publishedAt: next ? Date.now() : book.publishedAt })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleUnlisted() {
    if (!book || busy) return
    setBusy(true)
    try {
      const next = !book.unlisted
      await updateBook({ ...book, unlisted: next })
      setBook({ ...book, unlisted: next })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyUrl() {
    if (!book) return
    try {
      await navigator.clipboard.writeText(buildBookPlayUrl(book.id))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  async function handleDelete() {
    if (!book) return
    if (!confirm(`Supprimer le livre "${book.name}" ? Les coloriages seront détachés (pas supprimés).`)) return
    try {
      await deleteBook(book.id)
      navigate('/')
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  const [draggedId, setDraggedId] = useState<string | null>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map())

  // FLIP animation : glissement fluide des cards à chaque réordonnement
  useLayoutEffect(() => {
    cardRefs.current.forEach((el, id) => {
      const next = el.getBoundingClientRect()
      const prev = prevRectsRef.current.get(id)
      if (prev) {
        const dx = prev.left - next.left
        const dy = prev.top - next.top
        if (dx !== 0 || dy !== 0) {
          el.style.transition = 'none'
          el.style.transform = `translate(${dx}px, ${dy}px)`
          requestAnimationFrame(() => {
            el.style.transition = 'transform 250ms cubic-bezier(.2,.8,.2,1)'
            el.style.transform = ''
          })
        }
      }
      prevRectsRef.current.set(id, next)
    })
  }, [projects])

  async function persistOrder(list: Project[]) {
    // Reattribue bookOrder = index pour chaque projet et persiste.
    await Promise.all(list.map((p, i) => setProjectBook(p.id, book!.id, i)))
  }

  function handleReorder(targetId: string) {
    if (!draggedId || draggedId === targetId) return
    const from = projects.findIndex(p => p.id === draggedId)
    const to = projects.findIndex(p => p.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...projects]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setProjects(next)
    persistOrder(next).catch(err => alert('Erreur ordre : ' + (err instanceof Error ? err.message : err)))
  }

  async function handleRemoveProject(projectId: string) {
    if (!confirm('Retirer ce coloriage du livre ?')) return
    try {
      await setProjectBook(projectId, null)
      setProjects(prev => prev.filter(p => p.id !== projectId))
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)

  /** Duplique un coloriage DANS le livre, inséré juste après l'original. */
  async function handleDuplicateProject(sourceId: string) {
    if (!book || duplicatingId) return
    setDuplicatingId(sourceId)
    try {
      const dup = await duplicateProject(sourceId, { bookId: book.id })
      const idx = projects.findIndex(p => p.id === sourceId)
      const next = [...projects]
      next.splice(idx < 0 ? next.length : idx + 1, 0, dup)
      setProjects(next)
      // Normalise les bookOrder (0..n-1) pour ancrer le duplicata à côté de l'original.
      await persistOrder(next)
    } catch (err) {
      alert('Erreur duplication : ' + (err instanceof Error ? err.message : err))
    } finally {
      setDuplicatingId(null)
    }
  }

  /** Envoie le coloriage dans un autre livre : retiré d'ici, ajouté à la fin du livre cible. */
  async function handleMoveToBook(projectId: string, targetBookId: string) {
    if (!book || targetBookId === book.id) return
    const target = books.find(b => b.id === targetBookId)
    const proj = projects.find(p => p.id === projectId)
    try {
      await setProjectBook(projectId, targetBookId)
      setProjects(prev => prev.filter(p => p.id !== projectId))
      flash(`« ${proj?.name ?? 'Coloriage'} » envoyé dans « ${target?.name ?? 'livre'} ».`)
    } catch (err) {
      alert('Erreur envoi : ' + (err instanceof Error ? err.message : err))
    }
  }

  /** Duplique le coloriage et envoie la copie dans le livre choisi (ou hors livre). L'original reste ici. */
  async function handleDuplicateToBook(sourceId: string, targetBookId: string | null) {
    if (!book || duplicatingId) return
    if (targetBookId === book.id) { await handleDuplicateProject(sourceId); return }
    setDuplicatingId(sourceId)
    const target = books.find(b => b.id === targetBookId)
    const proj = projects.find(p => p.id === sourceId)
    try {
      await duplicateProjectIntoBook(sourceId, targetBookId)
      flash(`Copie de « ${proj?.name ?? 'coloriage'} » envoyée ${target ? `dans « ${target.name} »` : 'hors livre'}.`)
    } catch (err) {
      alert('Erreur duplication : ' + (err instanceof Error ? err.message : err))
    } finally {
      setDuplicatingId(null)
    }
  }

  if (loading || !book) return <div className="loading">Chargement...</div>

  const url = buildBookPlayUrl(book.id)
  const localUrl = buildBookPlayUrlLocal(book.id)

  return (
    <div className="home-page">
      <nav aria-label="Fil d'Ariane" className="admin-breadcrumb" style={{ padding: '12px 0 16px' }}>
        <Link to="/" className="admin-breadcrumb-link" title="Menu principal">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 11l9-8 9 8" />
            <path d="M5 10v10h14V10" />
          </svg>
        </Link>
        <span className="admin-breadcrumb-sep">›</span>
        <span className="admin-breadcrumb-current">{book.name}</span>
      </nav>

      <section className="create-project-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            style={{ fontSize: 'var(--text-2xl, 24px)', fontWeight: 600 }}
          />
          <button className="btn-icon btn-sm" onClick={handleDelete} title="Supprimer" style={{ color: 'var(--color-danger)' }}>
            ✕
          </button>
        </div>
      </section>

      <section className="create-project-section">
        <h3>Couverture du livre</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {coverUrl ? (
            <img src={coverUrl} alt="cover" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }} />
          ) : (
            <div style={{ width: 120, height: 120, background: '#f0f0f0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>📚</div>
          )}
          <label className="btn-secondary">
            {coverUrl ? 'Remplacer' : 'Importer'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleCoverUpload(f) }}
            />
          </label>
        </div>
      </section>

      <section className="create-project-section">
        <h3>Lien Amazon</h3>
        <input
          type="url"
          value={amazonUrl}
          onChange={e => setAmazonUrl(e.target.value)}
          onBlur={handleSaveAmazon}
          onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          placeholder="amazon.com"
          style={{ width: '100%', maxWidth: 480 }}
        />
      </section>

      <section className="create-project-section">
        <h3>Bonus à télécharger</h3>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#666', marginBottom: 4 }}>Lien bonus</label>
          <input
            type="url"
            value={bonusUrl}
            onChange={e => setBonusUrl(e.target.value)}
            onBlur={handleSaveBonusUrl}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            placeholder="amazon.com"
            style={{ width: '100%', maxWidth: 480 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: '#666', marginBottom: 4 }}>Vignette bonus</label>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {bonusImgUrl ? (
              <img src={bonusImgUrl} alt="bonus" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }} />
            ) : (
              <div style={{ width: 120, height: 120, background: '#f0f0f0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎁</div>
            )}
            <label className="btn-secondary">
              {bonusImgUrl ? 'Remplacer' : 'Importer'}
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleBonusUpload(f) }}
              />
            </label>
          </div>
        </div>
      </section>

      <section className="create-project-section">
        <h3>Publication</h3>
        <div style={{
          border: '1px solid var(--color-border, #e0e0e0)',
          borderRadius: 8,
          padding: 16,
          background: book.published ? '#e8f5e9' : '#fff8e1',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong>{book.published ? '✓ Publié' : '⚠ Non publié'}</strong>
            <button onClick={handleTogglePublish} disabled={busy} className="btn-secondary">
              {busy ? '…' : book.published ? 'Dépublier' : 'Publier'}
            </button>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, fontSize: 13, lineHeight: 1.4 }}>
            <input type="checkbox" checked={book.unlisted} disabled={busy} onChange={handleToggleUnlisted} style={{ marginTop: 2 }} />
            <span>
              <strong>Non listé (review)</strong> — le livre reste publié et ajoutable par son QR,
              mais il est masqué des grilles publiques (« LES AUTRES LIVRES », livres liés).
              Utile pour un livre de test réviseur qu'on ne partage pas au public.
            </span>
          </label>
          {book.published && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Lien USER du livre (prod) :</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '6px 10px', background: '#fff', borderRadius: 4, fontSize: 13, overflow: 'auto' }}>
                  {url}
                </code>
                <button onClick={handleCopyUrl} className="btn-sm btn-secondary">
                  {copied ? 'Copié !' : 'Copier'}
                </button>
                <button
                  onClick={() => downloadQrPng(url, `livre-${book.name.replace(/[^\w-]+/g, '_')}-qr.png`).catch(e => alert('Échec QR : ' + e))}
                  className="btn-sm btn-secondary"
                  title="Télécharger le QR code à imprimer au début du livre (ajout du livre dans l'app)"
                >
                  QR code
                </button>
              </div>
              <div style={{ fontSize: 12, color: '#666', margin: '12px 0 4px' }}>Aperçu local (dev) :</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '6px 10px', background: '#fff', borderRadius: 4, fontSize: 13, overflow: 'auto' }}>
                  {localUrl}
                </code>
                <a href={localUrl} target="_blank" rel="noreferrer" className="btn-sm btn-secondary">
                  Ouvrir
                </a>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="project-list">
        <h2>Coloriages dans ce livre ({projects.length})</h2>
        {notice && (
          <p role="status" style={{ margin: '0 0 12px', padding: '8px 12px', borderRadius: 8, background: '#e8f5e9', color: '#1b5e20', fontSize: 13 }}>
            ✓ {notice}
          </p>
        )}
        {projects.length === 0 ? (
          <p className="empty-state">Aucun coloriage dans ce livre. Depuis la page d'accueil, utilisez le menu "⋯" d'un coloriage pour le déplacer ici.</p>
        ) : (
          <div className="project-grid">
            {projects.map(p => (
              <BookProjectCard
                key={p.id}
                project={p}
                books={books}
                currentBookId={book.id}
                onRemove={() => handleRemoveProject(p.id)}
                onDuplicate={() => handleDuplicateProject(p.id)}
                onMoveToBook={targetId => handleMoveToBook(p.id, targetId)}
                onDuplicateToBook={targetId => handleDuplicateToBook(p.id, targetId)}
                duplicating={duplicatingId === p.id}
                duplicateDisabled={duplicatingId != null}
                isDragging={draggedId === p.id}
                onDragStart={() => setDraggedId(p.id)}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={handleReorder}
                registerRef={el => {
                  if (el) cardRefs.current.set(p.id, el)
                  else cardRefs.current.delete(p.id)
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function BookProjectCard({ project, books, currentBookId, onRemove, onDuplicate, onMoveToBook, onDuplicateToBook, duplicating, duplicateDisabled, isDragging, onDragStart, onDragEnd, onDragOver, registerRef }: {
  project: Project
  /** Tous les livres (pour envoyer / dupliquer vers un autre livre). */
  books: Book[]
  currentBookId: string
  onRemove: () => void
  onDuplicate: () => void
  /** Envoie le coloriage dans un autre livre (il quitte celui-ci). */
  onMoveToBook: (targetBookId: string) => void
  /** Duplique et envoie la copie dans le livre choisi (null = hors livre). */
  onDuplicateToBook: (targetBookId: string | null) => void
  /** true pendant que CE coloriage est en cours de duplication. */
  duplicating: boolean
  /** true si une duplication est en cours quelque part (désactive le bouton). */
  duplicateDisabled: boolean
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (targetId: string) => void
  registerRef: (el: HTMLDivElement | null) => void
}) {
  const navigate = useNavigate()
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const otherBooks = books.filter(b => b.id !== currentBookId)

  useEffect(() => {
    let revoke: string | null = null
    getProjectCardThumbnail(project).then(blob => {
      if (blob) {
        const url = URL.createObjectURL(blob)
        revoke = url
        setThumbUrl(url)
      }
    })
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [project.id, project.hasThumbnail])

  useEffect(() => {
    if (!menuOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const menuItemStyle = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' } as const

  return (
    <div
      ref={registerRef}
      className="project-card"
      onClick={() => navigate(`/admin/${project.id}`)}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
      onDragEnd={onDragEnd}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver(project.id) }}
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: isDragging ? 'grabbing' : 'grab',
        boxShadow: isDragging ? '0 10px 24px rgba(0,0,0,0.18)' : undefined,
        zIndex: isDragging ? 2 : 1,
      }}
    >
      <div className="project-thumb">
        {thumbUrl ? <img src={thumbUrl} alt={project.name} /> : <div className="no-thumb">Pas d'image</div>}
      </div>
      <div className="project-info">
        <h3>{project.name}</h3>
        <div className="project-meta">
          <span className="project-date">{new Date(project.createdAt).toLocaleDateString('fr-FR')}</span>
          {project.published && <span style={{ color: 'green', fontSize: 12 }}>publié</span>}
        </div>
      </div>
      <div className="project-actions">
        <button className="btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/admin/${project.id}`) }}>
          Editer
        </button>
        <button
          className="btn-icon btn-sm"
          onClick={e => { e.stopPropagation(); onDuplicate() }}
          disabled={duplicateDisabled}
          title="Dupliquer (copie insérée juste à côté)"
        >
          {duplicating ? '…' : '⧉'}
        </button>
        <button className="btn-icon btn-sm" onClick={e => { e.stopPropagation(); onRemove() }} title="Retirer du livre">
          ⨯
        </button>
        <button
          className="btn-icon btn-sm"
          onClick={e => { e.stopPropagation(); setMenuOpen(true) }}
          disabled={duplicateDisabled}
          title="Envoyer vers un autre livre / dupliquer vers un livre"
        >
          ⋯
        </button>
        {menuOpen && createPortal(
          <div
            onClick={e => { e.stopPropagation(); setMenuOpen(false) }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 9999,
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: '#1c1f26', color: '#e6e6e6',
                border: '1px solid #2d3340', borderRadius: 12,
                padding: 20, minWidth: 320, maxWidth: 'min(92vw, 440px)', maxHeight: '80vh', overflowY: 'auto',
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</strong>
                <button className="btn-icon btn-sm" onClick={() => setMenuOpen(false)} style={{ flexShrink: 0 }}>✕</button>
              </div>

              <div style={{ fontSize: 12, color: '#9aa3b2', margin: '12px 0 4px' }}>Envoyer vers un autre livre… (il quitte ce livre)</div>
              {otherBooks.length === 0 && (
                <div style={{ fontSize: 12, color: '#6b7280', padding: '4px 8px' }}>Aucun autre livre. Créez-en un depuis l'accueil.</div>
              )}
              {otherBooks.map(b => (
                <button
                  key={`move-${b.id}`}
                  className="btn-ghost"
                  style={menuItemStyle}
                  onClick={() => { setMenuOpen(false); onMoveToBook(b.id) }}
                >
                  📚 {b.name}
                </button>
              ))}

              <div style={{ fontSize: 12, color: '#9aa3b2', margin: '16px 0 4px' }}>Dupliquer et envoyer la copie vers… (l'original reste ici)</div>
              {books.map(b => (
                <button
                  key={`dup-${b.id}`}
                  className="btn-ghost"
                  style={menuItemStyle}
                  onClick={() => { setMenuOpen(false); onDuplicateToBook(b.id) }}
                >
                  📚 {b.name}{b.id === currentBookId ? ' (ce livre)' : ''}
                </button>
              ))}
              <button
                className="btn-ghost"
                style={menuItemStyle}
                onClick={() => { setMenuOpen(false); onDuplicateToBook(null) }}
              >
                (hors livre)
              </button>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}
