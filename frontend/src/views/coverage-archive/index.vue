<template>
  <section class="page" data-module="coverage-archive">
    <header class="page-head">
      <div>
        <h2>防火宣传覆盖归档台</h2>
        <p class="page-desc">
          导入村组名单后归档宣传活动：同一活动重复导入以新文件为准，旧记录缺覆盖村组时按活动日期补归属；
          归档会一次更新宣传状态、林区道路沿线提示清单与检查站宣传提醒，任一写入失败整体回退。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="downloadTemplate">下载名单模板</button>
        <button class="btn" type="button" :disabled="view.archivedCount === 0" @click="downloadReport">
          下载受众人数与宣传方式分布报告
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">活动总数</span>
        <strong class="stat-value">{{ view.campaigns.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已归档活动</span>
        <strong class="stat-value">{{ view.archivedCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待归档活动</span>
        <strong class="stat-value">{{ pendingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">累计覆盖受众</span>
        <strong class="stat-value">{{ view.audienceTotal }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">道路沿线提示 / 检查站提醒</span>
        <strong class="stat-value">{{ view.roadNotices.length }} / {{ view.checkpointNotices.length }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3 class="panel-title">① 导入村组名单</h3>
      <p class="panel-hint">
        CSV 列：活动编号、村组名称、受众人数、宣传方式。同一活动再次导入时，新文件中的村组整批替换旧名册；
        名册版本：v{{ view.rosterVersion }}。
      </p>
      <div class="panel-actions">
        <input ref="fileInput" class="file-input" type="file" accept=".csv,text/csv" @change="onFilePicked" />
        <span v-if="importMessage" :class="importOk ? 'ok-text' : 'error-text'">{{ importMessage }}</span>
      </div>
      <ul v-if="importErrors.length" class="error-list">
        <li v-for="(item, index) in importErrors" :key="index">{{ item }}</li>
      </ul>
    </section>

    <section class="panel">
      <h3 class="panel-title">② 批次归档（中断后从未归档活动续跑，并发只生成一份结果）</h3>
      <div class="panel-actions">
        <button class="btn primary" type="button" :disabled="running" @click="runBatch">
          {{ canResume ? '续跑未归档活动' : '开始批量归档' }}
        </button>
        <button class="btn danger" type="button" :disabled="!running" @click="stopBatch">中断批次</button>
        <span v-if="batchMessage" :class="batchOk ? 'ok-text' : 'error-text'">{{ batchMessage }}</span>
      </div>
      <div v-if="batch" class="batch-box">
        <div class="batch-meta">
          <span>批次 {{ batch.id }}</span>
          <span>状态：{{ batchStateLabel }}</span>
          <span>进度：{{ batch.processed }}/{{ batch.total }}</span>
        </div>
        <div class="progress-track">
          <div class="progress-bar" :style="{ width: progressPercent + '%' }"></div>
        </div>
        <details class="batch-log">
          <summary>批次处理明细（成功 {{ batch.doneIds.length }} · 跳过 {{ batch.skippedIds.length }} · 失败 {{ batch.failed.length }}）</summary>
          <ul>
            <li v-for="(item, index) in batch.results" :key="index" :class="item.ok ? 'ok-text' : 'error-text'">
              活动 id {{ item.id }}：{{ item.code }} — {{ item.message }}
            </li>
          </ul>
        </details>
      </div>
    </section>

    <section class="panel">
      <h3 class="panel-title">③ 宣传活动归档清单</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>活动编号</th>
            <th>宣传主题</th>
            <th>活动日期</th>
            <th>宣传方式</th>
            <th>覆盖村组</th>
            <th>名册行数</th>
            <th>受众人数</th>
            <th>活动状态</th>
            <th>归档信息</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in view.campaigns" :key="String(row.id)">
            <td>{{ row['活动编号'] }}</td>
            <td>{{ row['宣传主题'] }}</td>
            <td>{{ row['活动日期'] }}</td>
            <td>{{ row['宣传方式'] }}</td>
            <td>{{ row['覆盖村组'] || '—' }}</td>
            <td>{{ row.rosterCount }}</td>
            <td>{{ row.archive ? row.archive.受众人数 : (row['受众人数'] || 0) }}</td>
            <td>
              {{ row.status }}
              <span v-if="row.needsArchive && row.status !== '已取消'" class="tag tag-pending">待归档</span>
            </td>
            <td class="archive-cell">
              <template v-if="row.archive">
                <span>v{{ row.archive.版本 }} · {{ row.archive.归档时间.slice(0, 10) }}</span>
                <span v-if="row.archive.是否补归属" class="tag tag-warn">日期补归属</span>
                <span v-if="row.archive.名册版本 < view.rosterVersion" class="tag tag-pending">名册已更新</span>
              </template>
              <span v-else class="muted-text">未归档</span>
            </td>
            <td class="row-actions">
              <button
                class="link"
                type="button"
                :disabled="String(row.status) === '已取消'"
                @click="archive(Number(row.id))"
              >
                {{ row.archive ? '重新归档' : '归档' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">④ 归档产物：林区道路沿线提示清单</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>提示编号</th>
            <th>道路编号</th>
            <th>道路名称</th>
            <th>覆盖村组</th>
            <th>来源活动</th>
            <th>宣传状态</th>
            <th>发布日期</th>
            <th>提示内容</th>
            <th>同步状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="notice in view.roadNotices" :key="notice.id">
            <td>{{ notice.id }}</td>
            <td>{{ notice.道路编号 }}</td>
            <td>{{ notice.道路名称 }}</td>
            <td>{{ notice.覆盖村组 }}</td>
            <td>{{ notice.活动编号 }}</td>
            <td>{{ notice.宣传活动状态 }}</td>
            <td>{{ notice.发布日期 }}</td>
            <td>{{ notice.提示内容 }}</td>
            <td>{{ notice.状态 }}</td>
          </tr>
          <tr v-if="!view.roadNotices.length">
            <td colspan="9" class="empty-state">归档命中覆盖村组的林区道路后，这里会生成沿线宣传提示</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">⑤ 归档产物：检查站宣传提醒</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>提醒编号</th>
            <th>站点编号</th>
            <th>站点位置</th>
            <th>覆盖村组</th>
            <th>来源活动</th>
            <th>宣传状态</th>
            <th>提醒日期</th>
            <th>提醒内容</th>
            <th>同步状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="notice in view.checkpointNotices" :key="notice.id">
            <td>{{ notice.id }}</td>
            <td>{{ notice.站点编号 }}</td>
            <td>{{ notice.站点位置 }}</td>
            <td>{{ notice.覆盖村组 }}</td>
            <td>{{ notice.活动编号 }}</td>
            <td>{{ notice.宣传活动状态 }}</td>
            <td>{{ notice.提醒日期 }}</td>
            <td>{{ notice.提醒内容 }}</td>
            <td>{{ notice.状态 }}</td>
          </tr>
          <tr v-if="!view.checkpointNotices.length">
            <td colspan="9" class="empty-state">归档命中覆盖村组的检查站后，这里会生成入站宣传提醒</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  archiveOne,
  coverageView,
  downloadCoverageReport,
  downloadRosterTemplate,
  importRosterText,
  interruptBatch,
  startBatch,
  type CoverageView,
} from '@/api/coverage-service'
import type { BatchState } from '@/data/coverage-core'

const view = ref<CoverageView>(coverageView())
const fileInput = ref<HTMLInputElement | null>(null)
const importMessage = ref('')
const importOk = ref(false)
const importErrors = ref<string[]>([])
const batchMessage = ref('')
const batchOk = ref(false)
let pollTimer: number | null = null

const batch = ref<BatchState | null>(view.value.batch)
const running = computed(() => batch.value?.state === 'running')
const canResume = computed(() => pendingCount.value > 0)
const pendingCount = computed(() =>
  view.value.campaigns.filter((row) => row.needsArchive && String(row.status) !== '已取消').length,
)
const progressPercent = computed(() => {
  if (!batch.value || batch.value.total === 0) return 0
  return Math.round((batch.value.processed / batch.value.total) * 100)
})
const batchStateLabel = computed(() => {
  const state = batch.value?.state
  if (state === 'running') return '进行中'
  if (state === 'interrupted') return '已中断（可续跑）'
  if (state === 'done') return '已完成'
  return '—'
})

function refresh() {
  view.value = coverageView()
  batch.value = view.value.batch
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  importMessage.value = ''
  importErrors.value = []
  if (!file) return
  const text = await file.text()
  const result = importRosterText(text)
  importOk.value = result.ok
  importMessage.value = result.message
  importErrors.value = result.warnings
  input.value = ''
  refresh()
}

function downloadTemplate() {
  downloadRosterTemplate()
}

function downloadReport() {
  downloadCoverageReport()
}

function archive(id: number) {
  batchMessage.value = ''
  const result = archiveOne(id)
  batchOk.value = result.ok
  batchMessage.value = result.warnings.length
    ? `${result.message}；${result.warnings.join('；')}`
    : result.message
  refresh()
}

async function runBatch() {
  batchMessage.value = ''
  batchOk.value = true
  startPolling()
  try {
    const finalBatch = await startBatch()
    batchOk.value = finalBatch.failed.length === 0
    batchMessage.value =
      finalBatch.state === 'interrupted'
        ? `批次已中断：已归档 ${finalBatch.doneIds.length} 个，剩余 ${finalBatch.pendingIds.length} 个，可再次点击续跑`
        : `批次完成：成功 ${finalBatch.doneIds.length} 个，跳过 ${finalBatch.skippedIds.length} 个，失败 ${finalBatch.failed.length} 个`
  } catch (error) {
    batchOk.value = false
    batchMessage.value = error instanceof Error ? error.message : '批次执行失败'
  } finally {
    stopPolling()
    refresh()
  }
}

function stopBatch() {
  const result = interruptBatch()
  batchOk.value = result.ok
  batchMessage.value = result.message
  refresh()
}

function startPolling() {
  stopPolling()
  pollTimer = window.setInterval(refresh, 200)
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(refresh)
onBeforeUnmount(stopPolling)
</script>
