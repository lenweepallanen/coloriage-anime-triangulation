import { useEffect, useRef, useState } from 'react'
import { Outlet, Link } from 'react-router-dom'

export default function Layout() {
  const [toolsOpen, setToolsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toolsOpen) return
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setToolsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [toolsOpen])

  return (
    <div className="app-layout">
      <header className="app-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link to="/" className="app-title">Coloriage Animé</Link>
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button className="btn-secondary btn-sm" onClick={() => setToolsOpen(v => !v)}>
            Outils ▾
          </button>
          {toolsOpen && (
            <div
              style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: '#1c1f26', border: '1px solid #2d3340', borderRadius: 8,
                minWidth: 240, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 1000,
              }}
            >
              <Link
                to="/tools/coloriage-bw"
                onClick={() => setToolsOpen(false)}
                style={{ display: 'block', padding: '10px 14px', color: '#e6e6e6', textDecoration: 'none' }}
              >
                Couleur → N&B (upscale 2000)
              </Link>
              <Link
                to="/tools/video-posterize"
                onClick={() => setToolsOpen(false)}
                style={{ display: 'block', padding: '10px 14px', color: '#e6e6e6', textDecoration: 'none' }}
              >
                Posterisation vidéo (aplats couleur)
              </Link>
            </div>
          )}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
