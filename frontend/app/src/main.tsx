import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from './i18n'
import ToivBootstrap from './toiv/bootstrap'
import { applyStoredTheme } from './toiv/theme/apply'
import './index.css'
import './styles/printfilm.css'
import './App.css'
import './styles/toiv-skin.css'

applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToivBootstrap />
    </I18nProvider>
  </StrictMode>,
)
