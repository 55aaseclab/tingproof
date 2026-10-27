/**
 * 仓库门面（客户端唯一入口）：
 * - 生产/dev → 服务端 API 仓库（remoteRepo.ts，PRD V1.1.0 事实源）；
 * - 测试/旧数据迁移 → IndexedDB 适配器（idbRepo.ts，仅缓存与迁移来源）；
 * - 后端选择规则见 backend.ts。UI（ImportScreen/App/Workbench）无需感知差异。
 */

import * as idbBackend from "./idbRepo.js";
import { getBackendKind, type TingProofRepository } from "./backend.js";
import { getRemoteRepository } from "./remoteRepo.js";
import type {
  IssueRecord,
  PlaybackState,
  ProjectMeta,
  SegmentRecord,
  SrtSourceRecord,
} from "./types.js";

export {
  makeSegmentFromCue,
  sanitizeMedia,
  SourceImmutableError,
} from "./idbRepo.js";
export type { CreateProjectInput, SegmentPatch } from "./idbRepo.js";
import type { CreateProjectInput, SegmentPatch } from "./idbRepo.js";

function active(): TingProofRepository {
  return getBackendKind() === "remote" ? getRemoteRepository() : idbBackend;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectMeta> {
  return active().createProject(input);
}

export async function getProject(projectId: string): Promise<ProjectMeta | undefined> {
  return active().getProject(projectId);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  return active().listProjects();
}

export async function deleteProject(projectId: string): Promise<void> {
  return active().deleteProject(projectId);
}

export async function getProjectSegments(projectId: string): Promise<SegmentRecord[]> {
  return active().getProjectSegments(projectId);
}

export async function getProjectIssues(projectId: string): Promise<IssueRecord[]> {
  return active().getProjectIssues(projectId);
}

export async function getSrtSource(projectId: string): Promise<SrtSourceRecord | undefined> {
  return active().getSrtSource(projectId);
}

export async function updateSegment(
  segmentId: string,
  patch: SegmentPatch & Record<string, unknown>,
): Promise<SegmentRecord | undefined> {
  return active().updateSegment(segmentId, patch);
}

export async function confirmSegment(
  segmentId: string,
  opts: { correctedText?: string } = {},
): Promise<{ segment: SegmentRecord; resolvedIssues: IssueRecord[] } | undefined> {
  return active().confirmSegment(segmentId, opts);
}

export async function upsertIssue(issue: IssueRecord): Promise<void> {
  return active().upsertIssue(issue);
}

export async function deleteIssue(issueId: string): Promise<void> {
  return active().deleteIssue(issueId);
}

export async function touchProject(projectId: string): Promise<void> {
  return active().touchProject(projectId);
}

export async function savePlayback(projectId: string, playback: PlaybackState): Promise<void> {
  return active().savePlayback(projectId, playback);
}

export async function updateMediaDuration(projectId: string, durationMs: number): Promise<void> {
  return active().updateMediaDuration(projectId, durationMs);
}

export async function relinkAudio(
  projectId: string,
  media: {
    audioName: string;
    audioSize: number;
    audioLastModified: number;
    audioFingerprint: string;
    audioHandle: FileSystemFileHandle | null;
  },
): Promise<void> {
  return active().relinkAudio(projectId, media);
}

// ---------- V1.1.4 机器文本预筛（仅服务端后端；IndexedDB 测试后端诚实降级） ----------

export async function getPrefilterConfig() {
  return active().getPrefilterConfig();
}

export async function createPrefilterRun(projectId: string) {
  return active().createPrefilterRun(projectId);
}

export async function getLatestPrefilterRun(projectId: string) {
  return active().getLatestPrefilterRun(projectId);
}

export async function getPrefilterRun(projectId: string, runId: string) {
  return active().getPrefilterRun(projectId, runId);
}

export async function prefilterNext(projectId: string, runId: string) {
  return active().prefilterNext(projectId, runId);
}

export async function prefilterRetry(projectId: string, runId: string) {
  return active().prefilterRetry(projectId, runId);
}

export async function prefilterCancel(projectId: string, runId: string) {
  return active().prefilterCancel(projectId, runId);
}
