/**
 * IndexedDB 仓库适配器（PRD V1.1.0：仅用于旧数据迁移来源与既有测试）。
 * 生产环境的事实源是服务端 API（见 remoteRepo.ts）；本适配器不再作为项目归属。
 *
 * 数据安全设计：
 * 1. 原始识别层（srt_source）写入一次后不可变：重复写入不同内容会抛错；
 * 2. updateSegment 只接受白名单字段，originalText / cueNo / startMs / endMs
 *    在任何调用下都不会被改写（UI 与测试共同保证）；
 * 3. 项目与字幕导入在单个事务中完成（要么全部写入，要么全部不写）。
 */

import { randomUuid } from "../core/identity.js";
import {
  STORE_ISSUES,
  STORE_PROJECTS,
  STORE_SEGMENTS,
  STORE_SRT_SOURCE,
  withStore,
} from "./db.js";
import type {
  IssueRecord,
  MediaInfo,
  PrefilterConfigDto,
  PrefilterRunDto,
  ProjectMeta,
  PlaybackState,
  SegmentRecord,
  SegmentStatus,
  SrtSourceRecord,
} from "./types.js";

/**
 * V1.1.4 预筛仅在服务端后端可用（模型适配器与密钥都在服务端）。
 * IndexedDB 测试后端诚实降级：配置返回不可用，其余操作明确报错——
 * 不伪造模型结果，也不影响人工校对主链路。
 */
export async function getPrefilterConfig(): Promise<PrefilterConfigDto> {
  return {
    available: false,
    provider: "indexeddb",
    model: "（本地测试后端不支持预筛）",
    promptVersion: "unsupported",
  };
}

export async function createPrefilterRun(_projectId: string): Promise<PrefilterRunDto> {
  void _projectId;
  throw new Error("文本预筛仅支持服务端后端（本地 IndexedDB 后端不可用）。");
}

export async function getLatestPrefilterRun(_projectId: string): Promise<PrefilterRunDto | null> {
  void _projectId;
  return null; // 本地测试后端无预筛数据，诚实返回 null。
}

export async function getPrefilterRun(_projectId: string, _runId: string): Promise<PrefilterRunDto> {
  void _projectId;
  void _runId;
  throw new Error("文本预筛仅支持服务端后端（本地 IndexedDB 后端不可用）。");
}

export class SourceImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceImmutableError";
  }
}

/**
 * 防御性剥离：任何写回 projects 的对象都不得携带遗留的 audioFile（File/Blob）。
 * v2 迁移已清理历史数据；这里保证旧内存快照经写入路径也不会把音频正文带回数据库。
 */
export function sanitizeMedia<T extends { media: MediaInfo }>(meta: T): T {
  const mediaRec = meta.media as unknown as Record<string, unknown>;
  if (!("audioFile" in mediaRec)) return meta;
  const media = { ...mediaRec };
  delete media.audioFile;
  return { ...meta, media: media as unknown as MediaInfo };
}

export interface CreateProjectInput {
  meta: Omit<ProjectMeta, "createdAt" | "updatedAt">;
  srtSource: Omit<SrtSourceRecord, "projectId" | "importedAt">;
  segments: Omit<SegmentRecord, "projectId" | "revisionNo" | "updatedAt">[];
}

export async function createProject(input: CreateProjectInput): Promise<ProjectMeta> {
  const existingMeta = await getProject(input.meta.projectId);
  if (existingMeta) {
    // 幂等语义：同一身份（同 ID + 同原始 SRT）重复导入时，直接返回既有项目，
    // 不重写 meta / segments / issues，保证校对稿、版本号与状态原样保留。
    const src = await getSrtSource(input.meta.projectId);
    if (src && src.rawContent !== input.srtSource.rawContent) {
      throw new SourceImmutableError("原始识别层已存在且内容不同，拒绝覆盖。");
    }
    return existingMeta;
  }

  const now = Date.now();
  const meta: ProjectMeta = { ...input.meta, createdAt: now, updatedAt: now };
  const srtSource: SrtSourceRecord = {
    ...input.srtSource,
    projectId: meta.projectId,
    importedAt: now,
  };
  const segments: SegmentRecord[] = input.segments.map((s) => ({
    ...s,
    projectId: meta.projectId,
    revisionNo: 1,
    updatedAt: now,
  }));

  // 纵深防御：mediaKey 已包含 SRT 内容哈希；这里再挡一次“同 ID 不同内容”的覆盖。
  const existingSource = await getSrtSource(meta.projectId);
  if (existingSource && existingSource.rawContent !== srtSource.rawContent) {
    throw new SourceImmutableError("原始识别层已存在且内容不同，拒绝覆盖。");
  }

  await withStore([STORE_PROJECTS, STORE_SRT_SOURCE, STORE_SEGMENTS], "readwrite", (stores) => {
    if (!existingSource) stores[STORE_SRT_SOURCE].put(srtSource);
    stores[STORE_PROJECTS].put(sanitizeMedia(meta));
    const segStore = stores[STORE_SEGMENTS];
    for (const seg of segments) segStore.put(seg);
  });

  return meta;
}

