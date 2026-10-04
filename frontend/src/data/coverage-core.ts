import type { EntryRow } from './types.js'

// 覆盖归档台的全部业务规则集中在本文件，且不碰 DOM/localStorage：
// 名册导入、按活动日期补归属、归档计划、批次推进、报告生成都在这里算清楚，
// service 层只负责存取和异步编排，规则可在 Node 下直接单测。

export const ARCHIVED_STATUS = '已归档'
export const CANCELED_STATUS = '已取消'
const COMPLETED_STATUS = '已完成'

export type RosterLine = {
  村组名称: string
  受众人数: number
  宣传方式: string
}

export type NoticeStatus = '生效中' | '已更新' | '活动已注销'

export type RoadNotice = {
  id: string
  道路编号: string
  道路名称: string
  覆盖村组: string
  宣传方式: string
  活动编号: string
  宣传活动状态: string
  提示内容: string
  发布日期: string
  状态: NoticeStatus
  更新时间: string
}

export type CheckpointNotice = {
  id: string
  站点编号: string
  站点位置: string
  覆盖村组: string
  活动编号: string
  宣传活动状态: string
  提醒内容: string
  提醒日期: string
  状态: NoticeStatus
  更新时间: string
}

export type ArchiveRecord = {
  活动编号: string
  活动id: number
  宣传主题: string
  宣传方式: string
  覆盖村组: string[]
  受众人数: number
  活动日期: string
  宣传活动状态: string
  归档时间: string
  归档批次: string
  版本: number
  名册版本: number
  是否补归属: boolean
  命中道路数: number
  命中检查站数: number
}

export type BatchState = {
  id: string
  state: 'running' | 'interrupted' | 'done'
  startedAt: string
  updatedAt: string
  doneIds: number[]
  pendingIds: number[]
  skippedIds: number[]
  failed: { id: number; code: string; message: string }[]
  processed: number
  total: number
  results: { id: number; ok: boolean; code: string; message: string }[]
  lockHolder: string
}

export type CoverageState = {
  rosterVersion: number
  roster: Record<number, RosterLine[]>
  archives: Record<number, ArchiveRecord>
  roadNotices: RoadNotice[]
  checkpointNotices: CheckpointNotice[]
  batch: BatchState | null
}

export type StoredDoc = {
  campaign: EntryRow[]
  forestroad: EntryRow[]
  checkpoint: EntryRow[]
  coverage: CoverageState
}

export function emptyCoverage(): CoverageState {
  return {
    rosterVersion: 0,
    roster: {},
    archives: {},
    roadNotices: [],
    checkpointNotices: [],
    batch: null,
  }
}

export type ImportResult = {
  ok: boolean
  message: string
  replaced: number[]
  state: CoverageState
  errors: string[]
}

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += char
    }
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row)
  return rows
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvLine(cells: (string | number)[]): string {
  return cells.map(csvCell).join(',')
}

