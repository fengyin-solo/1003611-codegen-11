import {
  commitCampaignsAndCoverage,
  listRows,
  readCoverage,
  writeCoverage,
} from '@/data/local-store'
import {
  ARCHIVED_STATUS,
  type ArchiveRecord,
  type BatchState,
  type CheckpointNotice,
  type CoverageState,
  type RoadNotice,
  type StoredDoc,
  advanceBatch,
  buildCoverageReport,
  campaignsNeedingArchive,
  emptyCoverage,
  finishBatch,
  importRoster,
  initOrResumeBatch,
  planArchive,
  reconcileNotices,
  rosterTemplate,
} from '@/data/coverage-core'
import type { EntryRow } from '@/data/types'

// 覆盖归档台的存取与异步编排层：
// 纯规则在 coverage-core，本文件负责读写本地文档、批次中断续跑、并发只出一份结果。

function nowText(): string {
  return new Date().toISOString()
}

function currentDoc(): StoredDoc {
  return {
    campaign: listRows('campaign'),
    forestroad: listRows('forestroad'),
    checkpoint: listRows('checkpoint'),
    coverage: readCoverage<CoverageState>(emptyCoverage()),
  }
}

function saveCoverage(state: CoverageState): void {
  writeCoverage(state)
}

export type CampaignArchiveRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | ArchiveRecord | undefined
  archive?: ArchiveRecord
  needsArchive: boolean
  rosterCount: number
}

export type CoverageView = {
  campaigns: CampaignArchiveRow[]
  roadNotices: RoadNotice[]
  checkpointNotices: CheckpointNotice[]
  batch: BatchState | null
  rosterVersion: number
  archivedCount: number
  audienceTotal: number
}

function view(): CoverageView {
  const doc = currentDoc()
  const needingIds = new Set(campaignsNeedingArchive(doc).map((row) => Number(row.id)))
  const records = Object.values(doc.coverage.archives)
  return {
    campaigns: doc.campaign.map((row): CampaignArchiveRow => ({
      ...row,
      archive: doc.coverage.archives[Number(row.id)],
      needsArchive: needingIds.has(Number(row.id)),
      rosterCount: doc.coverage.roster[Number(row.id)]?.length ?? 0,
    })),
    roadNotices: [...doc.coverage.roadNotices].sort((a, b) =>
      a.更新时间 < b.更新时间 ? 1 : -1,
    ),
    checkpointNotices: [...doc.coverage.checkpointNotices].sort((a, b) =>
      a.更新时间 < b.更新时间 ? 1 : -1,
    ),
    batch: doc.coverage.batch,
    rosterVersion: doc.coverage.rosterVersion,
    archivedCount: records.length,
    audienceTotal: records.reduce((sum, item) => sum + item.受众人数, 0),
  }
}

export type ServiceMessage = { ok: boolean; message: string; warnings: string[] }

// ---------- 名单导入与报告 ----------

export function importRosterText(text: string): ServiceMessage {
  const doc = currentDoc()
  const result = importRoster(doc, text)
  if (!result.ok) {
    return { ok: false, message: result.message, warnings: result.errors }
  }
  saveCoverage(result.state)
  return { ok: true, message: result.message, warnings: [] }
}

export function downloadRosterTemplate(): void {
  downloadText('村组名单模板.csv', rosterTemplate(), 'text/csv;charset=utf-8')
}

export function downloadCoverageReport(): void {
  const { filename, content } = buildCoverageReport(currentDoc().coverage)
  downloadText(filename, content, 'text/csv;charset=utf-8')
}

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---------- 单活动归档：宣传状态 + 道路提示 + 检查站提醒一次原子提交 ----------

export function archiveOne(id: number): ServiceMessage {
  const doc = currentDoc()
  if (doc.coverage.batch?.state === 'running') {
    return {
      ok: false,
      message: `批次 ${doc.coverage.batch.id} 正在归档中，请等批次结束后再单活动归档`,
      warnings: [],
    }
  }
  let outcome
  try {
    outcome = planArchive(doc, id, nowText(), `MANUAL-${id}`)
  } catch (error) {
    return {
      ok: false,
      message: `归档失败，未写入任何数据：${error instanceof Error ? error.message : '未知错误'}`,
      warnings: [],
    }
  }
  if (outcome.code === 'skipped') {
    return { ok: false, message: outcome.message, warnings: outcome.warnings }
  }
  // 单键单次提交：commit 抛错时缓存与存储都不会更新，天然整体回退。
  commitCampaignsAndCoverage(outcome.doc.campaign, outcome.doc.coverage)
  return { ok: true, message: outcome.message, warnings: outcome.warnings }
}

// ---------- 道路 / 检查站页面读取同步清单 ----------

export function listRoadNotices(): RoadNotice[] {
  return view().roadNotices
}

export function listCheckpointNotices(): CheckpointNotice[] {
  return view().checkpointNotices
}

// 活动状态在别处被改动后，调用本函数把提示清单上的宣传状态对齐。
export function syncNoticeStatuses(): void {
  const doc = currentDoc()
  const next = reconcileNotices(doc.coverage, doc.campaign, nowText())
  if (next !== doc.coverage) saveCoverage(next)
}

