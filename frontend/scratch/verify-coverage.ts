/* eslint-disable no-console */
// 覆盖归档台行为验证：内存 KV 模拟浏览器 localStorage，逐条核对需求。
import { __setKVAdapter } from '../src/data/kv'
import { __resetEntriesCache, listRows } from '../src/data/local-store'
import { __resetCoverageCache, getCoverage } from '../src/data/coverage-store'
import {
  ArchiveStageError,
  __resetBatchState,
  __setStageFailure,
  __setStageFailureFor,
  archiveCampaign,
  assignVillageByDate,
  buildAudienceReport,
  buildMethodReport,
  importRoster,
  parseRosterCsv,
  runArchiveBatch,
} from '../src/data/coverage-archive'
import { runAction } from '../src/api/local-service'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function memoryKV() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    dump: () => Object.fromEntries(store),
  }
}

function resetWorld(kv: ReturnType<typeof memoryKV>) {
  __setKVAdapter(kv)
  __resetEntriesCache()
  __resetCoverageCache()
  __resetBatchState()
}

// --- 场景一：导入名册（新文件为准）+ 日期补归属 + 单笔归档三写入 ---
{
  console.log('场景一：名册导入、日期补归属、单笔归档三写入')
  const kv = memoryKV()
  resetWorld(kv)

  const parsed = parseRosterCsv('村组,受众人数\n青松村,50\n云岭村,45\n青松村,52\n新田村,33\n')
  check('CSV 表头与重复行处理', parsed.length === 3 && parsed.find((r) => r.village === '青松村')?.audience === 52)

  const result = importRoster('村组,受众人数\n红枫村,77\n石崖村,33\n白桦村,60\n')
  check('新文件替换历史名册（新增0/覆盖3/失效3）', getCoverage().roster.length === 3 && result.added === 0 && result.replaced === 3 && result.retired === 3, JSON.stringify(result))
  check('名册持久化', JSON.parse(kv.dump()['forest-fire-patrol:coverage']).roster.length === 3)

  // 活动3 覆盖村组为空 -> 按日期补归属，同一日期稳定
  const roster = getCoverage().roster
  const v1 = assignVillageByDate('2026-09-12', roster)
  const v2 = assignVillageByDate('2026-09-12', roster)
  const other = assignVillageByDate('2026-09-14', roster)
  check('日期补归属稳定且可分桶', v1 === v2 && roster.some((r) => r.village === v1) && v1 !== other, `${v1} vs ${other}`)

  const outcome = archiveCampaign(3)
  check('补归属来源标注', outcome.source === '日期补归属' && outcome.villages.length === 1)
  const campaign = listRows('campaign').find((r) => Number(r.id) === 3)!
  check('宣传状态写入为已完成', String(campaign.status) === '已完成')
  check('覆盖村组按归属回填', String(campaign['覆盖村组']) === outcome.villages[0])
  check('受众人数按名册汇总', campaign['受众人数'] === 77 || campaign['受众人数'] === 33 || campaign['受众人数'] === 60)
  const cov = getCoverage()
  check('活动进入已归档集合', cov.archivedCampaignIds.includes(3) && cov.outcomes.length === 1)

  // 活动1 覆盖青松村、云岭村（新名册里都没有）-> 也会走日期补归属
  // 活动2 覆盖红枫村 -> 名册命中，生成道路与检查站提示
  const o2 = archiveCampaign(2)
  check('名册命中走名册来源', o2.source === '名册' && o2.villages[0] === '红枫村')
  const cov2 = getCoverage()
  const roadTip = cov2.roadTips.find((t) => t.campaignId === 2)
  const cpTip = cov2.checkpointTips.find((t) => t.campaignId === 2)
  check('道路沿线提示清单写入（红枫峡线 起于红枫村）', !!roadTip && roadTip.roadCode === 'FORE-0002' && roadTip.publicityStatus === '已完成')
  check('检查站宣传提醒写入（红枫村峡口）', !!cpTip && cpTip.checkpointCode === 'CHEC-0002' && cpTip.publicityStatus === '已完成')
  check('三写入结果落同一存储事务', !!kv.dump()['forest-fire-patrol:coverage'] && !!kv.dump()['forest-fire-patrol:entries'])

  // 重复归档同一活动不产生第二版
  let dupError = ''
  try {
    archiveCampaign(2)
  } catch (e) {
    dupError = (e as Error).message
  }
  check('同一活动重复归档被拒', dupError.includes('已归档'))
  check('只保留一版归档结果', getCoverage().outcomes.filter((o) => o.campaignId === 2).length === 1)
}

