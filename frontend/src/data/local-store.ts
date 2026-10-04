import { SEED_ROWS } from './seed'
import { getKV } from './kv'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const kv = getKV()
  if (!kv) {
    return fallback
  }
  const raw = kv.getItem(STORAGE_KEY)
  if (!raw) {
    kv.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    kv.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  const kv = getKV()
  if (kv) {
    kv.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 归档事务专用：一次性提交多模块的完整数据。 */
export function commitEntries(next: Record<string, EntryRow[]>): void {
  cache = next
  const kv = getKV()
  if (kv) {
    kv.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/** 仅供测试：配合替换 KV 适配器重置内存缓存。 */
export function __resetEntriesCache(): void {
  cache = null
}
