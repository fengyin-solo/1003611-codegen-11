import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EntryRow } from '../src/data/types.js'
import {
  advanceBatch,
  buildCoverageReport,
  campaignsNeedingArchive,
  emptyCoverage,
  finishBatch,
  importRoster,
  planArchive,
  reconcileNotices,
  resolveCampaignGroups,
  type CoverageState,
  type StoredDoc,
} from '../src/data/coverage-core.js'

function campaign(
  id: number,
  code: string,
  status: string,
  date: string,
  group = '',
  audience: string | number = 0,
  method = '院坝宣讲',
): EntryRow {
  return {
    id,
    status,
    pending: status !== '已归档',
    abnormal: false,
    活动编号: code,
    宣传主题: `主题-${code}`,
    宣传方式: method,
    覆盖村组: group,
    执行人员: '测试员',
    活动日期: date,
    受众人数: audience,
    活动状态: status,
  }
}

function road(id: number, code: string, start: string, end: string): EntryRow {
  return {
    id,
    status: '正常通行',
    pending: true,
    abnormal: false,
    道路编号: code,
    道路名称: `${start}道路`,
    起点位置: start,
    终点位置: end,
    道路等级: '便道',
    通行宽度: 3,
    最近巡检日: '2026-09-01',
    通行状态: '正常通行',
  }
}

function station(id: number, code: string, location: string): EntryRow {
  return {
    id,
    status: '正常检查',
    pending: true,
    abnormal: false,
    站点编号: code,
    站点位置: location,
    值守人员: '值守',
    检查项目: '火种收缴',
    通行车辆数: 10,
    收缴火种数: 1,
    值班日期: '2026-09-01',
    运行状态: '正常检查',
  }
}

function makeDoc(): StoredDoc {
  return {
    campaign: [
      campaign(1, 'CAMP-0001', '已完成', '2026-09-01'),
      campaign(2, 'CAMP-0002', '已完成', '2026-09-05'),
      campaign(3, 'CAMP-0003', '进行中', '2026-09-12', '云岭村一组', 96, '入户走访'),
      campaign(4, 'CAMP-0004', '已取消', '2026-09-18', '红枫村'),
    ],
    forestroad: [
      road(1, 'FORE-0001', '青山一组', '青山二组'),
      road(2, 'FORE-0002', '红岩村', '瞭望二台'),
      road(3, 'FORE-0003', '云岭村一组', '云岭村二组'),
    ],
    checkpoint: [
      station(1, 'CHEC-0001', '青山一组山口'),
      station(2, 'CHEC-0002', '红岩村口'),
      station(3, 'CHEC-0003', '云岭村一组岭口'),
    ],
    coverage: emptyCoverage(),
  }
}

// 为了模拟"单键写入失败即整体回退"，测试里用一个开关让提交抛错。
function failAtCommit(): void {
  throw new Error('localStorage 写入失败')
}

test('名单导入：同活动重复导入以新文件为准，其他活动名册保留，版本递增', () => {
  let doc = makeDoc()
  const first = importRoster(
    doc,
    '活动编号,村组名称,受众人数,宣传方式\nCAMP-0001,青山一组,58,院坝宣讲\nCAMP-0001,青山二组,46,院坝宣讲\n',
  )
  assert.equal(first.ok, true)
  doc = { ...doc, coverage: first.state }
  assert.equal(doc.coverage.roster[1].length, 2)
  assert.equal(doc.coverage.rosterVersion, 1)

  const second = importRoster(
    doc,
    '活动编号,村组名称,受众人数,宣传方式\nCAMP-0001,青山三组,70,院坝宣讲\nCAMP-0002,红岩村,33,张贴标语\n',
  )
  assert.equal(second.ok, true)
  doc = { ...doc, coverage: second.state }
  assert.deepEqual(doc.coverage.roster[1].map((line) => line.村组名称), ['青山三组'])
  assert.equal(doc.coverage.roster[2][0].村组名称, '红岩村')
  assert.equal(doc.coverage.rosterVersion, 2)

  const unchanged = importRoster(
    doc,
    '活动编号,村组名称,受众人数,宣传方式\nCAMP-0001,青山三组,70,院坝宣讲\n',
  )
  assert.equal(unchanged.state.rosterVersion, 2)
})