// ---------- 批次：并发只跑一份、中断从未归档活动续跑 ----------

const LOCK_NAME = 'forest-fire-patrol:coverage-batch'
const HOLDER_ID = `tab-${Math.random().toString(36).slice(2, 8)}`
const STEP_DELAY = 120
let inflight: Promise<BatchState> | null = null

type LockLike = {
  readonly mode: 'exclusive'
  readonly name: string
}
type LocksApi = {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: boolean },
    callback: (lock: LockLike | null) => Promise<BatchState>,
  ): Promise<BatchState>
}

function locks(): LocksApi | null {
  const api = (navigator as Navigator & { locks?: LocksApi }).locks
  return api && typeof api.request === 'function' ? api : null
}

async function runExclusiveBatch(): Promise<BatchState> {
  const api = locks()
  if (api) {
    // ifAvailable 拿不到锁说明别的标签页正在归档：不排队、不产生第二份结果。
    return api.request(
      LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw new Error('另一个窗口正在执行归档批次，本窗口不重复执行')
        }
        return runBatchSteps()
      },
    )
  }
  // 无 Web Locks 的环境用批次状态里的锁标记兜底。
  const batch = currentDoc().coverage.batch
  if (batch && batch.state === 'running' && batch.lockHolder !== HOLDER_ID) {
    throw new Error('另一个窗口正在执行归档批次，本窗口不重复执行')
  }
  return runBatchSteps()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function runBatchSteps(): Promise<BatchState> {
  let doc = currentDoc()
  const wasInterrupted = doc.coverage.batch?.state === 'interrupted'
  if (!wasInterrupted) {
    const targets = campaignsNeedingArchive(doc).map((row) => Number(row.id))
    if (targets.length === 0) {
      const empty: BatchState = {
        id: `BATCH-${Date.now()}`,
        state: 'done',
        startedAt: nowText(),
        updatedAt: nowText(),
        doneIds: [],
        pendingIds: [],
        skippedIds: [],
        failed: [],
        processed: 0,
        total: 0,
        results: [],
        lockHolder: HOLDER_ID,
      }
      saveCoverage({ ...doc.coverage, batch: empty })
      return empty
    }
    const fresh = initOrResumeBatch(doc, nowText(), HOLDER_ID, targets.length, targets)
    saveCoverage({ ...doc.coverage, batch: fresh })
  }

  // 每轮重新读盘：中断标记落盘后，处理完当前活动即停下；剩余活动留给下次续跑。
  for (;;) {
    doc = currentDoc()
    const batch = doc.coverage.batch
    if (!batch) throw new Error('批次状态丢失，已中止')
    if (batch.state === 'interrupted' || batch.pendingIds.length === 0) break

    const id = batch.pendingIds[0]
    const progress = advanceBatch(
      doc.coverage,
      doc.campaign,
      doc.forestroad,
      doc.checkpoint,
      batch,
      id,
      nowText(),
    )
    // 每个活动一次原子提交；单个活动失败只回退自己，已提交的活动不受影响。
    commitCampaignsAndCoverage(progress.campaigns, progress.state)
    await sleep(STEP_DELAY)
  }

  doc = currentDoc()
  const lastBatch = doc.coverage.batch
  if (!lastBatch) throw new Error('批次状态丢失，已中止')
  const stopped = lastBatch.pendingIds.length > 0
  const finalBatch = finishBatch(lastBatch, nowText(), stopped)
  const reconciled = reconcileNotices(
    { ...doc.coverage, batch: finalBatch },
    doc.campaign,
    nowText(),
  )
  saveCoverage(reconciled)
  return finalBatch
}

export function startBatch(): Promise<BatchState> {
  // 并发操作只生成一份结果：同一标签页内直接复用进行中的 Promise。
  if (inflight) return inflight
  inflight = runExclusiveBatch()
    .catch((error: Error) => {
      // 只有自己持有的批次才落成 interrupted；抢锁失败时不能动别的窗口的批次。
      const latest = currentDoc()
      if (
        latest.coverage.batch?.state === 'running' &&
        latest.coverage.batch.lockHolder === HOLDER_ID
      ) {
        saveCoverage({
          ...latest.coverage,
          batch: finishBatch(latest.coverage.batch, nowText(), true),
        })
      }
      throw error
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// 中断当前批次：落一个 interrupted 标记，跑批循环在处理完当前活动后停下。
export function interruptBatch(): ServiceMessage {
  const doc = currentDoc()
  const batch = doc.coverage.batch
  if (!batch || batch.state !== 'running') {
    return { ok: false, message: '当前没有进行中的归档批次', warnings: [] }
  }
  saveCoverage({ ...doc.coverage, batch: finishBatch(batch, nowText(), true) })
  return {
    ok: true,
    message: `批次 ${batch.id} 已请求中断，将在当前活动完成后停止，剩余 ${batch.pendingIds.length} 个活动可续跑`,
    warnings: [],
  }
}

export { ARCHIVED_STATUS, view as coverageView }
