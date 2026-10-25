/**
 * 服务端 API 仓库（PRD V1.1.0 / 4.4.4）：生产环境的事实源。
 * - 全部读写走同一服务的 /api；项目归属服务端工作空间，与浏览器/设备/origin 无关；
 * - 每次写入携带 expectedRevision（来自最近一次成功读写的 revision 缓存）；
 *   409 时抛 RevisionConflictError，绝不采用服务端返回的新版本静默重试（由用户刷新/比较后重试）；
 * - 服务不可达时抛 ServerUnavailableError：调用方（SaveCoordinator）保留内存草稿与失败队列；
 * - 音频正文与文件句柄绝不上传（relink 只发可序列化元数据）。
 */

import { SourceImmutableError } from "./idbRepo.js";
import type { TingProofRepository } from "./backend.js";
import type { CreateProjectInput } from "./idbRepo.js";
import type {
  IssueRecord,
  MediaInfo,
  PlaybackState,
  ProjectMeta,
  SegmentRecord,
  SrtSourceRecord,
} from "./types.js";

export type { CreateProjectInput };

export class RevisionConflictError extends Error {
  constructor(
    message: string,
    public readonly currentRevision: number | undefined,
  ) {
    super(message);
    this.name = "RevisionConflictError";
  }
}

export class ServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerUnavailableError";
  }
}

export interface ProjectSummaryDto extends ProjectMeta {
  revision: number;
}

/** 服务端不接收浏览器句柄；客户端统一以 null 表示需在本设备重新关联音频。 */
function toClientMeta(dto: ProjectSummaryDto): ProjectSummaryDto {
  return {
    ...dto,
    media: {
      ...dto.media,
      srtHandle: null,
      audioHandle: null,
    },
  };
}

/**
 * 构造跨设备 API 载荷时只保留可序列化媒体元数据。
 * File/Blob、FileSystemFileHandle 以及旧版 audioFile 都不能离开当前设备；
 * 服务端也有同样的白名单，但客户端先剥离可避免把正文放进 HTTP 请求。
 */
function mediaForServer(media: MediaInfo | Record<string, unknown>): Record<string, unknown> {
  const rec = media as Record<string, unknown>;
  const keys = [
    "audioName",
    "audioSize",
    "audioLastModified",
    "audioFingerprint",
    "srtFileName",
    "srtSha256",
    "mediaKey",
    "durationMs",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in rec) out[key] = rec[key];
  }
  return out;
}