// ---------- 导入村组名单 ----------
// 决策：同一活动重复导入以新文件为准——新文件里出现的活动，其村组行整批替换；
// 文件里没出现的活动保留历史名册。
export function importRoster(doc: StoredDoc, text: string): ImportResult {
  const grid = parseCsv(text)
  if (grid.length < 2) {
    return {
      ok: false,
      message: '名单文件没有数据行，请按模板填写后再导入',
      replaced: [],
      state: doc.coverage,
      errors: [],
    }
  }
  const header = grid[0].map((cell) => cell.trim())
  const columnOf = (name: string) => header.findIndex((cell) => cell === name)
  const codeColumn = columnOf('活动编号')
  const groupColumn = columnOf('村组名称')
  const audienceColumn = columnOf('受众人数')
  const methodColumn = columnOf('宣传方式')
  if (codeColumn < 0 || groupColumn < 0) {
    return {
      ok: false,
      message: '名单缺少必需列：至少需要「活动编号」和「村组名称」两列',
      replaced: [],
      state: doc.coverage,
      errors: [],
    }
  }

  const codeToId = new Map<string, number>()
  for (const row of doc.campaign) {
    codeToId.set(String(row['活动编号'] ?? '').trim(), Number(row.id))
  }

  const incoming = new Map<number, RosterLine[]>()
  const errors: string[] = []
  grid.slice(1).forEach((cells, index) => {
    const lineNo = index + 2
    const get = (column: number) => (column >= 0 ? (cells[column] ?? '').trim() : '')
    const code = get(codeColumn)
    const group = get(groupColumn)
    if (code === '' && group === '') return
    if (code === '') {
      errors.push(`第${lineNo}行：缺少活动编号`)
      return
    }
    if (group === '') {
      errors.push(`第${lineNo}行：缺少村组名称`)
      return
    }
    const id = codeToId.get(code)
    if (id === undefined) {
      errors.push(`第${lineNo}行：活动编号 ${code} 在防火宣传活动中不存在`)
      return
    }
    let audience = 0
    const audienceText = get(audienceColumn)
    if (audienceText !== '') {
      const parsed = Number(audienceText)
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push(`第${lineNo}行：受众人数「${audienceText}」不是非负整数`)
        return
      }
      audience = parsed
    }
    const line: RosterLine = {
      村组名称: group,
      受众人数: audience,
      宣传方式: get(methodColumn),
    }
    const bucket = incoming.get(id)
    if (bucket) bucket.push(line)
    else incoming.set(id, [line])
  })

  if (errors.length > 0) {
    return {
      ok: false,
      message: `名单校验未通过，未写入任何记录（共 ${errors.length} 处问题）`,
      replaced: [],
      state: doc.coverage,
      errors,
    }
  }
  if (incoming.size === 0) {
    return {
      ok: false,
      message: '名单中没有可导入的有效行',
      replaced: [],
      state: doc.coverage,
      errors: [],
    }
  }

  const merged: Record<number, RosterLine[]> = { ...doc.coverage.roster }
  let unchanged = 0
  for (const [id, lines] of incoming) {
    const before = JSON.stringify(merged[id] ?? [])
    const after = JSON.stringify(lines)
    if (before === after) {
      unchanged += 1
      continue
    }
    merged[id] = lines
  }
  const replaced = [...incoming.keys()]
  const changed = replaced.length - unchanged
  const state: CoverageState = {
    ...doc.coverage,
    roster: merged,
    rosterVersion: doc.coverage.rosterVersion + (changed > 0 ? 1 : 0),
  }
  return {
    ok: true,
    message:
      changed > 0
        ? `名单已导入：更新 ${changed} 个活动的村组名册${
            unchanged > 0 ? `，${unchanged} 个活动内容无变化` : ''
          }；已归档活动需重新归档后同步下游清单`
        : `名单与现有内容一致（${unchanged} 个活动），未产生新版本`,
    replaced,
    state,
    errors: [],
  }
}

export function rosterTemplate(): string {
  return '﻿活动编号,村组名称,受众人数,宣传方式\nCAMP-0001,青山一组,58,院坝宣讲\nCAMP-0001,青山二组,46,院坝宣讲\n'
}

// ---------- 覆盖归属 ----------