// --- 场景二：三写入任一阶段失败整体回退 ---
{
  console.log('场景二：写入失败整体回退')
  const kv = memoryKV()
  resetWorld(kv)

  for (const stage of ['宣传状态', '道路提示清单', '检查站宣传提醒'] as const) {
    __setStageFailure(stage)
    let threw = null as unknown
    try {
      archiveCampaign(3) // 待开展、覆盖村组为空（按日期补归属），失败后状态应保持待开展
    } catch (e) {
      threw = e
    }
    check(`[${stage}] 阶段失败抛错且标记阶段`, threw instanceof ArchiveStageError && threw.stage === stage)
    const campaign = listRows('campaign').find((r) => Number(r.id) === 3)!
    check(`[${stage}] 宣传状态回退为待开展`, String(campaign.status) === '待开展', `实际=${String(campaign.status)}`)
    const cov = getCoverage()
    check(`[${stage}] 不产生归档结果`, !cov.archivedCampaignIds.includes(3) && cov.outcomes.length === 0)
    check(`[${stage}] 道路提示回退`, cov.roadTips.length === 0)
    check(`[${stage}] 检查站提醒回退`, cov.checkpointTips.length === 0)
  }

  // 持久化层失败：归档状态先写成功、业务清单写失败 -> 归档状态也要回滚
  let entriesWrites = 0
  const failSecondKV = {
    store: new Map<string, string>(),
    getItem(key: string) {
      return this.store.has(key) ? this.store.get(key)! : null
    },
    setItem(key: string, value: string) {
      if (key === 'forest-fire-patrol:entries') {
        entriesWrites += 1
        if (entriesWrites === 2) throw new Error('模拟存储故障')
      }
      this.store.set(key, value)
    },
  }
  resetWorld(failSecondKV)
  let kvError = ''
  try {
    archiveCampaign(2)
  } catch (e) {
    kvError = (e as Error).message
  }
  check('业务清单持久化失败时报错回滚', kvError.includes('整体回退'), kvError)
  const persisted = JSON.parse(failSecondKV.store.get('forest-fire-patrol:coverage') ?? '{}')
  check('归档状态键回滚到事务前', Array.isArray(persisted.archivedCampaignIds) && persisted.archivedCampaignIds.length === 0, JSON.stringify(persisted.archivedCampaignIds))
}

// --- 场景三：批次中断续跑 + 并发只一份结果 + 取消活动跳过 ---
{
  console.log('场景三：批次中断续跑、并发去重')
  const kv = memoryKV()
  resetWorld(kv)

  // 活动1（青松村、云岭村，批次首个处理）在检查站阶段失败，中断批次
  __setStageFailureFor(1, '检查站宣传提醒')
  const b1 = await runArchiveBatch()
  check('首批在首个活动失败并中断', b1.archived.length === 0 && b1.failed.length === 1 && b1.failed[0].campaignId === 1)
  check('取消活动被跳过', b1.skipped.some((s) => s.campaignId === 6 && s.reason.includes('取消')))

  // 并发触发：同一个在途 Promise（再挂一个消费者）；故障仅对活动1生效，续跑可成功
  const [b2a, b2b] = await Promise.all([runArchiveBatch(), runArchiveBatch()])
  check('并发只生成一份结果（同一对象）', b2a === b2b)
  check('续跑从未归档活动继续且标记 resumed', b2a.resumed && b2a.archived.some((o) => o.campaignId === 1))
  const eligibleIds = [1, 2, 3, 4, 5]
  check('可归档活动全部归档', eligibleIds.every((id) => getCoverage().archivedCampaignIds.includes(id)))
  check('取消活动未归档', !getCoverage().archivedCampaignIds.includes(6))
  check('批次结果已持久化', JSON.parse(kv.dump()['forest-fire-patrol:coverage']).lastBatch.dedupeKey === b2a.dedupeKey)

  // 没有新活动：重复/并发操作复用上一版，不生成第二版
  const b3 = await runArchiveBatch()
  check('无新活动时复用历史结果', b3.reused && b3.dedupeKey === b2a.dedupeKey && getCoverage().outcomes.length === 5)
}

// --- 场景四：报告 + 宣传动作同步提示清单 ---
{
  console.log('场景四：报告生成、宣传动作同步道路清单')
  const kv = memoryKV()
  resetWorld(kv)
  await runArchiveBatch()

  const audience = buildAudienceReport().content
  check('受众报告含村组与合计', audience.includes('覆盖村组,归档活动数,受众人数') && audience.includes('合计'))
  const method = buildMethodReport().content
  const methods = ['入户宣讲', '张贴标语', '集中讲座', '流动宣传车', '坝坝会宣讲']
  check('宣传方式分布报告覆盖各方式', methods.every((m) => method.includes(m)))
  check('宣传方式报告含占比', method.includes('100%'))

  // 对已归档活动做宣传状态动作（模拟从已完成回到进行中），道路与检查站清单同步
  const roadBefore = getCoverage().roadTips.find((t) => t.campaignId === 2)!
  const stampBefore = roadBefore.updatedAt
  await new Promise((r) => setTimeout(r, 1100))
  const res = runAction('campaign', 2, '开展活动')
  check('宣传动作执行成功', res.ok && res.message.includes('已同步'))
  const roadAfter = getCoverage().roadTips.find((t) => t.campaignId === 2)!
  const cpAfter = getCoverage().checkpointTips.find((t) => t.campaignId === 2)!
  check('道路提醒清单同步宣传状态', roadAfter.publicityStatus === '进行中' && roadAfter.updatedAt !== stampBefore)
  check('检查站提醒同步宣传状态', cpAfter.publicityStatus === '进行中')

  // 动作失败（不存在的活动）不影响任何数据
  const bad = runAction('campaign', 999, '开展活动')
  check('未知活动动作报错且不写入', !bad.ok)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