export async function getProject(projectId: string): Promise<ProjectMeta | undefined> {
  return withStore(STORE_PROJECTS, "readonly", (stores) =>
    stores[STORE_PROJECTS].get(projectId) as IDBRequest<ProjectMeta | undefined>,
  );
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await withStore(STORE_PROJECTS, "readonly", (stores) =>
    stores[STORE_PROJECTS].getAll() as IDBRequest<ProjectMeta[]>,
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(projectId: string): Promise<void> {
  await withStore([STORE_PROJECTS, STORE_SRT_SOURCE, STORE_SEGMENTS, STORE_ISSUES], "readwrite", (stores) => {
    stores[STORE_PROJECTS].delete(projectId);
    stores[STORE_SRT_SOURCE].delete(projectId);
    const segs = stores[STORE_SEGMENTS].index("byProject").getAll(projectId);
    segs.onsuccess = () => {
      for (const s of segs.result as SegmentRecord[]) stores[STORE_SEGMENTS].delete(s.segmentId);
    };
    const issues = stores[STORE_ISSUES].index("byProject").getAll(projectId);
    issues.onsuccess = () => {
      for (const i of issues.result as IssueRecord[]) stores[STORE_ISSUES].delete(i.issueId);
    };
  });
}

export async function getProjectSegments(projectId: string): Promise<SegmentRecord[]> {
  const segs = await withStore(STORE_SEGMENTS, "readonly", (stores) =>
    stores[STORE_SEGMENTS].index("byProject").getAll(projectId) as IDBRequest<SegmentRecord[]>,
  );
  return segs.sort((a, b) => a.startMs - b.startMs);
}

export async function getProjectIssues(projectId: string): Promise<IssueRecord[]> {
  const issues = await withStore(STORE_ISSUES, "readonly", (stores) =>
    stores[STORE_ISSUES].index("byProject").getAll(projectId) as IDBRequest<IssueRecord[]>,
  );
  return issues.sort((a, b) => a.startMs - b.startMs);
}

export async function getSrtSource(projectId: string): Promise<SrtSourceRecord | undefined> {
  return withStore(STORE_SRT_SOURCE, "readonly", (stores) =>
    stores[STORE_SRT_SOURCE].get(projectId) as IDBRequest<SrtSourceRecord | undefined>,
  );
}

/** 覆盖原始识别层的唯一受控入口是 createProject 的写一次防线；不存在任何业务级覆盖路径。 */

/** updateSegment 允许修改的字段白名单。 */
const SEGMENT_EDITABLE_FIELDS = new Set([
  "correctedText",
  "status",
  "revisionNo",
  "updatedAt",
]);

export interface SegmentPatch {
  correctedText?: string;
  status?: SegmentStatus;
}

/**
 * 更新校对层数据。返回写库后的记录。
 * 白名单之外的字段（尤其 originalText）即使传入也会被忽略。
 */
export async function updateSegment(
  segmentId: string,
  patch: SegmentPatch & Record<string, unknown>,
): Promise<SegmentRecord | undefined> {
  let updated: SegmentRecord | undefined;
  await withStore(STORE_SEGMENTS, "readwrite", (stores) => {
    const req = stores[STORE_SEGMENTS].get(segmentId);
    req.onsuccess = () => {
      const prev = req.result as SegmentRecord | undefined;
      if (!prev) return;
      const next: SegmentRecord = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (SEGMENT_EDITABLE_FIELDS.has(key)) {
          (next as unknown as Record<string, unknown>)[key] = value;
        }
      }
      next.revisionNo = prev.revisionNo + 1;
      next.updatedAt = Date.now();
      stores[STORE_SEGMENTS].put(next);
      updated = next;
    };
  });
  return updated;
}

export async function upsertIssue(issue: IssueRecord): Promise<void> {
  await withStore(STORE_ISSUES, "readwrite", (stores) => {
    stores[STORE_ISSUES].put(issue);
  });
}

export interface ConfirmSegmentResult {
  segment: SegmentRecord;
  resolvedIssues: IssueRecord[];
}

/**
 * V1.1.4 原子确认（AC-068，测试后端镜像）：单个 IndexedDB 事务中
 * 把目标段改为 confirmed（可选应用 correctedText 草稿），并把该段全部 open 疑点
 * 按稳定 issueId 顺序改为 resolved（同一确认时间）。任一步失败整体回滚。
 */
export async function confirmSegment(
  segmentId: string,
  opts: { correctedText?: string } = {},
): Promise<ConfirmSegmentResult | undefined> {
  let result: ConfirmSegmentResult | undefined;
  await withStore([STORE_SEGMENTS, STORE_ISSUES], "readwrite", (stores) => {
    const req = stores[STORE_SEGMENTS].get(segmentId);
    req.onsuccess = () => {
      const prev = req.result as SegmentRecord | undefined;
      if (!prev) return;
      const now = Date.now();
      const segmentChanged =
        prev.status !== "confirmed" ||
        (opts.correctedText !== undefined && opts.correctedText !== prev.correctedText);
      const next: SegmentRecord = segmentChanged
        ? {
            ...prev,
            correctedText: opts.correctedText ?? prev.correctedText,
            status: "confirmed",
            revisionNo: prev.revisionNo + 1,
            updatedAt: now,
          }
        : prev;
      if (segmentChanged) stores[STORE_SEGMENTS].put(next);
      const issueStore = stores[STORE_ISSUES];
      const all = issueStore.index("bySegment").getAll(segmentId);
      all.onsuccess = () => {
        const open = (all.result as IssueRecord[])
          .filter((i) => i.status === "open")
          .sort((a, b) => (a.issueId < b.issueId ? -1 : 1));
        const resolved = open.map((i) => ({ ...i, status: "resolved" as const, resolvedAt: now }));
        for (const r of resolved) issueStore.put(r);
        result = { segment: next, resolvedIssues: resolved };
      };
    };
  });
  return result;
}

export async function deleteIssue(issueId: string): Promise<void> {
  await withStore(STORE_ISSUES, "readwrite", (stores) => {
    stores[STORE_ISSUES].delete(issueId);
  });
}

export async function touchProject(projectId: string): Promise<void> {
  await withStore(STORE_PROJECTS, "readwrite", (stores) => {
    const req = stores[STORE_PROJECTS].get(projectId);
    req.onsuccess = () => {
      const prev = req.result as ProjectMeta | undefined;
      if (!prev) return;
      stores[STORE_PROJECTS].put(sanitizeMedia({ ...prev, updatedAt: Date.now() }));
    };
  });
}

export async function savePlayback(projectId: string, playback: PlaybackState): Promise<void> {
  await withStore(STORE_PROJECTS, "readwrite", (stores) => {
    const req = stores[STORE_PROJECTS].get(projectId);
    req.onsuccess = () => {
      const prev = req.result as ProjectMeta | undefined;
      if (!prev) return;
      stores[STORE_PROJECTS].put(sanitizeMedia({ ...prev, playback, updatedAt: Date.now() }));
    };
  });
}

/**
 * 受控元数据更新：只允许写 durationMs。
 * 音频元数据在加载后回填；刷新/重启后仍可读回（有回归测试）。
 */
export async function updateMediaDuration(projectId: string, durationMs: number): Promise<void> {
  await withStore(STORE_PROJECTS, "readwrite", (stores) => {
    const req = stores[STORE_PROJECTS].get(projectId);
    req.onsuccess = () => {
      const prev = req.result as ProjectMeta | undefined;
      if (!prev) return;
      if (prev.media.durationMs === durationMs) return;
      stores[STORE_PROJECTS].put(
        sanitizeMedia({
          ...prev,
          media: { ...prev.media, durationMs },
          updatedAt: Date.now(),
        }),
      );
    };
  });
}

/** 重新定位源音频（PRD 2.3.1：文件被移动后重连；只更新引用，不触碰任何源文件）。
 *  调用方必须先通过音频身份指纹校验（computeAudioFingerprint 与项目记录一致）。 */
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
  await withStore(STORE_PROJECTS, "readwrite", (stores) => {
    const req = stores[STORE_PROJECTS].get(projectId);
    req.onsuccess = () => {
      const prev = req.result as ProjectMeta | undefined;
      if (!prev) return;
      stores[STORE_PROJECTS].put(
        sanitizeMedia({
          ...prev,
          media: { ...prev.media, ...media },
          updatedAt: Date.now(),
        }),
      );
    };
  });
}