test('名单导入：错误行整份拒绝，不写入任何记录', () => {
  const doc = makeDoc()
  const result = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0001,青山一组,58\nCAMP-9999,不存在村组,10\nCAMP-0002,,\nCAMP-0001,青山二组,-3\n',
  )
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 3)
  assert.deepEqual(result.state.roster, {})
  assert.equal(result.state.rosterVersion, 0)
})

test('旧记录缺覆盖村组：按活动日期确定性补归属，同日期同结果', () => {
  const doc = makeDoc()
  const a = resolveCampaignGroups(doc, doc.campaign[1])
  const b = resolveCampaignGroups(doc, doc.campaign[1])
  assert.equal(a.source, 'dateFallback')
  assert.equal(a.groups.length, 1)
  assert.deepEqual(a.groups, b.groups)
  // 有名册时名册优先，不会补归属
  const imported = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0002,红岩村,33\n',
  )
  const withRoster = resolveCampaignGroups(
    { ...doc, coverage: imported.state },
    doc.campaign[1],
  )
  assert.equal(withRoster.source, 'roster')
  assert.deepEqual(withRoster.groups, ['红岩村'])
})

test('归档：宣传状态、道路提示、检查站提醒在同一份文档里生成，受众人数汇总', () => {
  let doc = makeDoc()
  const imported = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0001,青山一组,58\nCAMP-0001,青山二组,46\n',
  )
  doc = { ...doc, coverage: imported.state }

  const outcome = planArchive(doc, 1, '2026-09-20T00:00:00.000Z', 'BATCH-TEST')
  assert.equal(outcome.code, 'archived')
  assert.equal(outcome.doc.campaign[0].status, '已归档')
  assert.equal(outcome.doc.campaign[0]['覆盖村组'], '青山一组、青山二组')
  assert.equal(outcome.doc.campaign[0]['受众人数'], 104)
  // FORE-0001 起终点青山一组/二组都被命中
  assert.equal(outcome.doc.coverage.roadNotices.length, 1)
  assert.equal(outcome.doc.coverage.roadNotices[0].道路编号, 'FORE-0001')
  assert.equal(outcome.doc.coverage.roadNotices[0].宣传活动状态, '已归档')
  // CHEC-0001 在青山一组山口
  assert.equal(outcome.doc.coverage.checkpointNotices.length, 1)
  assert.equal(outcome.doc.coverage.checkpointNotices[0].站点编号, 'CHEC-0001')
  assert.equal(outcome.record?.受众人数, 104)
  assert.equal(outcome.record?.命中道路数, 1)
})

test('原子写入：提交环节抛错时，调用方持有的归档前文档保持不变（整体回退）', () => {
  let doc = makeDoc()
  const imported = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0001,青山一组,58\n',
  )
  doc = { ...doc, coverage: imported.state }
  const before = JSON.stringify(doc)
  const outcome = planArchive(doc, 1, '2026-09-20T00:00:00.000Z', 'BATCH-TEST')
  assert.equal(outcome.code, 'archived')
  // service 层语义：commitCampaignsAndCoverage 抛错 => 丢弃 outcome.doc，继续用旧 doc。
  assert.throws(() => failAtCommit(), /localStorage 写入失败/)
  assert.equal(JSON.stringify(doc), before)
})

test('并发归档同一活动只保留一版：重新归档覆盖旧产物，版本递增', () => {
  let doc = makeDoc()
  const imported = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0001,青山一组,58\n',
  )
  doc = { ...doc, coverage: imported.state }
  const first = planArchive(doc, 1, '2026-09-20T00:00:00.000Z', 'BATCH-1')
  doc = first.doc
  // 再导入更多村组后重新归档
  const again = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0001,青山一组,58\nCAMP-0001,青山二组,60\n',
  )
  doc = { ...doc, coverage: again.state }
  const second = planArchive(doc, 1, '2026-09-21T00:00:00.000Z', 'BATCH-2')
  assert.equal(second.code, 'rearchived')
  assert.equal(second.record!.版本, 2)
  assert.equal(Object.keys(second.doc.coverage.archives).length, 1)
  // 同一活动同一路段只有一条提示（一版结果），不是两条
  const roadHits = second.doc.coverage.roadNotices.filter((item) =>
    item.id.startsWith('road:1:'),
  )
  assert.equal(roadHits.length, 1)
})