interface ProjectDetailDto {
  project: ProjectSummaryDto;
  srtSource: Omit<SrtSourceRecord, "projectId">;
  segments: SegmentRecord[];
  issues: IssueRecord[];
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api`;
  }
  return "http://127.0.0.1:5173/api";
}

export class RemoteProjectRepository implements TingProofRepository {
  /** projectId → 最近已知 revision（只在成功响应后更新；409 不更新，防止静默覆盖）。 */
  private readonly revisionCache = new Map<string, number>();
  private readonly segmentProject = new Map<string, string>();
  private readonly issueProject = new Map<string, string>();
  private readonly knownIssues = new Set<string>();
  /** 归一化后的 API 基地址：总是以 /api 结尾（传入 origin 或带 /api 的地址均可）。 */
  readonly baseUrl: string;

  constructor(baseUrl: string = defaultBaseUrl()) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    this.baseUrl = /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`;
  }

  // ---------- HTTP 基础 ----------

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      throw new ServerUnavailableError(
        `暂时无法连接服务（${err instanceof Error ? err.message : String(err)}），编辑已保留在待保存队列。`,
      );
    }
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body };
  }

  /** 2xx → 返回 body；409 → 抛类型化冲突；其余 → 抛 Error。 */
  private async mustOk<T>(result: { status: number; body: unknown }, fallback: string): Promise<T> {
    if (result.status >= 200 && result.status < 300 && result.body !== null) {
      return result.body as T;
    }
    const err = (result.body ?? {}) as { error?: string; message?: string; currentRevision?: number };
    if (result.status === 409 && err.error === "revision_conflict") {
      throw new RevisionConflictError(
        err.message ?? "项目已在其他设备更新，写入被拒绝；请刷新比较后重试。",
        err.currentRevision,
      );
    }
    if (result.status === 409 && err.error === "source_conflict") {
      throw new SourceImmutableError(err.message ?? "原始识别层已存在且内容不同，拒绝覆盖。");
    }
    throw new Error(err.message || `${fallback}（HTTP ${result.status}）`);
  }

  // ---------- revision / 归属缓存 ----------

  private noteRevision(meta: { projectId: string; revision: number }): void {
    const previous = this.revisionCache.get(meta.projectId);
    // 多个子资源请求会并发返回；旧响应不能把本地已知版本倒退，
    // 否则下一次写入可能错误地携带过期 revision。
    if (previous === undefined || meta.revision > previous) {
      this.revisionCache.set(meta.projectId, meta.revision);
    }
  }

  /** 写响应的 revision：顶层 revision 优先（§4.4.4 契约），兼容 project.revision。 */
  private noteWriteRevision(
    projectId: string,
    body: { revision?: number; project?: ProjectSummaryDto },
  ): void {
    const rev = typeof body.revision === "number" ? body.revision : body.project?.revision;
    const previous = this.revisionCache.get(projectId);
    if (typeof rev === "number" && (previous === undefined || rev > previous)) {
      this.revisionCache.set(projectId, rev);
    }
  }

  private noteSegments(projectId: string, segments: SegmentRecord[]): void {
    for (const seg of segments) this.segmentProject.set(seg.segmentId, projectId);
  }

  private noteIssues(issues: IssueRecord[]): void {
    for (const issue of issues) {
      this.issueProject.set(issue.issueId, issue.projectId);
      this.knownIssues.add(issue.issueId);
    }
  }

  private expectedRevisionOrThrow(projectId: string): number {
    const rev = this.revisionCache.get(projectId);
    if (rev === undefined) {
      throw new RevisionConflictError(
        "缺少项目版本号，为避免覆盖其他设备的修改已阻止写入；请重新打开项目后重试。",
        undefined,
      );
    }
    return rev;
  }

  // ---------- 读取 ----------

  async listProjects(): Promise<ProjectMeta[]> {
    const result = await this.request("/projects");
    const body = await this.mustOk<{ projects: ProjectSummaryDto[] }>(result, "读取项目列表失败");
    for (const p of body.projects) this.noteRevision(p);
    return body.projects.map((project) => {
      const { revision: _revision, ...meta } = toClientMeta(project);
      return meta;
    });
  }

  async getProject(projectId: string): Promise<ProjectMeta | undefined> {
    const result = await this.request(`/projects/${encodeURIComponent(projectId)}`);
    if (result.status === 404) return undefined;
    const detail = await this.mustOk<ProjectDetailDto>(result, "读取项目失败");
    this.noteRevision(detail.project);
    this.noteSegments(projectId, detail.segments ?? []);
    this.noteIssues(detail.issues ?? []);
    const { revision: _rev, ...meta } = toClientMeta(detail.project);
    return meta;
  }

  async getProjectSegments(projectId: string): Promise<SegmentRecord[]> {
    const result = await this.request(`/projects/${encodeURIComponent(projectId)}/segments`);
    if (result.status === 404) return [];
    const body = await this.mustOk<{ segments: SegmentRecord[]; revision?: number }>(
      result,
      "读取字幕段失败",
    );
    if (typeof body.revision === "number") this.noteRevision({ projectId, revision: body.revision });
    this.noteSegments(projectId, body.segments);
    return body.segments;
  }

  async getProjectIssues(projectId: string): Promise<IssueRecord[]> {
    const result = await this.request(`/projects/${encodeURIComponent(projectId)}/issues`);
    if (result.status === 404) return [];
    const body = await this.mustOk<{ issues: IssueRecord[]; revision?: number }>(
      result,
      "读取疑点失败",
    );
    if (typeof body.revision === "number") this.noteRevision({ projectId, revision: body.revision });
    this.noteIssues(body.issues);
    return body.issues;
  }

  async getSrtSource(projectId: string): Promise<SrtSourceRecord | undefined> {
    const result = await this.request(`/projects/${encodeURIComponent(projectId)}/srt`);
    if (result.status === 404) return undefined;
    const body = await this.mustOk<{ srtSource: Omit<SrtSourceRecord, "projectId"> }>(
      result,
      "读取原始字幕失败",
    );
    return { ...body.srtSource, projectId };
  }

  // ---------- 写入（全部带 expectedRevision） ----------

  async createProject(input: CreateProjectInput): Promise<ProjectMeta> {
    const result = await this.request("/projects", {
      method: "POST",
      body: {
        meta: {
          projectId: input.meta.projectId,
          name: input.meta.name,
          normalizedStem: input.meta.normalizedStem,
          media: mediaForServer(input.meta.media),
          playback: input.meta.playback,
        },
        srtSource: input.srtSource,
        segments: input.segments,
        issues: [],
      },
    });
    const body = await this.mustOk<{
      created: boolean;
      revision: number;
      project: ProjectSummaryDto;
    }>(result, "创建项目失败");
    this.noteWriteRevision(input.meta.projectId, body);
    // 幂等创建返回已有项目时，输入可能来自旧设备；不要把本地旧段 ID
    // 写入当前客户端的归属缓存，后续写入必须以服务端读取结果为准。
    if (body.created) this.noteSegments(body.project.projectId, input.segments as SegmentRecord[]);
    const { revision: _rev, ...meta } = toClientMeta(body.project);
    return meta;
  }

  async updateSegment(
    segmentId: string,
    patch: { correctedText?: string; status?: SegmentRecord["status"] } & Record<string, unknown>,
  ): Promise<SegmentRecord | undefined> {
    const projectId = this.segmentProject.get(segmentId);
    if (!projectId) {
      // 归属未知：不盲写（PRD 并发契约），提示重新打开项目。
      throw new RevisionConflictError("缺少字幕段归属信息，请重新打开项目后重试。", undefined);
    }
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const result = await this.request(`/segments/${encodeURIComponent(segmentId)}`, {
      method: "PATCH",
      body: { patch, projectId, expectedRevision },
    });
    const body = await this.mustOk<{
      segment: SegmentRecord;
      revision: number;
      project: ProjectSummaryDto;
    }>(result, "保存字幕段失败");
    this.noteWriteRevision(projectId, body);
    return body.segment;
  }

  async upsertIssue(issue: IssueRecord): Promise<void> {
    const expectedRevision = this.expectedRevisionOrThrow(issue.projectId);
    const path = `/projects/${encodeURIComponent(issue.projectId)}/issues/${encodeURIComponent(issue.issueId)}`;
    const result = await this.request(path, {
      method: "PUT",
      body: { issue, expectedRevision },
    });
    const body = await this.mustOk<{
      issue: IssueRecord;
      revision: number;
      project: ProjectSummaryDto;
    }>(result, "保存疑点失败");
    this.noteWriteRevision(issue.projectId, body);
    this.issueProject.set(issue.issueId, issue.projectId);
    this.knownIssues.add(issue.issueId);
  }

  async deleteIssue(issueId: string): Promise<void> {
    const projectId = this.issueProject.get(issueId);
    if (!projectId) {
      // 未知归属且从未被读取为服务端疑点时，保持安全：不发无版本删除。
      // 已知“服务端不存在”的疑点可视为幂等删除成功。
      if (!this.knownIssues.has(issueId)) return;
      return;
    }
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`;
    const result = await this.request(path, { method: "DELETE", body: { expectedRevision } });
    const body = await this.mustOk<{
      deleted: boolean;
      revision: number;
      project: ProjectSummaryDto;
    }>(result, "删除疑点失败");
    this.noteWriteRevision(projectId, body);
    this.issueProject.delete(issueId);
    this.knownIssues.delete(issueId);
  }

  async touchProject(projectId: string): Promise<void> {
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}/touch`;
    const result = await this.request(path, { method: "POST", body: { expectedRevision } });
    const body = await this.mustOk<{ revision: number; project: ProjectSummaryDto }>(
      result,
      "刷新项目失败",
    );
    this.noteWriteRevision(projectId, body);
  }

  async savePlayback(projectId: string, playback: PlaybackState): Promise<void> {
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}/playback`;
    const result = await this.request(path, {
      method: "PATCH",
      body: { playback, expectedRevision },
    });
    const body = await this.mustOk<{ revision: number; project: ProjectSummaryDto }>(
      result,
      "保存播放位置失败",
    );
    this.noteWriteRevision(projectId, body);
  }

  async updateMediaDuration(projectId: string, durationMs: number): Promise<void> {
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}/media`;
    const result = await this.request(path, {
      method: "PATCH",
      body: { durationMs, expectedRevision },
    });
    const body = await this.mustOk<{ revision: number; project: ProjectSummaryDto }>(
      result,
      "保存音频时长失败",
    );
    this.noteWriteRevision(projectId, body);
  }

  /** 重新定位源音频：只上传可序列化元数据；句柄/音频正文永不离开本设备。 */
  async relinkAudio(
    projectId: string,
    media: {
      audioName: string;
      audioSize: number;
      audioLastModified: number;
      audioFingerprint: string;
      audioHandle?: FileSystemFileHandle | null;
    },
  ): Promise<void> {
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}/media`;
    const { audioHandle: _localHandle, ...relink } = media;
    const result = await this.request(path, {
      method: "PATCH",
      body: { relink, expectedRevision },
    });
    const body = await this.mustOk<{ revision: number; project: ProjectSummaryDto }>(
      result,
      "保存音频关联失败",
    );
    this.noteWriteRevision(projectId, body);
  }

  async deleteProject(projectId: string): Promise<void> {
    const expectedRevision = this.expectedRevisionOrThrow(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}`;
    const result = await this.request(path, { method: "DELETE", body: { expectedRevision } });
    await this.mustOk(result, "删除项目失败");
    this.revisionCache.delete(projectId);
  }

  /**
   * 幂等迁移（AC-056）：服务端缺失才创建；已有项目绝不覆盖。
   * 载荷只含结构化数据 + 原始 SRT；media 白名单化，句柄与音频正文（如有）不上传。
   * meta.playback 随载荷上传：既有播放进度不得在迁移中丢失。
   */
  async migrateProject(payload: {
    meta: { projectId: string; name: string; normalizedStem: string; media: unknown; playback?: unknown };
    srtSource: { rawContent: string; sha256: string; sourceFilename: string; cueCount: number };
    segments: Array<Omit<SegmentRecord, "projectId" | "revisionNo" | "updatedAt">>;
    issues: IssueRecord[];
  }): Promise<{ created: boolean; stale: boolean; revision: number; project: ProjectSummaryDto }> {
    const path = `/projects/${encodeURIComponent(payload.meta.projectId)}/migrate`;
    const result = await this.request(path, {
      method: "POST",
      body: {
        ...payload,
        meta: {
          ...payload.meta,
          media: mediaForServer(payload.meta.media as Record<string, unknown>),
        },
      },
    });
    const body = await this.mustOk<{
      created: boolean;
      stale: boolean;
      revision: number;
      project: ProjectSummaryDto;
    }>(result, "迁移失败");
    this.noteWriteRevision(payload.meta.projectId, body);
    if (body.created) {
      this.noteSegments(body.project.projectId, payload.segments as SegmentRecord[]);
      this.noteIssues(payload.issues);
    }
    return body;
  }
}

let defaultRepository: RemoteProjectRepository | null = null;

export function getRemoteRepository(): RemoteProjectRepository {
  if (!defaultRepository) defaultRepository = new RemoteProjectRepository();
  return defaultRepository;
}

/** 测试/工具用：独立客户端实例（独立 revision 缓存，模拟另一台设备）。 */
export function createRemoteRepository(baseUrl?: string): RemoteProjectRepository {
  return new RemoteProjectRepository(baseUrl);
}
