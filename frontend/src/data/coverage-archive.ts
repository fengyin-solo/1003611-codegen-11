import { commitArchive, getCoverage } from './coverage-store'
import { listRows } from './local-store'
import type {
  ArchiveOutcome,
  ArchiveStage,
  BatchOutcome,
  CheckpointTipRow,
  EntryRow,
  RoadTipRow,
  RosterImportResult,
  VillageRow,
} from './types'

// 覆盖归档引擎：页面不直接写数据，导入、归档、续跑、报告都从这里走。
// 既有数据流是「防火宣传 → 覆盖村组 → 林区道路沿线 / 防火检查站」，
// 归档沿这条链路把三处数据一笔事务写完。

const ARCHIVED_STATUS = '已完成'
const CANCELLED_STATUS = '已取消'

export class ArchiveStageError extends Error {
  constructor(
    readonly stage: ArchiveStage,
    message: string,
  ) {
    super(message)
    this.name = 'ArchiveStageError'
  }
}

// 测试用故障注入：下一笔归档在指定阶段写入失败，验证整体回退。
let pendingStageFailure: ArchiveStage | null = null
export function __setStageFailure(stage: ArchiveStage | null): void {
  pendingStageFailure = stage
}

// 测试用：指定活动归档时在指定阶段失败一次（触发后清除），用于批次中断场景。
let stageFailureCampaign: { campaignId: number; stage: ArchiveStage } | null = null
export function __setStageFailureFor(campaignId: number, stage: ArchiveStage | null): void {
  stageFailureCampaign = stage === null ? null : { campaignId, stage }
}

function stageFails(stage: ArchiveStage, campaignId: number): boolean {
  if (pendingStageFailure === stage) {
    pendingStageFailure = null
    return true
  }
  if (stageFailureCampaign && stageFailureCampaign.campaignId === campaignId && stageFailureCampaign.stage === stage) {
    stageFailureCampaign = null
    return true
  }
  return false
}

