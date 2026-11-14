/**
 * 统一图标：一套线性 SVG，24 视框 / 1.8 描边 / currentColor 驱动，随主题自动变色。
 *
 * 用法：
 *   <IconDefs />          —— 在应用根挂一次，注入隐藏 sprite
 *   <Icon name="refresh" />      —— 任意处引用；size 默认 16，color 走 currentColor
 *
 * 新增图标只需往 PATHS 里加一条 <path>（视框统一 24×24，不要带 fill/stroke，
 * 公共描边属性在 <IconDefs> 的 <g> 上统一声明）。
 */
import type { CSSProperties } from 'react'

export type IconName =
  | 'logo'
  | 'files'
  | 'search'
  | 'refresh'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'code'
  | 'braces'
  | 'hash'
  | 'review'
  | 'terminal'
  | 'chat'
  | 'send'
  | 'attach'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'git'
  | 'close'
  | 'chevron'
  | 'download'
  | 'warn'
  | 'run'
  | 'stop'
  | 'plus'
  | 'check'
  | 'gauge'
  | 'layers'
  | 'plug'

// 每个图标的几何（只有 path 数据，公共属性在 sprite 的 <g> 上）
const PATHS: Record<IconName, string> = {
  logo: 'M12 3 20 7.5v9L12 21 4 16.5v-9L12 3Z M12 12 20 7.5 M12 12v9 M12 12 4 7.5',
  files: 'M9 3h6l4 4v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M14 3v5h5',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M20 20l-3.6-3.6',
  refresh: 'M20 11a8 8 0 0 0-14-4.5L4 8 M4 4v4h4 M4 13a8 8 0 0 0 14 4.5L20 16 M20 20v-4h-4',
  folder: 'M4 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z',
  'folder-open': 'M4 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V11 M3.5 12.5h17L18.5 19H5.5l-2-6.5Z',
  file: 'M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M13 3v5h5',
  code: 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
  braces: 'M8 4c-2 0-2 2-2 4s0 3-2 4c2 1 2 2 2 4s0 4 2 4 M16 4c2 0 2 2 2 4s0 3 2 4c-2 1-2 2-2 4s0 4-2 4',
  hash: 'M5 9h14 M5 15h14 M10 4 8 20 M16 4l-2 16',
  review: 'M4 5h9 M4 12h6 M4 19h9 M17 13v8 M14 17l3 4 3-4',
  terminal: 'M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z M7 10l3 2.5L7 15 M12.5 15h4',
  chat: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1Z M8.5 10h7 M8.5 13h4',
  send: 'M4.5 12 20 4.5 15 20l-3.5-6-7-2Z M11.5 14l3.5-6',
  attach: 'M19 11.5 12 18.5a4 4 0 0 1-6-5.3l7.5-7.6a2.6 2.6 0 0 1 3.8 3.6l-7.3 7.4a1.2 1.2 0 0 1-1.8-1.6l6.6-6.7',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M12 3v2.5 M12 18.5V21 M3 12h2.5 M18.5 12H21 M5.6 5.6l1.8 1.8 M16.6 16.6l1.8 1.8 M18.4 5.6l-1.8 1.8 M7.4 16.6l-1.8 1.8',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2.5v2.4 M12 19.1v2.4 M4.2 4.2l1.7 1.7 M18.1 18.1l1.7 1.7 M2.5 12h2.4 M19.1 12h2.4 M4.2 19.8l1.7-1.7 M18.1 5.9l1.7-1.7',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5Z',
  monitor:
    'M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z M9 20h6 M12 16v4',
  git: 'M7 3.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z M7 15.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z M17 6.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z M7 8.4v7.2 M17 11.3c0 3.1-2.4 4-5 4.3',
  close: 'M6 6l12 12 M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  download: 'M12 4v10 M8 10l4 4 4-4 M5 19h14',
  warn: 'M12 4 21 19H3L12 4Z M12 10v4 M12 16.5v.5',
  run: 'M7 5.5 18 12 7 18.5V5.5Z',
  stop: 'M8.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z',
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7',
  // 输入框统计栏：速度表盘 + 用量层叠
  gauge: 'M4 18a8 8 0 1 1 16 0 M12 12l4.3-4.3 M12 12h.01',
  // MCP 读数：插头（两个脚 + 插身 + 一条线）
  plug: 'M9 3v5 M15 3v5 M6 8h12v2.5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z M12 16.5V21',
  layers: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
}

/**
 * 隐藏 sprite：整个应用挂一次。
 *
 * 描边属性必须落在 <symbol> 本身上。<use> 是把 symbol 深克隆进自己的影子树，
 * 继承链从 <use> 往上算 —— 写在 defs 里包着 symbol 的 <g> 上，克隆出来的内容
 * 拿不到这些属性，会退回 stroke:none + fill:black，于是纯直线图标（如 plus）
 * 整条消失，闭合路径（logo）变成实心黑块。
 */
export function IconDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
      <defs>
        {(Object.keys(PATHS) as IconName[]).map((name) => (
          <symbol
            key={name}
            id={`oc-${name}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={PATHS[name]} />
          </symbol>
        ))}
      </defs>
    </svg>
  )
}

type IconProps = {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
}

/** 单个图标。颜色跟随 currentColor，尺寸用 size（默认 16）。 */
export function Icon({ name, size = 16, className, style }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      aria-hidden="true"
      // 兜底：symbol 上漏写公共属性时，<use> 也能从这里继承到正确描边
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
    >
      <use href={`#oc-${name}`} />
    </svg>
  )
}

export default Icon
