// 统一的浏览器键值读写：业务清单与覆盖归档共用同一套持久化，
// 归档事务跨键写入时可整体回退；测试时可替换成内存/故障实现。
export type KVAdapter = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserKV(): KVAdapter | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  }
}

let adapter: KVAdapter | null = browserKV()

export function getKV(): KVAdapter | null {
  return adapter
}

/** 仅供测试：换成内存 KV 或会抛错的 KV，验证提交失败后的回退。 */
export function __setKVAdapter(next: KVAdapter | null): void {
  adapter = next
}
