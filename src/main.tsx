import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/panels.css'
import './styles/editor.css'
import './styles/terminal.css'
import './styles/diff.css'
import './styles/tools.css'
import './styles/markdown.css'
import './styles/git.css'
// 手机单列布局：最后加载，才能盖住桌面的固定列宽
import './styles/mobile.css'
import './styles/mobile-tuning.css'
import './styles/mobile-breakpoints.css'
import './styles/account.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root')

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
