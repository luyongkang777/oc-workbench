import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/panels.css'
import './styles/editor.css'
import './styles/terminal.css'
import './styles/shell-panel.css'
import './styles/diff.css'
import './styles/tools.css'
import './styles/markdown.css'
import './styles/git.css'
// 手机单列布局：最后加载，才能盖住桌面的固定列宽
import './styles/mobile.css'
import './styles/mobile-tuning.css'
import './styles/mobile-breakpoints.css'
import './styles/account.css'
import './styles/balance.css'
import './styles/folder.css'
import './styles/provider.css'
import './styles/rules.css'
import './styles/usage.css'
import './styles/usage-chart.css'
// 顶部设备条：自带 [data-mobile] 的尺寸分支，放在断点之后也不会被覆盖
import './styles/device-strip.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root')

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
