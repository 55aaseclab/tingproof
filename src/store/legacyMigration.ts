/**
 * 旧浏览器 IndexedDB 项目 → 服务端幂等迁移（PRD V1.1.0 / AC-056）：
 * - 服务端缺失项目才创建；服务端已有项目绝不覆盖（返回 stale 标记，不写任何数据）；
 * - 重复迁移不产生重复项目；本地数据一律保留（成功前不删除，成功后也不自动清理）；
 * - 只上传结构化数据 + 原始 SRT；media 白名单化，文件句柄与音频正文绝不上传。
 */

import * as idb from "./idbRepo.js";
import { getRemoteRepository, type RemoteProjectRepository } from "./remoteRepo.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "./types.js";

export interface LegacyMigrationResult {
  projectId: string;
  name: string;
  /** 服务端新建 = true；服务端已有 = false（未覆盖）。 */
  created: boolean;
  /** true 表示本地原始 SRT 与服务端不同（服务端为准，本地未上传覆盖）。 */
  stale: boolean;
  error?: string;
}

/** 服务端白名单 media：去掉文件句柄与任何可能混入的音频正文。 */
function mediaForServer(meta: ProjectMeta): Record<string, unknown> {
  // 旧版本可能把 File/Blob 放在 audioFile；在构造 HTTP 载荷前就剥离，
  // 不仅保证服务端不落库，也保证正文不会离开本设备。
  const {
    srtHandle: _srt,
    audioHandle: _audio,
    audioFile: _audioFile,
    ...rest
  } = meta.media as typeof meta.media & { audioFile?: unknown };
  return { ...rest };
}

export async function migrateLegacyIndexedDbProjects(
  remote: RemoteProjectRepository = getRemoteRepository(),
): Promise<LegacyMigrationResult[]> {
  const legacyProjects = await idb.listProjects();
  const results: LegacyMigrationResult[] = [];
  for (const meta of legacyProjects) {
    const base: LegacyMigrationResult = { projectId: meta.projectId, name: meta.name, created: false, stale: false };
    try {
      const [segments, issues, srt] = await Promise.all([
        idb.getProjectSegments(meta.projectId),
        idb.getProjectIssues(meta.projectId),
        idb.getSrtSource(meta.projectId),
      ]);
      if (!srt) {
        results.push({ ...base, error: "缺少原始识别层（srt_source），跳过迁移" });
        continue;
      }
      const payload = {
        meta: {
          projectId: meta.projectId,
          name: meta.name,
          normalizedStem: meta.normalizedStem,
          media: mediaForServer(meta),
          // 既有播放进度必须随迁移上传（PRD：跨设备进度不得丢失）。
          playback: meta.playback,
        },
        srtSource: {
          rawContent: srt.rawContent,
          sha256: srt.sha256,
          sourceFilename: srt.sourceFilename,
          cueCount: srt.cueCount,
        },
        segments: segments.map(
          ({ projectId: _p, revisionNo: _r, updatedAt: _u, ...seg }: SegmentRecord) => seg,
        ),
        issues: issues as IssueRecord[],
      };
      const result = await remote.migrateProject(payload);
      results.push({ ...base, created: result.created, stale: result.stale });
    } catch (err) {
      results.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** 迁移是否存在待处理的本地项目（用于决定是否触发迁移提示）。 */
export async function hasLegacyProjects(): Promise<boolean> {
  const legacy = await idb.listProjects();
  return legacy.length > 0;
}
