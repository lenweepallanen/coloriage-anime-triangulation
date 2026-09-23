import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initNative } from './native'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorLogging } from './utils/appErrors'
import '@shared/styles/global.css'
import './styles/play-theme.css'

installGlobalErrorLogging()
void initNative()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
