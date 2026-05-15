import { Outlet, Link } from 'react-router-dom'

export default function Layout() {
  return (
    <div className="app-layout">
      <header className="app-header">
        <Link to="/" className="app-title">Coloriage Animé</Link>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
