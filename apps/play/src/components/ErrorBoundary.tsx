import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logAppError } from '../utils/appErrors'

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Filet de sécurité de l'app play : une erreur de rendu React (film, scan…) affichait
 * un écran blanc sans issue. Ici : message + « Réessayer » (rechargement propre) et
 * l'erreur est journalisée (voir `appErrors.ts`) pour le diagnostic.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logAppError('react', error, info.componentStack ?? undefined)
  }

  render() {
    if (!this.state.error) return this.props.children
    const fr = (navigator.language || 'en').toLowerCase().startsWith('fr')
    return (
      <div className="loading-screen app-error-screen" role="alert">
        <div className="home-status soft-card">
          <p className="loading-screen-text">{fr ? 'Oups, quelque chose a cassé.' : 'Oops, something broke.'}</p>
          <p>{fr ? 'Touche le bouton pour repartir.' : 'Tap the button to start again.'}</p>
          <button type="button" className="soft-btn" onClick={() => { window.location.replace('/') }}>
            {fr ? 'Réessayer' : 'Retry'}
          </button>
        </div>
      </div>
    )
  }
}
