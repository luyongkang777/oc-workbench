import type { ProviderInfo, ProviderStatus } from '../api/provider'
import type { ProviderSyncController } from '../hooks/useProviderSync'

type Props = {
  sync: ProviderSyncController
  status: ProviderStatus | null
  providers: ProviderInfo[]
  /** 改完默认模型后让面板回读一次（下拉 value 取自 status） */
  onReload: () => void
}

/**
 * 账号同步区：登录状态 + 上传/恢复 + 默认模型。
 *
 * 单独成文件是为了让面板主体保持在 300 行内；逻辑全在 useProviderSync 里。
 */
export default function ProviderSyncBlock({ sync, status, providers, onReload }: Props) {
  if (!sync.state.loggedIn) {
    return (
      <section className="provider-section provider-sync">
        <div className="provider-sync-line">
          账号未登录：登录后 provider、SK 与默认模型会同步到同账号的其它电脑。
        </div>
      </section>
    )
  }
  return (
    <section className="provider-section provider-sync">
      <div className="provider-sync-line">
        账号同步：{sync.state.username || '已登录'}
        {sync.state.message ? ` · ${sync.state.message}` : ''}
      </div>
      <div className="provider-sync-actions">
        <button
          type="button"
          className="provider-btn"
          onClick={() => void sync.push(false)}
          disabled={sync.state.busy}
        >
          上传到账号
        </button>
        <button
          type="button"
          className="provider-btn"
          onClick={() => void sync.pull(false)}
          disabled={sync.state.busy}
        >
          从账号恢复
        </button>
        <label className="provider-sync-default">
          <span>默认模型</span>
          <select
            className="provider-input"
            value={status?.model ?? ''}
            onChange={(event) => {
              const next = event.target.value
              void sync.setModel(next).then(onReload)
            }}
          >
            <option value="">未设置</option>
            {status?.model &&
            !providers.some((info) =>
              info.models.some((model) => `${info.id}/${model.id}` === status.model),
            ) ? (
              <option value={status.model}>{status.model}（当前）</option>
            ) : null}
            {providers.flatMap((info) =>
              info.models.map((model) => (
                <option key={`${info.id}/${model.id}`} value={`${info.id}/${model.id}`}>
                  {model.name || model.id}
                </option>
              )),
            )}
          </select>
        </label>
      </div>
    </section>
  )
}
