import { effectiveContext, effectiveOutput } from './providerForm'
import type { ProviderController } from '../hooks/useProviderPanel'

type Props = {
  controller: ProviderController
}

/** 模型清单：勾选 + 上下文/输出可编辑（单独成文件，保持面板主体 ≤300 行）。 */
export default function ProviderModelList({ controller }: Props) {
  const { form, models } = controller
  if (models.length === 0) return null
  return (
                  <div className="provider-models">
                    <div className="provider-models-head">
                      <span>
                        模型（已选 {form.picked.length} / 共 {models.length}）
                      </span>
                      <span className="provider-models-actions">
                        <button
                          type="button"
                          className="provider-btn"
                          onClick={() => controller.selectAll(true)}
                          disabled={controller.busy || form.picked.length === models.length}
                        >
                          全选
                        </button>
                        <button
                          type="button"
                          className="provider-btn"
                          onClick={() => controller.selectAll(false)}
                          disabled={controller.busy || form.picked.length === 0}
                        >
                          取消全选
                        </button>
                      </span>
                    </div>
                    <div className="provider-models-grid">
                      {form.models.map((model) => (
                        <div key={model.id} className="provider-model">
                          <label className="provider-model-pick">
                            <input
                              type="checkbox"
                              checked={form.picked.includes(model.id)}
                              onChange={() => controller.toggle(model.id)}
                            />
                            <span className="provider-model-name" title={model.id}>
                              {model.name || model.id}
                            </span>
                          </label>
                          <label className="provider-model-limit" title="上下文长度（token）">
                            <span>上下文</span>
                            <input
                              className="provider-input provider-limit-input"
                              inputMode="numeric"
                              value={String(effectiveContext(model))}
                              onChange={(event) =>
                                controller.limit(model.id, 'context', event.target.value)
                              }
                            />
                          </label>
                          <label className="provider-model-limit" title="单次输出上限（token）">
                            <span>输出</span>
                            <input
                              className="provider-input provider-limit-input"
                              inputMode="numeric"
                              placeholder="默认"
                              value={model.output > 0 ? String(model.output) : ''}
                              onChange={(event) =>
                                controller.limit(model.id, 'output', event.target.value)
                              }
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
  )
}