test('批次：逐活动推进，中断后 pendingIds 保留，续跑从未归档活动继续', () => {
  let doc = makeDoc()
  // 只有非取消且需要归档的活动进入批次：1、2、3（4 已取消排除）
  const targets = campaignsNeedingArchive(doc).map((row) => Number(row.id))
  assert.deepEqual(targets, [1, 2, 3])

  let state: CoverageState = doc.coverage
  let campaigns = doc.campaign
  let batch: CoverageState['batch'] = {
    id: 'BATCH-X',
    state: 'running' as const,
    startedAt: 't0',
    updatedAt: 't0',
    doneIds: [] as number[],
    pendingIds: targets,
    skippedIds: [] as number[],
    failed: [],
    processed: 0,
    total: targets.length,
    results: [],
    lockHolder: 'test',
  }
  // 推进一个活动（id=1，无名册走日期补归属）后请求中断
  let progress = advanceBatch(state, campaigns, doc.forestroad, doc.checkpoint, batch, 1, 't1')
  state = progress.state
  campaigns = progress.campaigns
  batch = state.batch!
  assert.deepEqual(batch.doneIds, [1])
  assert.deepEqual(batch.pendingIds, [2, 3])
  assert.equal(campaigns[0].status, '已归档')

  const interrupted = finishBatch(batch, 't2', true)
  assert.equal(interrupted.state, 'interrupted')
  assert.deepEqual(interrupted.pendingIds, [2, 3])

  // 续跑：从剩余活动继续，已归档的 1 不重做
  let resumed: CoverageState['batch'] = { ...interrupted, state: 'running' as const }
  progress = advanceBatch(state, campaigns, doc.forestroad, doc.checkpoint, resumed, 2, 't3')
  state = progress.state
  campaigns = progress.campaigns
  resumed = state.batch!
  assert.deepEqual(resumed.doneIds, [1, 2])
  assert.deepEqual(resumed.pendingIds, [3])

  // 已取消活动被跳过
  progress = advanceBatch(state, campaigns, doc.forestroad, doc.checkpoint, resumed, 4, 't4')
  assert.equal(progress.result.code, 'skipped')
})

test('道路提醒清单同步宣传状态：活动被取消后提示标记为活动已注销', () => {
  let doc = makeDoc()
  const imported = importRoster(
    doc,
    '活动编号,村组名称,受众人数\nCAMP-0001,青山一组,58\n',
  )
  doc = { ...doc, coverage: imported.state }
  const archived = planArchive(doc, 1, 't1', 'BATCH-1').doc
  // 活动在别处被取消
  const canceledCampaigns = archived.campaign.map((row) =>
    Number(row.id) === 1 ? { ...row, status: '已取消' } : row,
  )
  const reconciled = reconcileNotices(archived.coverage, canceledCampaigns, 't2')
  assert.equal(reconciled.roadNotices[0].宣传活动状态, '已取消')
  assert.equal(reconciled.roadNotices[0].状态, '活动已注销')
  assert.equal(reconciled.checkpointNotices[0].状态, '活动已注销')
})

test('报告：包含受众人数明细与宣传方式分布两段', () => {
  let doc = makeDoc()
  const imported = importRoster(
    doc,
    '活动编号,村组名称,受众人数,宣传方式\nCAMP-0001,青山一组,58,院坝宣讲\nCAMP-0002,红岩村,33,张贴标语\nCAMP-0002,红岩村二组,22,张贴标语\n',
  )
  doc = { ...doc, coverage: imported.state }
  doc = planArchive(doc, 1, 't1', 'BATCH-1').doc
  doc = planArchive(doc, 2, 't2', 'BATCH-1').doc
  const { filename, content } = buildCoverageReport(doc.coverage)
  assert.match(filename, /^防火宣传覆盖报告-/)
  assert.match(content, /一、受众人数/)
  assert.match(content, /二、宣传方式分布/)
  assert.match(content, /院坝宣讲,1,58/)
  assert.match(content, /张贴标语,1,55/)
  assert.match(content, /合计,,,,113/)
})

