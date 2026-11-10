/** 斜杠命令菜单的纯逻辑：内置命令表、过滤、解析、合并服务端命令。 */
import type { CommandInfo } from '../api/chat'

export type CommandGroup = 'builtin' | 'server'

export type CommandItem = {
  name: string
  description?: string
  group: CommandGroup
  aliases?: string[]
  /** 选中后由工作台直接执行的客户端命令 */
  builtin?: 'agents' | 'compact' | 'new' | 'clear' | 'copy' | 'sessions' | 'fork'
  /** TUI 专有命令：显示但不可执行 */
  disabled?: boolean
  /** 灰条上的提示（默认「仅 TUI」） */
  note?: string
}

/**
 * 内置命令表：和 TUI 的 / 菜单对齐。
 * 能在工作台执行的挂 builtin；其余保留名称/描述并标灰，避免「点了没反应」。
 */
export const BUILTIN_COMMANDS: CommandItem[] = [
  { name: 'agents', description: '切换当前会话的 agent', group: 'builtin', builtin: 'agents' },
  { name: 'btw', description: '基于当前上下文单次回答，不调用工具', group: 'builtin', disabled: true },
  { name: 'cd', description: '切换工作目录', group: 'builtin', disabled: true, note: '文件树' },
  { name: 'clear', description: '新建会话（清空当前视图）', group: 'builtin', builtin: 'clear' },
  { name: 'compact', description: '压缩当前会话上下文', group: 'builtin', builtin: 'compact' },
  { name: 'connect', description: '连接集成 / Provider', group: 'builtin', disabled: true },
  { name: 'continue', description: '打开会话列表继续其他会话', group: 'builtin', builtin: 'sessions', aliases: ['sessions', 'resume'] },
  { name: 'copy', description: '复制最后一条回复', group: 'builtin', builtin: 'copy' },
  { name: 'debug', description: '查看调试信息', group: 'builtin', disabled: true },
  { name: 'diff', description: '查看当前改动', group: 'builtin', disabled: true, note: '顶栏审查' },
  { name: 'editor', description: '用外部编辑器打开', group: 'builtin', disabled: true },
  { name: 'exit', description: '退出 TUI', group: 'builtin', disabled: true, aliases: ['quit', 'q'] },
  { name: 'export', description: '导出会话', group: 'builtin', disabled: true },
  { name: 'fork', description: '从当前会话分叉', group: 'builtin', builtin: 'fork' },
  { name: 'help', description: '查看帮助', group: 'builtin', disabled: true },
  { name: 'highlights', description: '查看高亮', group: 'builtin', disabled: true },
  { name: 'mcps', description: '管理 MCP', group: 'builtin', disabled: true },
  { name: 'models', description: '切换模型', group: 'builtin', disabled: true, note: '顶栏' },
  { name: 'new', description: '新建会话', group: 'builtin', builtin: 'new' },
  { name: 'open', description: '打开项目', group: 'builtin', disabled: true, aliases: ['projects', 'project'], note: '文件树' },
  { name: 'pair', description: '配对 Web / 客户端', group: 'builtin', disabled: true, aliases: ['web'] },
  { name: 'plugins', description: '管理插件', group: 'builtin', disabled: true },
  { name: 'redo', description: '重做', group: 'builtin', disabled: true },
  { name: 'reload', description: '重新加载配置', group: 'builtin', disabled: true },
  { name: 'rename', description: '重命名会话', group: 'builtin', disabled: true },
  { name: 'restart', description: '重启 TUI', group: 'builtin', disabled: true },
  { name: 'settings', description: '设置', group: 'builtin', disabled: true },
  { name: 'skills', description: '技能', group: 'builtin', disabled: true },
  { name: 'stats', description: '统计', group: 'builtin', disabled: true },
  { name: 'status', description: '会话状态', group: 'builtin', disabled: true },
  { name: 'terminal', description: '终端', group: 'builtin', disabled: true, note: '底部终端' },
  { name: 'themes', description: '主题', group: 'builtin', disabled: true },
  { name: 'timeline', description: '时间线', group: 'builtin', disabled: true },
  { name: 'undo', description: '撤销', group: 'builtin', disabled: true },
  { name: 'update', description: '更新', group: 'builtin', disabled: true },
  { name: 'usage', description: '用量', group: 'builtin', disabled: true },
  { name: 'variants', description: '思考强度 / 模型变体', group: 'builtin', disabled: true, aliases: ['thinking', 'effort'], note: '顶栏' },
  { name: 'worktrees', description: '工作树', group: 'builtin', disabled: true },
]

/** 把 /api/command 的结果并进菜单，按名字排序（和 TUI 的列表顺序一致）。 */
export function mergeCommands(
  builtin: CommandItem[],
  server: CommandInfo[],
): CommandItem[] {
  const items = [
    ...builtin,
    ...server
      .filter((command) => command.name)
      .map<CommandItem>((command) => ({
        name: command.name,
        description: command.description,
        group: 'server',
      })),
  ]
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

/** 按输入过滤：名字或别名包含即可（大小写不敏感）。 */
export function filterCommands(list: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      (item.aliases ?? []).some((alias) => alias.toLowerCase().includes(q)),
  )
}

/** 输入形如 "/goal 实现 X" → { name: "goal", args: "实现 X" }；不是斜杠命令返回 null。 */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}

/** 按名字或别名找命令。 */
export function findCommand(list: CommandItem[], name: string): CommandItem | undefined {
  const wanted = name.toLowerCase()
  return list.find(
    (item) =>
      item.name.toLowerCase() === wanted ||
      (item.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
  )
}
