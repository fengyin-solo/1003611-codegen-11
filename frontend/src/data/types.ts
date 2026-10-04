/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 覆盖归档台的领域类型：与全栈版归档服务的返回结构保持一致。

/** 村组名册行：导入的村组名单，受众人数缺失时按默认值估算。 */
export type VillageRow = {
  village: string
  audience: number
}

/** 归档写入失败时的阶段标记，用于定位回退发生在哪一笔写入。 */
export type ArchiveStage = '宣传状态' | '道路提示清单' | '检查站宣传提醒'

/** 单个活动的归档结果：宣传 -> 道路 -> 检查站沿既有数据流一路落库。 */
export type ArchiveOutcome = {
  campaignId: number
  campaignCode: string
  villages: string[]
  /** 归属来源：名册（文件）或按活动日期补归属。 */
  source: '名册' | '日期补归属'
  audience: number
  method: string
  archivedAt: string
  roadTipIds: number[]
  checkpointTipIds: number[]
}

export type BatchOutcome = {
  /** 同一批次并发触发时复用同一个结果键，只生成一份结果。 */
  dedupeKey: string
  startedAt: string
  finishedAt: string
  /** 中断后重跑时为 true，会从未归档活动继续。 */
  resumed: boolean
  /** 并发触发命中已有结果时为 true，不再产生第二版。 */
  reused: boolean
  archived: ArchiveOutcome[]
  skipped: { campaignId: number; reason: string }[]
  /** 单笔活动三写入中任一失败：该笔整体回退，其余活动继续，批次记录中断点。 */
  failed: { campaignId: number; stage: ArchiveStage; message: string }[]
}

export type CoverageState = {
  roster: VillageRow[]
  rosterImportedAt: string
  /** 已归档活动 id：断点续跑、并发去重都查这里。 */
  archivedCampaignIds: number[]
  outcomes: ArchiveOutcome[]
  /** 林区道路沿线提示清单：宣传状态沿数据流同步到这里。 */
  roadTips: RoadTipRow[]
  /** 检查站宣传提醒：同一批归档事务写入。 */
  checkpointTips: CheckpointTipRow[]
  lastBatch: BatchOutcome | null
}

export type RoadTipRow = {
  id: number
  roadId: number
  roadCode: string
  roadName: string
  village: string
  campaignId: number
  campaignCode: string
  tip: string
  publicityStatus: string
  updatedAt: string
}

export type CheckpointTipRow = {
  id: number
  checkpointId: number
  checkpointCode: string
  site: string
  village: string
  campaignId: number
  campaignCode: string
  reminder: string
  publicityStatus: string
  updatedAt: string
}

export type RosterImportResult = {
  importedAt: string
  /** 本次新文件相对历史名册新增/覆盖/失效的村组数。 */
  added: number
  replaced: number
  retired: number
  total: number
  roster: VillageRow[]
}