/** 工厂：由解析出的 cue 构造初始 segment（original 与 corrected 初始相同）。 */
export function makeSegmentFromCue(
  _projectId: string,
  cue: { seq: number | null; startMs: number; endMs: number; text: string },
): Omit<SegmentRecord, "projectId" | "revisionNo" | "updatedAt"> {
  return {
    segmentId: randomUuid(),
    cueNo: cue.seq,
    startMs: cue.startMs,
    endMs: cue.endMs,
    originalText: cue.text,
    correctedText: cue.text,
    status: "unreviewed",
  };
}

export async function prefilterNext(_projectId: string, _runId: string): Promise<{ run: PrefilterRunDto; revision: number; error: { code: string; message: string } | null; processed: boolean }> {
  void _projectId;
  void _runId;
  throw new Error("文本预筛仅支持服务端后端（本地 IndexedDB 后端不可用）。");
}

export async function prefilterRetry(_projectId: string, _runId: string): Promise<{ run: PrefilterRunDto; revision: number; error: { code: string; message: string } | null; processed: boolean }> {
  void _projectId;
  void _runId;
  throw new Error("文本预筛仅支持服务端后端（本地 IndexedDB 后端不可用）。");
}

export async function prefilterCancel(_projectId: string, _runId: string): Promise<PrefilterRunDto> {
  void _projectId;
  void _runId;
  throw new Error("文本预筛仅支持服务端后端（本地 IndexedDB 后端不可用）。");
}
