/**
 * 第二层验收的断言构造。
 *
 * 拆出来是为了让 `verify-retry-429.mjs` 保持在 300 行以内，也让每个场景的
 * 判定口径集中在一处：哪些是「必须发生」、哪些是「绝不能发生」。
 *
 * expect:
 *   success  —— 失败 N 次后应该成功
 *   giveup   —— 一直失败，重试到上限后停下
 *   cancel   —— 重试还没开始就切走，不允许动回撤
 *   midstage —— stage 已发出、commit 之前切走，不允许接着 commit
 *   restore  —— 已回撤但投递失败，原文必须完整回到输入框
 */
export function buildChecks({
  expect,
  failTimes,
  maxRetries,
  main,
  sent,
  stages,
  commits,
  page,
  timeline,
  text,
}) {
  const sameID = sent.length >= 2 && sent.every((item) => item.id && item.id === sent[0].id)
  const sameText = sent.length >= 2 && sent.every((item) => item.text === sent[0].text)
  const noticeSeen = timeline.some((item) => item.event.includes('正在自动重试'))
  const gotReply = Boolean(page?.assistant?.includes('pong-429-ok'))
  const gaveUp = Boolean(page?.notice?.includes('已重试'))
  const oneUser = page?.userCount === 1
  const expectedRetries = expect === 'giveup' ? maxRetries : failTimes
  const stagesOk =
    stages.length === expectedRetries &&
    stages.every((item) => item.messageID === sent[0]?.id && item.files === false) &&
    commits.length === expectedRetries
  const mainSeq = main.map((c) => c.code).join(',')

  if (expect === 'restore') {
    return [
      [
        '重投失败后提示如实说明原文去向',
        timeline.some((item) => item.event.includes('原文已放回输入框')),
        page?.detail ?? '',
      ],
      ['用户已输入的内容没被覆盖', (page?.draft || '').includes('draft-keep'), page?.draft ?? ''],
      ['原文追加回了输入框', (page?.draft || '').includes(text), page?.draft ?? ''],
      ['服务端那一轮已删、界面不残留', page?.userCount === 0, `user=${page?.userCount}`],
    ]
  }

  if (expect === 'midstage') {
    return [
      ['stage 已经发出', stages.length === 1, `stage=${stages.length}`],
      ['切走后没有 commit（没有偷偷删消息）', commits.length === 0, `commit=${commits.length}`],
      ['切走后没有重投', sent.length === 1, `prompt=${sent.length}`],
    ]
  }

  if (expect === 'cancel') {
    return [
      ['失败后没有发出下一次 /prompt', sent.length === 1, `prompt=${sent.length}`],
      [
        '切走后没有动回撤（stage/commit 都是 0）',
        stages.length === 0 && commits.length === 0,
        `stage=${stages.length} commit=${commits.length}`,
      ],
    ]
  }

  if (expect === 'giveup') {
    const giveUpCount = Number((/已重试 (\d+) 次/.exec(page?.notice ?? '') ?? [])[1])
    return [
      ['模型调用一直失败', main.filter((c) => c.code === 429).length >= failTimes, `main=${mainSeq}`],
      [
        '重投次数与放弃文案一致',
        giveUpCount === sent.length - 1 && sent.length > 3,
        `prompt=${sent.length} notice=${page?.notice ?? ''}`,
      ],
      ['每次重投都先回撤（stage/commit 各一次，files:false）', stagesOk, `stage=${stages.length} commit=${commits.length}`],
      ['重投用同一个 message id 和原文', sameID && sameText, `ids=${sent.length}`],
      ['界面出现放弃提示', gaveUp, page?.notice ?? ''],
      ['界面没有重复的用户消息', oneUser, `user=${page?.userCount}`],
    ]
  }

  return [
    [
      '模型先失败，之后成功',
      main.filter((c) => c.code === 429).length >= failTimes && main.some((c) => c.code === 200),
      `main=${mainSeq}`,
    ],
    ['每次失败都重投了 /prompt', sent.length === failTimes + 1, `prompt=${sent.length}`],
    ['重投用同一个 message id', sameID, `ids=${sent.map((s) => s.id).join(',')}`],
    ['重投文案与原文一致', sameText, ''],
    ['每次重投都先回撤（stage/commit 各一次，files:false）', stagesOk, `stage=${stages.length} commit=${commits.length}`],
    ['界面出现过「正在自动重试」', noticeSeen, ''],
    ['界面收到回复', gotReply, ''],
    ['没有走到放弃', !gaveUp, page?.notice ?? ''],
    ['界面没有重复的用户消息', oneUser, `user=${page?.userCount}`],
  ]
}
