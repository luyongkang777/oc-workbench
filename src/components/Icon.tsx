/**
 * 统一图标：一套工业级正交几何线框，24 视框 / 1.5 描边 / currentColor 驱动，随主题自动变色。
 *
 * 风格约束（对齐设计稿 page 92:2 / 画板 92:768）：
 *   - 只用直线、正交折线、正圆与 45° 斜线，不出现卡通曲线和高饱和描边
 *   - 统一 1.5px 描边、直角端点（round 只为 14px 下不糊，不是装饰）
 *   - 细节层级控制在一层，14px 渲染时仍能辨认轮廓
 *
 * 用法：
 *   <IconDefs />          —— 在应用根挂一次，注入隐藏 sprite
 *   <Icon name="refresh" />      —— 任意处引用；size 默认 16，color 走 currentColor
 *
 * 新增图标只需往 PATHS 里加一条 <path>（视框统一 24×24，不要带 fill/stroke，
 * 公共描边属性在 <IconDefs> 的 <symbol> 上统一声明）。
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
  | 'shield'
  | 'account'

// 每个图标的几何（只有 path 数据，公共属性在 sprite 的 <symbol> 上）
// 坐标一律落在 .2 / .4 / .6 / .8 的 0.2 网格上，保证多图标并排时视觉重心一致。
const PATHS: Record<IconName, string> = {
  // 晶体棱镜：外六边 + 三条内部接缝
  logo: 'M12 2.6 20.4 7.3v9.4L12 21.4 3.6 16.7V7.3L12 2.6Z M12 12l8.4-4.7 M12 12v9.4 M12 12 3.6 7.3',
  // 双页文件：正页带折角，背面留一条页边
  files:
    'M8 6.4h6.6L18 9.8v9.8a1.4 1.4 0 0 1-1.4 1.4H8a1.4 1.4 0 0 1-1.4-1.4V7.8A1.4 1.4 0 0 1 8 6.4Z M14.4 6.4v3.6H18 M5.2 4.2v12.6',
  search: 'M10.8 4.4a6.4 6.4 0 0 1 0 12.8 6.4 6.4 0 0 1 0-12.8Z M15.6 15.6 20 20',
  // 环形箭头：两段圆弧 + 两个回勾
  refresh:
    'M19.6 12a7.6 7.6 0 0 1-13 5.4 M4.4 12a7.6 7.6 0 0 1 13-5.4 M17.4 3.4v3.4h-3.4 M6.6 20.6v-3.4h3.4',
  folder:
    'M3.4 6.4A1.6 1.6 0 0 1 5 4.8h4l1.8 2.2h7.8a1.6 1.6 0 0 1 1.6 1.6v9.4a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6V6.4Z',
  'folder-open':
    'M3.4 6.4A1.6 1.6 0 0 1 5 4.8h4l1.8 2.2h7.8a1.6 1.6 0 0 1 1.6 1.6v2.2 M3.6 13.4h17.2l-2.4 5.8H6l-2.4-5.8Z',
  file: 'M6.4 3.4h7.2L18 7.8v11.2a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6V5a1.6 1.6 0 0 1 1.6-1.6Z M13.4 3.4v4.6H18',
  code: 'M9 8.4 5.4 12 9 15.6 M15 8.4 18.6 12 15 15.6',
  braces:
    'M8.6 3.6c-1.8 0-1.8 2-1.8 4.2s0 3.2-1.6 4.2c1.6 1 1.6 2 1.6 4.2s0 4.2 1.8 4.2 M15.4 3.6c1.8 0 1.8 2 1.8 4.2s0 3.2 1.6 4.2c-1.6 1-1.6 2-1.6 4.2s0 4.2-1.8 4.2',
  hash: 'M5.6 9.2h13 M5.6 14.8h13 M10.4 4.2 8.6 19.8 M16.2 4.2l-1.8 15.6',
  // 审查：左列表 + 右侧下推箭头（表示 patch 落盘）
  review: 'M4.4 5.6h8.6 M4.4 11.6h6 M4.4 17.6h8.6 M17.2 9.4v9.2 M14.6 15.8 17.2 18.4l2.6-2.6',
  terminal:
    'M4.2 4.6h15.6a1.6 1.6 0 0 1 1.6 1.6v11.6a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6V6.2a1.6 1.6 0 0 1 1.6-1.6Z M6.6 10 9.6 12.4 6.6 14.8 M11.8 15h4.6',
  // 对话：直角气泡（工业风不用圆润尾巴）
  chat: 'M4 4.6h16v10.8H8.6L4 19.4V4.6Z M7.4 8.4h9.2 M7.4 12h6',
  send: 'M3.8 12 20.2 4.2l-6.4 15.6-2.8-5.4-7.2-2.4Z M11 14.4l3.2-6',
  attach:
    'M18.4 11.6 11.6 18.4a4 4 0 0 1-5.6-5.6l7.2-7.2a2.6 2.6 0 0 1 3.6 3.6l-7 7a1.2 1.2 0 0 1-1.8-1.6l6.2-6.2',
  settings:
    'M12 9.4a2.6 2.6 0 0 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z M12 3.2v2.6 M12 18.2v2.6 M3.2 12h2.6 M18.2 12h2.6 M5.9 5.9l1.9 1.9 M16.2 16.2l1.9 1.9 M18.1 5.9l-1.9 1.9 M7.8 16.2l-1.9 1.9',
  sun: 'M12 8.4a3.6 3.6 0 0 1 0 7.2 3.6 3.6 0 0 1 0-7.2Z M12 2.9v2.2 M12 18.9v2.2 M2.9 12h2.2 M18.9 12h2.2 M5.6 5.6l1.6 1.6 M16.8 16.8l1.6 1.6 M18.4 5.6l-1.6 1.6 M7.2 16.8l-1.6 1.6',
  moon: 'M20 14.4A8.2 8.2 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z',
  monitor: 'M4 5.2h16v10.6H4V5.2Z M12 15.8v3 M8.6 19.4h6.8',
  // 分支：左主干 + 右分支圆环 + 汇合线
  git: 'M6.2 3.4a2.4 2.4 0 0 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z M6.2 15.8a2.4 2.4 0 0 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z M17.8 7a2.4 2.4 0 0 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z M6.2 8.2v7.6 M17.8 11.8v1.4c0 1.6-1.4 2.6-3.2 2.6h-3.4',
  close: 'M6.4 6.4 17.6 17.6 M17.6 6.4 6.4 17.6',
  chevron: 'M9.6 6.4 15.2 12l-5.6 5.6',
  download: 'M12 3.8v10.4 M7.8 10.2 12 14.4l4.2-4.2 M4.4 19.4h15.2',
  warn: 'M12 3.6 21 19.4H3L12 3.6Z M12 9.4v4.4 M12 16.6v1',
  run: 'M7.4 4.8 18.6 12 7.4 19.2V4.8Z',
  stop: 'M7.4 7.4h9.2v9.2H7.4V7.4Z',
  plus: 'M12 5.4v13.2 M5.4 12h13.2',
  check: 'M4.8 12.4 9.6 17.2 19.2 7.6',
  // 仪表：半圆表盘 + 指针
  gauge: 'M5.2 14.2v5.2 M11.4 8.6v10.8 M17.6 11.6v7.8',
  // 层叠：三层正交等距面
  layers: 'M12 3.4 20.2 7.6 12 11.8 3.8 7.6 12 3.4Z M3.8 12.2 12 16.4l8.2-4.2 M3.8 16.6 12 20.8l8.2-4.2',
  // 插头：两只插脚 + 外壳 + 引线
  plug: 'M9.4 4.2v4.4 M14.6 4.2v4.4 M6.2 8.6h11.6v4.2a2 2 0 0 1-2 2H8.2a2 2 0 0 1-2-2V8.6Z M12 14.8v4.6',
  // 账号：头肩剪影（16px 下靠「圆 + 肩弧」两条主线辨认，不靠细节）
  account:
    'M12 4.6a3.4 3.4 0 0 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z M5.4 19.8c0-3.4 3-6 6.6-6s6.6 2.6 6.6 6',
  // 规则：盾牌 + 内嵌对勾
  shield: 'M12 3.2 20 6.2v6c0 4.4-3.3 7.6-8 8.8-4.7-1.2-8-4.4-8-8.8v-6l8-3Z M8.7 11.7l2.5 2.5 4.3-4.9',
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
            strokeWidth={1.5}
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
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
    >
      <use href={`#oc-${name}`} />
    </svg>
  )
}

export default Icon