export function splitGroups(text: string): string[] {
  return text
    .split(/[、,，;；/／\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

// 村组候选池：名单村组 + 道路起点/终点/名称 + 检查站位置，去重保持稳定顺序。
export function knownGroupPool(doc: StoredDoc): string[] {
  const pool: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    const text = String(value ?? '').trim()
    if (text && !seen.has(text)) {
      seen.add(text)
      pool.push(text)
    }
  }
  for (const lines of Object.values(doc.coverage.roster)) {
    for (const line of lines) add(line.村组名称)
  }
  for (const road of doc.forestroad) {
    add(road['起点位置'])
    add(road['终点位置'])
    add(road['道路名称'])
  }
  for (const station of doc.checkpoint) add(station['站点位置'])
  return pool
}

export function groupMatches(group: string, target: unknown): boolean {
  const a = group.trim()
  const b = String(target ?? '').trim()
  if (a.length < 2 || b.length < 2) return false
  return a.includes(b) || b.includes(a)
}

// 日期哈希：旧记录缺覆盖村组时按活动日期做确定性补归属，同日期永远落到同一村组。
export function dateHash(text: string, size: number): number {
  let sum = 0
  for (const char of text) sum += char.charCodeAt(0)
  return sum % size
}

export type ResolvedGroups = {
  groups: string[]
  source: 'roster' | 'field' | 'dateFallback'
}

export function resolveCampaignGroups(
  doc: StoredDoc,
  campaign: EntryRow,
): ResolvedGroups {
  const rosterLines = doc.coverage.roster[Number(campaign.id)] ?? []
  if (rosterLines.length > 0) {
    return { groups: rosterLines.map((line) => line.村组名称), source: 'roster' }
  }
  const fieldGroups = splitGroups(String(campaign['覆盖村组'] ?? ''))
  if (fieldGroups.length > 0) return { groups: fieldGroups, source: 'field' }
  const pool = knownGroupPool(doc)
  if (pool.length === 0) {
    throw new Error('没有可用的村组候选池：请先导入村组名单，或维护道路、检查站基础数据')
  }
  const date = String(campaign['活动日期'] ?? '')
  return { groups: [pool[dateHash(date, pool.length)]], source: 'dateFallback' }
}

// ---------- 归档计划与提交 ----------

export type ArchiveOutcome = {
  code: 'archived' | 'rearchived' | 'skipped'
  message: string
  warnings: string[]
  doc: StoredDoc
  record: ArchiveRecord | null
}

function rowAudience(row: EntryRow): number {
  const value = Number(row['受众人数'])
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function terminalStatus(status: string, pending: boolean): Pick<EntryRow, 'status' | 'pending'> {
  return { status, pending }
}

export function planArchive(doc: StoredDoc, id: number, now: string, batchId: string): ArchiveOutcome {
  const campaign = doc.campaign.find((item) => Number(item.id) === id)
  if (!campaign) {
    return { code: 'skipped', message: `没有找到编号为 ${id} 的宣传活动`, warnings: [], doc, record: null }
  }
  const currentStatus = String(campaign.status ?? '')
  if (currentStatus === CANCELED_STATUS) {
    return { code: 'skipped', message: '活动已取消，不参与归档', warnings: [], doc, record: null }
  }

  const resolved = resolveCampaignGroups(doc, campaign)
  const rosterLines = doc.coverage.roster[id] ?? []
  const rosterAudience = rosterLines.reduce((sum, line) => sum + line.受众人数, 0)
  const audience =
    rosterLines.length > 0
      ? rosterAudience
      : rowAudience(campaign)
  const methodFromRoster = [...rosterLines.map((line) => line.宣传方式).filter(Boolean)]
  const method =
    methodFromRoster[0] ?? String(campaign['宣传方式'] ?? '未登记宣传方式')
  const groups = [...new Set(resolved.groups)]

  const warnings: string[] = []
  const matchedRoads = doc.forestroad.filter((road) =>
    groups.some(
      (group) =>
        groupMatches(group, road['起点位置']) ||
        groupMatches(group, road['终点位置']) ||
        groupMatches(group, road['道路名称']),
    ),
  )
  const matchedStations = doc.checkpoint.filter((station) =>
    groups.some((group) => groupMatches(group, station['站点位置'])),
  )
  if (matchedRoads.length === 0) {
    warnings.push('覆盖村组未匹配到林区道路，本次不生成沿线提示')
  }
  if (matchedStations.length === 0) {
    warnings.push('覆盖村组未匹配到检查站，本次不生成检查宣传提醒')
  }

  const previous = doc.coverage.archives[id]
  const code = previous ? 'rearchived' : 'archived'
  const version = previous ? previous.版本 + 1 : 1
  const date = String(campaign['活动日期'] ?? '')

  const roadNotices: RoadNotice[] = matchedRoads.map((road) => ({
    id: `road:${id}:${String(road['道路编号'])}`,
    道路编号: String(road['道路编号'] ?? ''),
    道路名称: String(road['道路名称'] ?? ''),
    覆盖村组: groups.join('、'),
    宣传方式: method,
    活动编号: String(campaign['活动编号'] ?? ''),
    宣传活动状态: ARCHIVED_STATUS,
    提示内容: `${groups.join('、')}已开展${method}防火宣传，途经请注意沿线宣传标识，进山勿带火种`,
    发布日期: date,
    状态: '生效中',
    更新时间: now,
  }))
  const checkpointNotices: CheckpointNotice[] = matchedStations.map((station) => ({
    id: `checkpoint:${id}:${String(station['站点编号'])}`,
    站点编号: String(station['站点编号'] ?? ''),
    站点位置: String(station['站点位置'] ?? ''),
    覆盖村组: groups.join('、'),
    活动编号: String(campaign['活动编号'] ?? ''),
    宣传活动状态: ARCHIVED_STATUS,
    提醒内容: `${groups.join('、')}防火宣传已覆盖，值守时提醒进山群众落实宣传要求、上缴火种`,
    提醒日期: date,
    状态: '生效中',
    更新时间: now,
  }))

  const record: ArchiveRecord = {
    活动编号: String(campaign['活动编号'] ?? ''),
    活动id: id,
    宣传主题: String(campaign['宣传主题'] ?? ''),
    宣传方式: method,
    覆盖村组: groups,
    受众人数: audience,
    活动日期: date,
    宣传活动状态: ARCHIVED_STATUS,
    归档时间: now,
    归档批次: batchId,
    版本: version,
    名册版本: doc.coverage.rosterVersion,
    是否补归属: resolved.source === 'dateFallback',
    命中道路数: matchedRoads.length,
    命中检查站数: matchedStations.length,
  }

  // 同一活动只保留一版：先清掉本活动旧产物，再放入新产物，其他活动的产物不动。
  const nextRoadNotices = [
    ...doc.coverage.roadNotices.filter((item) => !item.id.startsWith(`road:${id}:`)),
    ...roadNotices,
  ]
  const nextCheckpointNotices = [
    ...doc.coverage.checkpointNotices.filter((item) => !item.id.startsWith(`checkpoint:${id}:`)),
    ...checkpointNotices,
  ]

  const nextCampaigns = doc.campaign.map((item) =>
    Number(item.id) === id
      ? {
          ...item,
          ...terminalStatus(ARCHIVED_STATUS, false),
          abnormal: false,
          覆盖村组: groups.join('、'),
          受众人数: audience,
          宣传方式: method,
          活动状态: ARCHIVED_STATUS,
        }
      : item,
  )

  const nextCoverage: CoverageState = {
    ...doc.coverage,
    archives: { ...doc.coverage.archives, [id]: record },
    roadNotices: nextRoadNotices,
    checkpointNotices: nextCheckpointNotices,
  }

  const nextDoc: StoredDoc = {
    ...doc,
    campaign: nextCampaigns,
    coverage: nextCoverage,
  }
  return {
    code,
    message:
      code === 'rearchived'
        ? `活动 ${record.活动编号} 已重新归档（第 ${version} 版），旧版结果已覆盖`
        : `活动 ${record.活动编号} 归档完成，受众 ${audience} 人，同步道路 ${matchedRoads.length} 条、检查站 ${matchedStations.length} 个`,
    warnings,
    doc: nextDoc,
    record,
  }
}

// 道路提醒清单同步宣传状态：活动状态发生变化（含被取消）后，所有提示与提醒一起对账。
export function reconcileNotices(state: CoverageState, campaigns: EntryRow[], now: string): CoverageState {
  const byId = new Map<number, EntryRow>(campaigns.map((row) => [Number(row.id), row]))
  const sync = <T extends { id: string; 活动编号: string; 宣传活动状态: string; 状态: NoticeStatus; 更新时间: string }>(
    notice: T,
  ): T => {
    const id = Number(notice.id.split(':')[1])
    const campaign = byId.get(id)
    if (!campaign) return notice
    const status = String(campaign.status ?? '')
    if (status === notice.宣传活动状态) return notice
    return {
      ...notice,
      宣传活动状态: status,
      状态: status === CANCELED_STATUS ? '活动已注销' : '已更新',
      更新时间: now,
    }
  }
  return {
    ...state,
    roadNotices: state.roadNotices.map(sync),
    checkpointNotices: state.checkpointNotices.map(sync),
  }
}

// 需要归档的活动：未取消，且（从未归档 或 归档后名册又导入过新版本）。
export function campaignsNeedingArchive(doc: StoredDoc): EntryRow[] {
  return doc.campaign.filter((campaign) => {
    if (String(campaign.status) === CANCELED_STATUS) return false
    const record = doc.coverage.archives[Number(campaign.id)]
    if (!record) return true
    return record.名册版本 < doc.coverage.rosterVersion
  })
}

// ---------- 批次 ----------

export function initOrResumeBatch(
  doc: StoredDoc,
  now: string,
  holder: string,
  total: number,
  pendingIds: number[],
): BatchState {
  const existing = doc.coverage.batch
  if (existing && existing.state === 'interrupted' && existing.pendingIds.length > 0) {
    return {
      ...existing,
      state: 'running',
      updatedAt: now,
      lockHolder: holder,
    }
  }
  return {
    id: `BATCH-${now.replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    state: 'running',
    startedAt: now,
    updatedAt: now,
    doneIds: [],
    pendingIds,
    skippedIds: [],
    failed: [],
    processed: 0,
    total,
    results: [],
    lockHolder: holder,
  }
}

export type BatchProgress = {
  state: CoverageState
  campaigns: EntryRow[]
  result: { id: number; ok: boolean; code: string; message: string }
}

// 批次内推进单个活动；校验类失败只记失败、不影响已归档活动（单活动自身仍保证原子）。
export function advanceBatch(
  state: CoverageState,
  campaigns: EntryRow[],
  forestroad: EntryRow[],
  checkpoint: EntryRow[],
  batch: BatchState,
  id: number,
  now: string,
): BatchProgress {
  const snapshot: StoredDoc = {
    campaign: campaigns,
    forestroad,
    checkpoint,
    coverage: state,
  }
  try {
    const outcome = planArchive(snapshot, id, now, batch.id)
    if (outcome.code === 'skipped') {
      const result = { id, ok: true, code: 'skipped', message: outcome.message }
      const nextBatch: BatchState = {
        ...batch,
        skippedIds: [...batch.skippedIds, id],
        processed: batch.processed + 1,
        pendingIds: batch.pendingIds.filter((item) => item !== id),
        results: [...batch.results, result],
        updatedAt: now,
      }
      return {
        state: { ...state, batch: nextBatch },
        campaigns,
        result,
      }
    }
    const result = { id, ok: true, code: outcome.code, message: outcome.message }
    const nextBatch: BatchState = {
      ...batch,
      doneIds: [...batch.doneIds, id],
      processed: batch.processed + 1,
      pendingIds: batch.pendingIds.filter((item) => item !== id),
      results: [...batch.results, result],
      updatedAt: now,
    }
    return {
      state: { ...outcome.doc.coverage, batch: nextBatch },
      campaigns: outcome.doc.campaign,
      result,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '归档失败，已回退本活动写入'
    const result = { id, ok: false, code: 'failed', message }
    const nextBatch: BatchState = {
      ...batch,
      failed: [...batch.failed, { id, code: 'failed', message }],
      processed: batch.processed + 1,
      pendingIds: batch.pendingIds.filter((item) => item !== id),
      results: [...batch.results, result],
      updatedAt: now,
    }
    // 失败时不采用 planArchive 的任何中间产物，整体回退到本活动归档前状态。
    return {
      state: { ...state, batch: nextBatch },
      campaigns,
      result,
    }
  }
}

export function finishBatch(batch: BatchState, now: string, interrupted = false): BatchState {
  const state = interrupted ? 'interrupted' : 'done'
  return { ...batch, state, updatedAt: now }
}

// ---------- 报告 ----------
// 一份 CSV 两个区段：受众人数按活动列示 + 宣传方式分布。
export function buildCoverageReport(state: CoverageState): { filename: string; content: string } {
  const records = Object.values(state.archives).sort((a, b) =>
    a.归档时间 < b.归档时间 ? -1 : 1,
  )
  const lines: string[] = []
  lines.push(csvLine(['防火宣传覆盖归档报告']))
  lines.push(csvLine(['生成时间', new Date().toISOString()]))
  lines.push('')
  lines.push(csvLine(['一、受众人数（按已归档活动）']))
  lines.push(csvLine(['活动编号', '宣传主题', '活动日期', '覆盖村组', '受众人数', '宣传方式', '是否补归属', '归档版本']))
  for (const record of records) {
    lines.push(
      csvLine([
        record.活动编号,
        record.宣传主题,
        record.活动日期,
        record.覆盖村组.join('、'),
        record.受众人数,
        record.宣传方式,
        record.是否补归属 ? '日期补归属' : '名册/登记',
        record.版本,
      ]),
    )
  }
  lines.push(csvLine(['合计', '', '', '', records.reduce((sum, item) => sum + item.受众人数, 0)]))
  lines.push('')
  lines.push(csvLine(['二、宣传方式分布']))
  lines.push(csvLine(['宣传方式', '活动场次', '受众人数', '场次占比']))
  const distribution = new Map<string, { sessions: number; audience: number }>()
  for (const record of records) {
    const bucket = distribution.get(record.宣传方式) ?? { sessions: 0, audience: 0 }
    bucket.sessions += 1
    bucket.audience += record.受众人数
    distribution.set(record.宣传方式, bucket)
  }
  const totalSessions = records.length || 1
  for (const [method, bucket] of [...distribution.entries()].sort((a, b) => b[1].audience - a[1].audience)) {
    lines.push(
      csvLine([method, bucket.sessions, bucket.audience, `${((bucket.sessions / totalSessions) * 100).toFixed(1)}%`]),
    )
  }
  return {
    filename: `防火宣传覆盖报告-${new Date().toISOString().slice(0, 10)}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}
