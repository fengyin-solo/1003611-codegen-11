// 覆盖归档台的页面服务：页面只渲染，导入、归档、续跑、报告下载统一从这里走。
import { downloadText } from './local-service'
import { getCoverage } from '@/data/coverage-store'
import {
  archiveCampaign as archiveOne,
  buildAudienceReport,
  buildMethodReport,
  importRoster as importRosterFile,
  rosterTemplate,
  runArchiveBatch,
} from '@/data/coverage-archive'
import { listRows } from '@/data/local-store'
import type {
  ArchiveOutcome,
  BatchOutcome,
  CheckpointTipRow,
  CoverageState,
  EntryRow,
  RoadTipRow,
  RosterImportResult,
  VillageRow,
} from '@/data/types'

export function coverageSnapshot(): CoverageState {
  return getCoverage()
}

export function campaignRows(): EntryRow[] {
  return listRows('campaign')
}

export function importRoster(text: string): RosterImportResult {
  return importRosterFile(text)
}

export function downloadRosterTemplate(): void {
  downloadText('村组名单模板.csv', rosterTemplate())
}

export function archiveSingle(id: number): ArchiveOutcome {
  return archiveOne(id)
}

export function archiveBatch(): Promise<BatchOutcome> {
  return runArchiveBatch()
}

export function roadTips(): RoadTipRow[] {
  return getCoverage().roadTips
}

export function checkpointTips(): CheckpointTipRow[] {
  return getCoverage().checkpointTips
}

export function rosterRows(): VillageRow[] {
  return getCoverage().roster
}

export function downloadAudienceReport(): void {
  const file = buildAudienceReport()
  downloadText(file.filename, file.content)
}

export function downloadMethodReport(): void {
  const file = buildMethodReport()
  downloadText(file.filename, file.content)
}
