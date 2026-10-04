import { allRows, commitEntries } from './local-store'
import { getKV } from './kv'
import type { CoverageState, EntryRow } from './types'

// 覆盖归档台的持久化：与业务清单分开存，但归档事务要把两边一起提交、一起回退。
const COVERAGE_KEY = 'forest-fire-patrol:coverage'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function initialCoverage(): CoverageState {
  return {
    roster: [
      { village: '青松村', audience: 50 },
      { village: '云岭村', audience: 45 },
      { village: '红枫村', audience: 55 },
      { village: '翠谷村', audience: 40 },
      { village: '白桦村', audience: 60 },
      { village: '石崖村', audience: 35 },
    ],
    rosterImportedAt: '',
    archivedCampaignIds: [],
    outcomes: [],
    roadTips: [],
    checkpointTips: [],
    lastBatch: null,
  }
}

function readCoverage(): CoverageState {
  const kv = getKV()
  if (!kv) {
    return initialCoverage()
  }
  const raw = kv.getItem(COVERAGE_KEY)
  if (!raw) {
    return initialCoverage()
  }
  try {
    return { ...initialCoverage(), ...(JSON.parse(raw) as CoverageState) }
  } catch {
    return initialCoverage()
  }
}

let coverageCache: CoverageState | null = null

export function getCoverage(): CoverageState {
  if (coverageCache === null) {
    coverageCache = readCoverage()
  }
  return coverageCache
}

/** 仅供测试：重置内存缓存，配合替换 KV 适配器使用。 */
export function __resetCoverageCache(): void {
  coverageCache = null
}

export type ArchiveDraft = {
  coverage: CoverageState
  entries: Record<string, EntryRow[]>
}

/**
 * 归档事务：宣传状态、林区道路沿线提示清单、检查站宣传提醒在同一笔事务里提交。
 * 任一笔写入（修改器抛错或持久化失败）都不提交，整体回退到事务前快照。
 */
export function commitArchive(
  mutate: (draft: ArchiveDraft) => void,
): void {
  const entriesSnapshot = allRows()
  const coverageSnapshot = getCoverage()
  const draft: ArchiveDraft = {
    coverage: clone(coverageSnapshot),
    entries: clone(entriesSnapshot),
  }
  // 阶段一：在内存副本上完成三笔写入，任一失败直接抛错，缓存与存储都不动。
  mutate(draft)
  // 阶段二：先提交归档状态，再提交业务清单；第二个键写失败时回滚第一个键。
  const kv = getKV()
  try {
    coverageCache = draft.coverage
    if (kv) {
      kv.setItem(COVERAGE_KEY, JSON.stringify(draft.coverage))
    }
  } catch (error) {
    coverageCache = coverageSnapshot
    throw new Error(`归档状态写入失败，已整体回退：${(error as Error).message}`)
  }
  try {
    commitEntries(draft.entries)
  } catch (error) {
    coverageCache = coverageSnapshot
    if (kv) {
      kv.setItem(COVERAGE_KEY, JSON.stringify(coverageSnapshot))
    }
    throw new Error(`宣传状态写入失败，已整体回退：${(error as Error).message}`)
  }
}
