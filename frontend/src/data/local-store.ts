import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：业务数据与覆盖归档子文档共用同一个 localStorage 键，
// 归档要同时改宣传活动、道路提示、检查站提醒，单键单次写入才能整体成功或整体回退。
const STORAGE_KEY = 'forest-fire-patrol:entries'
export const COVERAGE_KEY = '__coverage__'

type StoredDoc = {
  [key: string]: EntryRow[] | unknown
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyCoverage(): Record<string, never> {
  return {}
}

function readStorageDoc(): StoredDoc {
  const fallback: StoredDoc = { ...clone(SEED_ROWS), [COVERAGE_KEY]: emptyCoverage() }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredDoc
    const coverage =
      parsed[COVERAGE_KEY] && typeof parsed[COVERAGE_KEY] === 'object'
        ? parsed[COVERAGE_KEY]
        : emptyCoverage()
    return { ...fallback, ...parsed, [COVERAGE_KEY]: coverage }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoredDoc | null = null

function doc(): StoredDoc {
  if (cache === null) {
    cache = readStorageDoc()
  }
  return cache
}

function persist(next: StoredDoc): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    // 单次写入：浏览器要么收下整份文档，要么抛错，调用方据此整体回退。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

function rowsOnly(source: StoredDoc): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key !== COVERAGE_KEY && Array.isArray(value)) {
      result[key] = value as EntryRow[]
    }
  }
  return result
}

export function allRows(): Record<string, EntryRow[]> {
  return rowsOnly(doc())
}

export function listRows(key: string): EntryRow[] {
  const value = doc()[key]
  return Array.isArray(value) ? (value as EntryRow[]) : []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...doc(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  persist({ ...doc(), [key]: rows })
  return rows
}

// 读取覆盖归档子文档，缺省结构由调用方（coverage-core.emptyCoverage）提供。
export function readCoverage<T>(fallback: T): T {
  const value = doc()[COVERAGE_KEY]
  if (value && typeof value === 'object' && Object.keys(value).length > 0) {
    return clone(value) as T
  }
  return clone(fallback)
}

export function writeCoverage<T>(state: T): void {
  persist({ ...doc(), [COVERAGE_KEY]: state })
}

// 归档活动的唯一落库入口：宣传活动行与归档产物一起写，任一环节抛错都不会留下半份数据。
export function commitCampaignsAndCoverage(
  campaigns: EntryRow[],
  coverage: unknown,
): void {
  persist({ ...doc(), campaign: campaigns, [COVERAGE_KEY]: coverage })
}

export function storageKey(): string {
  return STORAGE_KEY
}