function nowText(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// ---------- CSV ----------

/** 简易 CSV 解析：支持表头、引号包裹与逗号转义，村组名单按行读。 */
export function parseRosterCsv(text: string): VillageRow[] {
  const rows: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1
      record.push(field)
      rows.push(record)
      field = ''
      record = []
    } else {
      field += char
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    rows.push(record)
  }

  const parsed: VillageRow[] = []
  rows.forEach((cells, index) => {
    const village = (cells[0] ?? '').trim()
    if (!village) return
    // 首行是表头时跳过。
    if (index === 0 && (village === '村组' || village === '覆盖村组' || village === 'village')) return
    const audienceCell = (cells[1] ?? '').trim()
    parsed.push({ village, audience: audienceCell === '' ? 0 : Number(audienceCell) || 0 })
  })
  // 同村组重复出现时以最后一行为准。
  const deduped = new Map<string, VillageRow>()
  for (const row of parsed) {
    deduped.set(row.village, row)
  }
  return [...deduped.values()]
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// ---------- 名册导入 ----------

/**
 * 导入村组名单。同一活动/再次导入的取舍：一律以新文件为准（新文件是现场最新核对结果），
 * 新名册整体替换历史名册；已归档结果是历史事实，不随新名册改写。
 */
export function importRoster(text: string): RosterImportResult {
  const incoming = parseRosterCsv(text)
  if (incoming.length === 0) {
    throw new Error('名单里没有可用的村组行，请按「村组,受众人数」整理后再导入')
  }
  const result: RosterImportResult = {
    importedAt: nowText(),
    added: 0,
    replaced: 0,
    retired: 0,
    total: incoming.length,
    roster: incoming,
  }
  commitArchive((draft) => {
    const previous = new Map(draft.coverage.roster.map((row) => [row.village, row]))
    for (const row of incoming) {
      if (previous.has(row.village)) result.replaced += 1
      else result.added += 1
    }
    for (const old of draft.coverage.roster) {
      if (!incoming.some((row) => row.village === old.village)) result.retired += 1
    }
    draft.coverage.roster = incoming.map((row) => ({ ...row }))
    draft.coverage.rosterImportedAt = result.importedAt
  })
  return result
}

export function rosterTemplate(): string {
  return '﻿村组,受众人数\n青松村,50\n云岭村,45\n'
}

// ---------- 归属判定 ----------

/** 旧记录缺少覆盖村组时按活动日期补归属：同一日期稳定落到同一个在册村组。 */
export function assignVillageByDate(date: string, roster: VillageRow[]): string {
  if (roster.length === 0) {
    throw new Error('村组名册为空，请先导入村组名单再归档')
  }
  let hash = 0
  for (let i = 0; i < date.length; i += 1) {
    hash = (hash * 31 + date.charCodeAt(i)) >>> 0
  }
  return roster[hash % roster.length].village
}

/** 从活动的覆盖村组字段里识别在册村组；一个都识别不到时按活动日期补归属。 */
export function resolveVillages(row: EntryRow, roster: VillageRow[]): { villages: string[]; source: '名册' | '日期补归属' } {
  const raw = String(row['覆盖村组'] ?? '').trim()
  const known = roster.filter((item) => raw.includes(item.village)).map((item) => item.village)
  if (known.length > 0) {
    return { villages: known, source: '名册' }
  }
  const date = String(row['活动日期'] ?? '').trim()
  if (!date) {
    throw new Error(`活动 ${String(row['活动编号'])} 缺少活动日期，无法按日期补归属`)
  }
  return { villages: [assignVillageByDate(date, roster)], source: '日期补归属' }
}

function audienceOf(villages: string[], roster: VillageRow[]): number {
  return villages.reduce((sum, village) => {
    const found = roster.find((row) => row.village === village)
    return sum + (found?.audience ?? 0)
  }, 0)
}

// ---------- 归档事务 ----------

function findCampaign(id: number): EntryRow {
  const row = listRows('campaign').find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的防火宣传活动`)
  }
  return row
}

/**
 * 归档单个活动。宣传状态、道路沿线提示清单、检查站宣传提醒三笔写入走同一事务，
 * 任一阶段失败抛出 ArchiveStageError，coverage-store 保证整体回退。
 */
export function archiveCampaign(campaignId: number): ArchiveOutcome {
  const already = getCoverage().outcomes.find((item) => item.campaignId === campaignId)
  if (already) {
    throw new Error(`活动 ${already.campaignCode} 已归档，重复归档不会再生成新版本`)
  }
  const current = findCampaign(campaignId)
  if (String(current.status) === CANCELLED_STATUS) {
    throw new Error(`活动 ${String(current['活动编号'])} 已取消，不纳入归档`)
  }

  let outcome: ArchiveOutcome | undefined
  commitArchive((draft) => {
    const coverage = draft.coverage
    const campaigns = draft.entries.campaign ?? []
    const index = campaigns.findIndex((row) => Number(row.id) === campaignId)
    if (index < 0) {
      throw new Error(`没有找到编号为 ${campaignId} 的防火宣传活动`)
    }
    const row = campaigns[index]
    const { villages, source } = resolveVillages(row, coverage.roster)
    const audience = audienceOf(villages, coverage.roster)
    const method = String(row['宣传方式'] ?? '现场宣讲')
    const code = String(row['活动编号'] ?? `CAMP-${campaignId}`)
    const stamp = nowText()

    // 阶段一：更新宣传状态。
    if (stageFails('宣传状态', campaignId)) {
      throw new ArchiveStageError('宣传状态', `活动 ${code} 宣传状态写入失败`)
    }
    campaigns[index] = {
      ...row,
      status: ARCHIVED_STATUS,
      pending: false,
      abnormal: false,
      覆盖村组: String(row['覆盖村组'] ?? '').trim() ? row['覆盖村组'] : villages.join('、'),
      受众人数: audience,
      活动状态: ARCHIVED_STATUS,
    }

    // 阶段二：沿数据流更新林区道路沿线提示清单。
    if (stageFails('道路提示清单', campaignId)) {
      throw new ArchiveStageError('道路提示清单', `活动 ${code} 道路沿线提示写入失败`)
    }
    const roads = draft.entries.forestroad ?? []
    let roadSeq = coverage.roadTips.reduce((max, tip) => Math.max(max, tip.id), 0)
    const roadTipIds: number[] = []
    for (const village of villages) {
      for (const road of roads) {
        const along = `${road['起点位置'] ?? ''}${road['终点位置'] ?? ''}`
        if (!String(along).includes(village)) continue
        // 同一活动同一路线只保留一版提示（重复归档去重）。
        const existing = coverage.roadTips.find(
          (tip) => tip.campaignId === campaignId && tip.roadId === Number(road.id),
        )
        const tipText = `沿线已开展${method}，经过${village}路段注意护林员引导与防火横幅`
        if (existing) {
          existing.village = village
          existing.tip = tipText
          existing.publicityStatus = ARCHIVED_STATUS
          existing.updatedAt = stamp
          roadTipIds.push(existing.id)
        } else {
          roadSeq += 1
          const tip: RoadTipRow = {
            id: roadSeq,
            roadId: Number(road.id),
            roadCode: String(road['道路编号'] ?? ''),
            roadName: String(road['道路名称'] ?? ''),
            village,
            campaignId,
            campaignCode: code,
            tip: tipText,
            publicityStatus: ARCHIVED_STATUS,
            updatedAt: stamp,
          }
          coverage.roadTips.push(tip)
          roadTipIds.push(tip.id)
        }
      }
    }

    // 阶段三：写检查站宣传提醒。
    if (stageFails('检查站宣传提醒', campaignId)) {
      throw new ArchiveStageError('检查站宣传提醒', `活动 ${code} 检查站宣传提醒写入失败`)
    }
    const checkpoints = draft.entries.checkpoint ?? []
    let checkpointSeq = coverage.checkpointTips.reduce((max, tip) => Math.max(max, tip.id), 0)
    const checkpointTipIds: number[] = []
    for (const village of villages) {
      for (const station of checkpoints) {
        if (!String(station['站点位置'] ?? '').includes(village)) continue
        const existing = coverage.checkpointTips.find(
          (tip) => tip.campaignId === campaignId && tip.checkpointId === Number(station.id),
        )
        const reminder = `对往${village}方向进山群众做${method}提醒，收缴火种并登记`
        if (existing) {
          existing.village = village
          existing.reminder = reminder
          existing.publicityStatus = ARCHIVED_STATUS
          existing.updatedAt = stamp
          checkpointTipIds.push(existing.id)
        } else {
          checkpointSeq += 1
          const tip: CheckpointTipRow = {
            id: checkpointSeq,
            checkpointId: Number(station.id),
            checkpointCode: String(station['站点编号'] ?? ''),
            site: String(station['站点位置'] ?? ''),
            village,
            campaignId,
            campaignCode: code,
            reminder,
            publicityStatus: ARCHIVED_STATUS,
            updatedAt: stamp,
          }
          coverage.checkpointTips.push(tip)
          checkpointTipIds.push(tip.id)
        }
      }
    }

    outcome = {
      campaignId,
      campaignCode: code,
      villages,
      source,
      audience,
      method,
      archivedAt: stamp,
      roadTipIds,
      checkpointTipIds,
    }
    coverage.outcomes.push(outcome)
    coverage.archivedCampaignIds = [...coverage.archivedCampaignIds, campaignId]
  })
  if (!outcome) {
    throw new Error(`活动 ${campaignId} 归档未产生结果，已整体回退`)
  }
  return outcome
}

const NEGATIVE_VERBS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/**
 * 防火宣传模块的状态动作专用入口：活动状态与道路沿线提示清单、检查站提醒
 * 在同一事务里更新，任一笔失败整体回退。
 */
export function applyCampaignAction(
  campaignId: number,
  action: string,
  target: string,
  statuses: string[],
): void {
  const lastStatus = statuses[statuses.length - 1]
  commitArchive((draft) => {
    const campaigns = draft.entries.campaign ?? []
    const index = campaigns.findIndex((row) => Number(row.id) === campaignId)
    if (index < 0) {
      throw new Error(`没有找到编号为 ${campaignId} 的防火宣传活动`)
    }
    campaigns[index] = {
      ...campaigns[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_VERBS.some((verb) => action.startsWith(verb)),
    }
    const stamp = nowText()
    for (const tip of draft.coverage.roadTips) {
      if (tip.campaignId === campaignId) {
        tip.publicityStatus = target
        tip.updatedAt = stamp
      }
    }
    for (const tip of draft.coverage.checkpointTips) {
      if (tip.campaignId === campaignId) {
        tip.publicityStatus = target
        tip.updatedAt = stamp
      }
    }
  })
}

// ---------- 批次归档 ----------

let inFlight: Promise<BatchOutcome> | null = null
let batchSeq = 0

/** 仅供测试：清掉在途批次与定向故障，避免模块单例状态跨用例泄漏。 */
export function __resetBatchState(): void {
  inFlight = null
  batchSeq = 0
  stageFailureCampaign = null
  pendingStageFailure = null
}

function archivableCampaigns(coverage: { archivedCampaignIds: number[] }): EntryRow[] {
  return listRows('campaign')
    .filter((row) => !coverage.archivedCampaignIds.includes(Number(row.id)))
    .filter((row) => String(row.status) !== CANCELLED_STATUS)
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/**
 * 批次归档：
 * - 并发触发只兑现同一个在途 Promise，只生成一份结果；
 * - 没有新的未归档活动时复用上一批次结果，不产生第二版；
 * - 中断（某活动三写入失败回退）后再次执行，自动从未归档活动继续。
 */
export function runArchiveBatch(): Promise<BatchOutcome> {
  if (inFlight) {
    return inFlight
  }
  const promise = (async () => {
    const before = getCoverage()
    const pending = archivableCampaigns(before)
    const cancelled = listRows('campaign').filter((row) => String(row.status) === CANCELLED_STATUS)

    // 没有新活动：并发/重复操作只保留上一版结果。
    if (pending.length === 0 && before.lastBatch) {
      return { ...before.lastBatch, reused: true }
    }

    const startedAt = nowText()
    batchSeq += 1
    const result: BatchOutcome = {
      dedupeKey: `BATCH-${startedAt.replace(/[-: ]/g, '')}-${String(batchSeq).padStart(3, '0')}`,
      startedAt,
      finishedAt: '',
      resumed: before.archivedCampaignIds.length > 0 || (before.lastBatch?.failed.length ?? 0) > 0,
      reused: false,
      archived: [],
      skipped: cancelled.map((row) => ({
        campaignId: Number(row.id),
        reason: '活动已取消',
      })),
      failed: [],
    }

    for (const row of pending) {
      try {
        result.archived.push(archiveCampaign(Number(row.id)))
      } catch (error) {
        if (error instanceof ArchiveStageError) {
          result.failed.push({
            campaignId: Number(row.id),
            stage: error.stage,
            message: error.message,
          })
        } else {
          result.failed.push({
            campaignId: Number(row.id),
            stage: '宣传状态',
            message: error instanceof Error ? error.message : '归档失败',
          })
        }
        // 该笔已整体回退，批次在此中断；下次从未归档活动继续。
        break
      }
    }

    result.finishedAt = nowText()
    commitArchive((draft) => {
      draft.coverage.lastBatch = result
    })
    return result
  })()

  inFlight = promise.finally(() => {
    inFlight = null
  })
  return inFlight
}

// ---------- 报告 ----------

export type ReportFile = { filename: string; content: string }

/** 受众人数报告：按覆盖村组汇总已归档活动的受众。 */
export function buildAudienceReport(): ReportFile {
  const { outcomes, roster } = getCoverage()
  const byVillage = new Map<string, { count: number; audience: number }>()
  for (const outcome of outcomes) {
    for (const village of outcome.villages) {
      const bucket = byVillage.get(village) ?? { count: 0, audience: 0 }
      bucket.count += 1
      bucket.audience += roster.find((row) => row.village === village)?.audience ?? 0
      byVillage.set(village, bucket)
    }
  }
  const lines = ['归档受众人数报告', [`生成时间`, nowText()].map(csvCell).join(','), '', '覆盖村组,归档活动数,受众人数']
  let totalAudience = 0
  for (const [village, bucket] of [...byVillage.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    totalAudience += bucket.audience
    lines.push([village, bucket.count, bucket.audience].map(csvCell).join(','))
  }
  lines.push(['合计', outcomes.length, totalAudience].map(csvCell).join(','))
  return { filename: `归档受众人数报告-${nowText().slice(0, 10)}.csv`, content: `﻿${lines.join('\n')}` }
}

/** 宣传方式分布报告：按宣传方式统计活动占比与受众。 */
export function buildMethodReport(): ReportFile {
  const { outcomes } = getCoverage()
  const byMethod = new Map<string, { count: number; audience: number }>()
  for (const outcome of outcomes) {
    const bucket = byMethod.get(outcome.method) ?? { count: 0, audience: 0 }
    bucket.count += 1
    bucket.audience += outcome.audience
    byMethod.set(outcome.method, bucket)
  }
  const total = outcomes.length
  const lines = ['宣传方式分布报告', [`生成时间`, nowText()].map(csvCell).join(','), '', '宣传方式,归档活动数,占比,受众人数']
  let totalAudience = 0
  for (const [method, bucket] of [...byMethod.entries()].sort((a, b) => b[1].count - a[1].count)) {
    totalAudience += bucket.audience
    const ratio = total === 0 ? '0%' : `${((bucket.count / total) * 100).toFixed(1)}%`
    lines.push([method, bucket.count, ratio, bucket.audience].map(csvCell).join(','))
  }
  lines.push(['合计', total, '100%', totalAudience].map(csvCell).join(','))
  return { filename: `宣传方式分布报告-${nowText().slice(0, 10)}.csv`, content: `﻿${lines.join('\n')}` }
}
