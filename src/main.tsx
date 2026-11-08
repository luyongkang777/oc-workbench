import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/panels.css'
import './styles/editor.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root')

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
