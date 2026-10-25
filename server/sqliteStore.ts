/**
 * 服务端持久化存储（PRD 4.4.2/4.4.4）：
 * - Node 内置 SQLite（node:sqlite DatabaseSync），单文件 + WAL，进程重启后数据与 revision 完整保留；
 * - 项目归属服务端工作空间（service_workspace_id），不归属浏览器/设备/origin；
 * - 每次成功写入在事务中更新数据、revision 与 updated_at，并写入审计事件；
 * - 绝不持久化音频正文或文件句柄（media 白名单 + 防御性剥离 audioFile/srtHandle/audioHandle）。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { badRequest, conflict, notFound, sourceConflict } from "./errors.ts";
import type {
  IssueRecord,
  IssueSeverity,
  IssueStatus,
  IssueType,
  MediaInfo,
  PlaybackState,
  SegmentRecord,
  SegmentStatus,
} from "../src/store/types.ts";

export const SERVICE_WORKSPACE_ID = "workspace-local";

const SEGMENT_STATUSES: readonly SegmentStatus[] = [
  "unreviewed",
  "editing",
  "questioned",
  "confirmed",
  "accepted_unclear",
];
const ISSUE_TYPES: readonly IssueType[] = [
  "unclear",
  "homophone",
  "proper_noun",
  "number",
  "segmentation",
  "speaker",
  "fact",
  "timeline",
];
const ISSUE_SEVERITIES: readonly IssueSeverity[] = ["blocking", "warning"];
const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "resolved"];

/** 服务端 media 白名单：永不包含音频正文（audioFile）与文件句柄（srtHandle/audioHandle）。 */
const MEDIA_KEYS = [
  "audioName",
  "audioSize",
  "audioLastModified",
  "audioFingerprint",
  "srtFileName",
  "srtSha256",
  "mediaKey",
  "durationMs",
] as const;

const LEGACY_MEDIA_KEYS = ["audioFile", "srtHandle", "audioHandle"] as const;
const SEGMENT_KEYS = [
  "segmentId",
  "cueNo",
  "startMs",
  "endMs",
  "originalText",
  "correctedText",
  "status",
] as const;
const ISSUE_KEYS = [
  "issueId",
  "projectId",
  "segmentId",
  "startMs",
  "endMs",
  "type",
  "severity",
  "note",
  "status",
  "createdAt",
  "resolvedAt",
] as const;

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} 包含未知字段：${unknown.join(", ")}（未知字段不会静默落库）`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  service_workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_stem TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  media_json TEXT NOT NULL,
  playback_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS srt_source (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  raw_content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  cue_count INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  segment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  cue_no INTEGER,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  original_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  status TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_project ON segments(project_id);
CREATE TABLE IF NOT EXISTS issues (
  issue_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  segment_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

/** 服务端内部错误：带 HTTP 语义，由 apiHandler 映射。 */
export { conflict, notFound, sourceConflict };export interface CreateProjectPayload {
  meta: {
    projectId: string;
    name: string;
    normalizedStem: string;
    media: Record<string, unknown>;
    /** 可选：导入/迁移时的既有播放进度（PRD：跨设备进度不得丢失）；服务端校验后持久化。 */
    playback?: unknown;
  };
  srtSource: {
    rawContent: string;
    sha256: string;
    sourceFilename: string;
    cueCount: number;
  };
  segments: Array<Omit<SegmentRecord, "projectId" | "revisionNo" | "updatedAt">>;
  issues?: IssueRecord[];
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  normalizedStem: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  media: MediaInfo;
  playback: PlaybackState;
}

export interface ProjectDetail {
  project: ProjectSummary;
  srtSource: {
    rawContent: string;
    sha256: string;
    sourceFilename: string;
    cueCount: number;
    importedAt: number;
  };
  segments: SegmentRecord[];
  issues: IssueRecord[];
}

/** 路径/载荷中的稳定 ID 校验：字符集与长度受限，防止注入与误用。 */
export function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw badRequest(`${label} 必须是 1-80 位 [A-Za-z0-9_-] 字符串`);
  }
  return value;
}

function intOf(value: unknown, label: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} 必须是整数`);
  }
  if (opts.min !== undefined && value < opts.min) throw new TypeError(`${label} 不能小于 ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) throw new TypeError(`${label} 不能大于 ${opts.max}`);
  return value;
}

export function sanitizeMediaForServer(input: unknown): MediaInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("media 必须是对象");
  const rec = input as Record<string, unknown>;
  // 这三个字段只为兼容旧 IndexedDB 迁移而允许进入请求；下面的白名单
  // 永远不会把它们写进 SQLite。其他未知字段直接拒绝，避免悄悄丢失调用方数据。
  rejectUnknownKeys(rec, [...MEDIA_KEYS, ...LEGACY_MEDIA_KEYS], "media");
  const out: Record<string, unknown> = {};
  for (const key of MEDIA_KEYS) out[key] = rec[key] ?? null;
  for (const key of ["audioName", "srtFileName", "srtSha256", "audioFingerprint", "mediaKey"] as const) {
    if (out[key] !== null && typeof out[key] !== "string") {
      throw new TypeError(`media.${key} 必须是字符串`);
    }
  }
  intOf(out.audioSize as number, "media.audioSize", { min: 0 });
  intOf(out.audioLastModified as number, "media.audioLastModified", { min: 0 });
  if (typeof out.audioFingerprint !== "string") out.audioFingerprint = "";
  if (typeof out.mediaKey !== "string" || out.mediaKey.length === 0) {
    throw new TypeError("media.mediaKey 必须是非空字符串");
  }
  if (out.durationMs !== null) intOf(out.durationMs as number, "media.durationMs", { min: 0 });
  // 纵深防御：句柄与音频正文（即使被序列化成奇怪形状）也绝不落库。
  return out as unknown as MediaInfo;
}

function sanitizePlayback(input: unknown): PlaybackState {
  if (typeof input !== "object" || input === null) throw new TypeError("playback 必须是对象");
  const rec = input as Record<string, unknown>;
  rejectUnknownKeys(rec, ["positionMs", "speed", "autoRewindMs", "loopSegmentId"], "playback");
  const positionMs = intOf(rec.positionMs, "playback.positionMs", { min: 0 });
  const speed = rec.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
    throw new TypeError("playback.speed 必须是正数");
  }
  const autoRewindMs = intOf(rec.autoRewindMs, "playback.autoRewindMs", { min: 0, max: 10_000 });
  const loopSegmentId =
    rec.loopSegmentId === null || rec.loopSegmentId === undefined ? null : String(rec.loopSegmentId);
  return { positionMs, speed, autoRewindMs, loopSegmentId };
}

export class SqliteProjectStore {
  private readonly db: DatabaseSync;
  private readonly stmts: {
    getProject: StatementSync;
    listProjects: StatementSync;
    insertProject: StatementSync;
    insertSrt: StatementSync;
    getSegment: StatementSync;
    listSegments: StatementSync;
    insertSegment: StatementSync;
    updateSegment: StatementSync;
    listIssues: StatementSync;
    getIssue: StatementSync;
    putIssue: StatementSync;
    deleteIssue: StatementSync;
    bumpRevision: StatementSync;
    audit: StatementSync;
  };

  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL + FULL：进程重启/断电后已提交事务不丢（PRD 3.8 / 4.4.2 持久性要求）。
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
    this.stmts = {
      getProject: this.db.prepare(
        "SELECT * FROM projects WHERE project_id = ?",
      ),
      listProjects: this.db.prepare(
        "SELECT * FROM projects ORDER BY updated_at DESC, project_id ASC",
      ),
      insertProject: this.db.prepare(
        "INSERT INTO projects (project_id, service_workspace_id, name, normalized_stem, created_at, updated_at, revision, media_json, playback_json) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      ),
      insertSrt: this.db.prepare(
        "INSERT INTO srt_source (project_id, raw_content, sha256, source_filename, cue_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      getSegment: this.db.prepare("SELECT * FROM segments WHERE segment_id = ?"),
      listSegments: this.db.prepare(
        "SELECT * FROM segments WHERE project_id = ? ORDER BY start_ms ASC, segment_id ASC",
      ),
      insertSegment: this.db.prepare(
        "INSERT INTO segments (segment_id, project_id, cue_no, start_ms, end_ms, original_text, corrected_text, status, revision_no, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
      ),
      updateSegment: this.db.prepare(
        "UPDATE segments SET corrected_text = ?, status = ?, revision_no = revision_no + 1, updated_at = ? WHERE segment_id = ?",
      ),
      listIssues: this.db.prepare(
        "SELECT * FROM issues WHERE project_id = ? ORDER BY start_ms ASC, issue_id ASC",
      ),
      getIssue: this.db.prepare("SELECT * FROM issues WHERE issue_id = ?"),
      putIssue: this.db.prepare(
        `INSERT INTO issues (issue_id, project_id, segment_id, start_ms, end_ms, type, severity, note, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET segment_id=excluded.segment_id, start_ms=excluded.start_ms, end_ms=excluded.end_ms, type=excluded.type, severity=excluded.severity, note=excluded.note, status=excluded.status, created_at=excluded.created_at, resolved_at=excluded.resolved_at`,
      ),
      deleteIssue: this.db.prepare("DELETE FROM issues WHERE issue_id = ?"),
      bumpRevision: this.db.prepare(
        "UPDATE projects SET revision = revision + 1, updated_at = ? WHERE project_id = ?",
      ),
      audit: this.db.prepare(
        "INSERT INTO audit_events (project_id, revision, action, object_type, object_id, at) VALUES (?, ?, ?, ?, ?, ?)",
      ),
    };
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- 读取 ----------

  private rowToSummary(row: Record<string, unknown>): ProjectSummary {
    return {
      projectId: row.project_id as string,
      name: row.name as string,
      normalizedStem: row.normalized_stem as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      revision: row.revision as number,
      media: JSON.parse(row.media_json as string) as MediaInfo,
      playback: JSON.parse(row.playback_json as string) as PlaybackState,
    };
  }

  private loadProjectRow(projectId: string): Record<string, unknown> {
    const row = this.stmts.getProject.get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw notFound(`项目不存在：${projectId}`);
    return row;
  }

  listProjectSummaries(): ProjectSummary[] {
    const rows = this.stmts.listProjects.all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.rowToSummary(r));
  }

  getProjectDetail(projectId: string): ProjectDetail {
    const summary = this.rowToSummary(this.loadProjectRow(projectId));
    const srt = this.db
      .prepare("SELECT * FROM srt_source WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return {
      project: summary,
      srtSource: {
        rawContent: (srt?.raw_content as string) ?? "",
        sha256: (srt?.sha256 as string) ?? "",
        sourceFilename: (srt?.source_filename as string) ?? "",
        cueCount: (srt?.cue_count as number) ?? 0,
        importedAt: (srt?.imported_at as number) ?? 0,
      },
      segments: this.listSegments(projectId),
      issues: this.listIssues(projectId),
    };
  }

  getSrtSource(projectId: string): ProjectDetail["srtSource"] {
    this.loadProjectRow(projectId);
    const srt = this.db
      .prepare("SELECT * FROM srt_source WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    if (!srt) throw notFound(`项目原始字幕不存在：${projectId}`);
    return {
      rawContent: srt.raw_content as string,
      sha256: srt.sha256 as string,
      sourceFilename: srt.source_filename as string,
      cueCount: srt.cue_count as number,
      importedAt: srt.imported_at as number,
    };
  }

  listSegments(projectId: string): SegmentRecord[] {
    this.loadProjectRow(projectId);
    const rows = this.stmts.listSegments.all(projectId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      segmentId: r.segment_id as string,
      projectId: r.project_id as string,
      cueNo: (r.cue_no as number | null) ?? null,
      startMs: r.start_ms as number,
      endMs: r.end_ms as number,
      originalText: r.original_text as string,
      correctedText: r.corrected_text as string,
      status: r.status as SegmentStatus,
      revisionNo: r.revision_no as number,
      updatedAt: r.updated_at as number,
    }));
  }

  listIssues(projectId: string): IssueRecord[] {
    this.loadProjectRow(projectId);
    const rows = this.stmts.listIssues.all(projectId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      issueId: r.issue_id as string,
      projectId: r.project_id as string,
      segmentId: r.segment_id as string,
      startMs: r.start_ms as number,
      endMs: r.end_ms as number,
      type: r.type as IssueType,
      severity: r.severity as IssueSeverity,
      note: r.note as string,
      status: r.status as IssueStatus,
      createdAt: r.created_at as number,
      resolvedAt: (r.resolved_at as number | null) ?? null,
    }));
  }

  // ---------- 版本检查 ----------

  /** 读取当前 revision；project 不存在 → 404。 */
  currentRevision(projectId: string): number {
    return this.loadProjectRow(projectId).revision as number;
  }

  /** 兼容路由：由 segmentId 解析所属项目（归属校验在 updateSegment 内再做一次）。 */
  resolveProjectIdForSegment(segmentId: string): string {
    const row = this.stmts.getSegment.get(segmentId) as Record<string, unknown> | undefined;
    if (!row) throw notFound(`字幕段不存在：${segmentId}`);
    return row.project_id as string;
  }

  /** 兼容路由：由 issueId 解析所属项目；不存在返回 undefined。 */
  resolveProjectIdForIssue(issueId: string): string | undefined {
    const row = this.stmts.getIssue.get(issueId) as Record<string, unknown> | undefined;
    return row ? (row.project_id as string) : undefined;
  }

  private assertRevision(projectId: string, expectedRevision: number | undefined): number {
    const current = this.currentRevision(projectId);
    if (expectedRevision === undefined || expectedRevision !== current) {
      throw conflict("项目版本已更新，写入被拒绝（expectedRevision 不匹配）", {
        currentRevision: current,
      });
    }
    return current;
  }

  // ---------- 写入 ----------

  private insertProjectTx(payload: CreateProjectPayload, now: number): ProjectSummary {
    const meta = payload.meta;
    const media = sanitizeMediaForServer(meta.media);
    // 导入/迁移可携带既有播放进度；缺省才是零位（跨设备进度不得丢失，PRD V1.1.0）。
    const playback =
      meta.playback === undefined
        ? ({ positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null } satisfies PlaybackState)
        : sanitizePlayback(meta.playback);
    this.stmts.insertProject.run(
      meta.projectId,
      SERVICE_WORKSPACE_ID,
      meta.name,
      meta.normalizedStem,
      now,
      now,
      JSON.stringify(media),
      JSON.stringify(playback),
    );
    this.stmts.insertSrt.run(
      meta.projectId,
      payload.srtSource.rawContent,
      payload.srtSource.sha256,
      payload.srtSource.sourceFilename,
      payload.srtSource.cueCount,
      now,
    );
    const segmentIds = new Set(payload.segments.map((s) => s.segmentId));
    for (const seg of payload.segments) {
      this.validateSegmentShape(seg);
      this.stmts.insertSegment.run(
        seg.segmentId,
        meta.projectId,
        seg.cueNo ?? null,
        seg.startMs,
        seg.endMs,
        seg.originalText,
        seg.correctedText,
        seg.status,
        now,
      );
    }
    for (const issue of payload.issues ?? []) {
      const rec = issue as unknown as Record<string, unknown>;
      this.validateIssueShape(rec);
      if (rec.projectId !== meta.projectId) {
        throw new TypeError("疑点 projectId 与项目不一致");
      }
      // 归属校验：疑点必须挂在本次导入的项目片段上，拒绝越权孤儿疑点。
      if (!segmentIds.has(rec.segmentId as string)) {
        throw new TypeError("issue.segmentId 不属于该项目（孤儿疑点被拒绝）");
      }
      this.stmts.putIssue.run(
        rec.issueId as string,
        meta.projectId,
        rec.segmentId as string,
        rec.startMs as number,
        rec.endMs as number,
        rec.type as string,
        rec.severity as string,
        rec.note as string,
        rec.status as string,
        rec.createdAt as number,
        (rec.resolvedAt as number | null) ?? null,
      );
    }
    this.stmts.audit.run(meta.projectId, 1, "create_project", "project", meta.projectId, now);
    return {
      projectId: meta.projectId,
      name: meta.name,
      normalizedStem: meta.normalizedStem,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      media,
      playback,
    };
  }

  /**
   * 幂等创建（PRD POST /api/projects）：
   * - 不存在 → 创建（revision=1）；
   * - 存在且原始 SRT 相同 → 返回既有项目，不重写；
   * - 存在且原始 SRT 不同 → 409 source_conflict（原始识别层写一次）。
   */
  createProject(payload: CreateProjectPayload): { created: boolean; revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const existing = this.findProject(payload.meta.projectId);
      if (existing) {
        const src = this.db
          .prepare("SELECT raw_content, sha256 FROM srt_source WHERE project_id = ?")
          .get(payload.meta.projectId) as { raw_content: string; sha256: string } | undefined;
        if (src && (src.raw_content !== payload.srtSource.rawContent || src.sha256 !== payload.srtSource.sha256)) {
          throw sourceConflict("原始识别层已存在且内容不同，拒绝覆盖。", {
            projectId: existing.projectId,
            revision: existing.revision,
          });
        }
        return { created: false, revision: existing.revision, project: existing };
      }
      const project = this.insertProjectTx(payload, Date.now());
      return { created: true, revision: project.revision, project };
    });
  }

  findProject(projectId: string): ProjectSummary | undefined {
    const row = this.stmts.getProject.get(projectId) as Record<string, unknown> | undefined;
    return row ? this.rowToSummary(row) : undefined;
  }

  updatePlayback(
    projectId: string,
    playback: unknown,
    expectedRevision: number | undefined,
  ): { revision: number; project: ProjectSummary } {
    const state = sanitizePlayback(playback);
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      this.db
        .prepare("UPDATE projects SET playback_json = ? WHERE project_id = ?")
        .run(JSON.stringify(state), projectId);
      this.stmts.bumpRevision.run(now, projectId);
      this.stmts.audit.run(projectId, rev + 1, "update_playback", "project", projectId, now);
      const row = this.loadProjectRow(projectId);
      return { revision: rev + 1, project: this.rowToSummary(row) };
    });
  }

  updateMedia(
    projectId: string,
    body: { durationMs?: unknown; relink?: unknown },
    expectedRevision: number | undefined,
  ): { revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const row = this.loadProjectRow(projectId);
      const media = JSON.parse(row.media_json as string) as Record<string, unknown>;
      let changed = false;
      if (body.durationMs !== undefined) {
        const d = intOf(body.durationMs as number, "durationMs", { min: 0 });
        if (media.durationMs !== d) {
          media.durationMs = d;
          changed = true;
        }
      }
      if (body.relink !== undefined) {
        const relink = sanitizeMediaForServer({
          ...media,
          ...(body.relink as Record<string, unknown>),
        });
        Object.assign(media, relink);
        changed = true;
      }
      const now = Date.now();
      if (changed) {
        this.db
          .prepare("UPDATE projects SET media_json = ? WHERE project_id = ?")
          .run(JSON.stringify(media), projectId);
        this.stmts.bumpRevision.run(now, projectId);
        this.stmts.audit.run(projectId, rev + 1, "update_media", "project", projectId, now);
      }
      return { revision: changed ? rev + 1 : rev, project: this.rowToSummary(this.loadProjectRow(projectId)) };
    });
  }

  touchProject(
    projectId: string,
    expectedRevision: number | undefined,
  ): { revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      this.stmts.bumpRevision.run(now, projectId);
      this.stmts.audit.run(projectId, rev + 1, "touch_project", "project", projectId, now);
      return { revision: rev + 1, project: this.rowToSummary(this.loadProjectRow(projectId)) };
    });
  }

  updateSegment(
    projectId: string,
    segmentId: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): { segment: SegmentRecord; revision: number; project: ProjectSummary } {
    const allowed = ["correctedText", "status", "startMs", "endMs"] as const;
    for (const key of Object.keys(patch)) {
      if (!(allowed as readonly string[]).includes(key)) {
        throw new TypeError(`segment 补丁包含未知字段：${key}`);
      }
    }
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const row = this.stmts.getSegment.get(segmentId) as Record<string, unknown> | undefined;
      if (!row || row.project_id !== projectId) {
        throw notFound(`字幕段不存在或不属于该项目：${segmentId}`);
      }
      const correctedText =
        patch.correctedText === undefined
          ? (row.corrected_text as string)
          : (() => {
              if (typeof patch.correctedText !== "string") {
                throw new TypeError("correctedText 必须是字符串");
              }
              return patch.correctedText;
            })();
      let status = row.status as SegmentStatus;
      if (patch.status !== undefined) {
        if (!SEGMENT_STATUSES.includes(patch.status as SegmentStatus)) {
          throw new TypeError(`非法片段状态：${String(patch.status)}`);
        }
        status = patch.status as SegmentStatus;
      }
      let startMs = row.start_ms as number;
      let endMs = row.end_ms as number;
      if (patch.startMs !== undefined) startMs = intOf(patch.startMs, "startMs", { min: 0 });
      if (patch.endMs !== undefined) endMs = intOf(patch.endMs, "endMs", { min: 0 });
      if (startMs >= endMs) throw new TypeError("startMs 必须小于 endMs");
      const now = Date.now();
      this.stmts.updateSegment.run(correctedText, status, now, segmentId);
      this.db
        .prepare("UPDATE segments SET start_ms = ?, end_ms = ? WHERE segment_id = ?")
        .run(startMs, endMs, segmentId);
      this.stmts.bumpRevision.run(now, projectId);
      this.stmts.audit.run(projectId, rev + 1, "update_segment", "segment", segmentId, now);
      return {
        segment: {
          segmentId,
          projectId,
          cueNo: (row.cue_no as number | null) ?? null,
          startMs,
          endMs,
          originalText: row.original_text as string,
          correctedText,
          status,
          revisionNo: ((row.revision_no as number) ?? 1) + 1,
          updatedAt: now,
        },
        revision: rev + 1,
        project: this.rowToSummary(this.loadProjectRow(projectId)),
      };
    });
  }

  putIssue(
    projectId: string,
    issueId: string,
    issue: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): { issue: IssueRecord; revision: number; project: ProjectSummary } {
    this.validateIssueShape(issue);
    if (issue.issueId !== issueId) throw new TypeError("issue.issueId 与路径不一致");
    if (issue.projectId !== projectId) throw new TypeError("issue.projectId 与路径项目不一致");
    const seg = this.stmts.getSegment.get(issue.segmentId as string) as
      | Record<string, unknown>
      | undefined;
    if (!seg || seg.project_id !== projectId) {
      throw new TypeError("issue.segmentId 不属于该项目");
    }
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      this.stmts.putIssue.run(
        issueId,
        projectId,
        issue.segmentId as string,
        issue.startMs as number,
        issue.endMs as number,
        issue.type as string,
        issue.severity as string,
        issue.note as string,
        issue.status as string,
        issue.createdAt as number,
        (issue.resolvedAt as number | null) ?? null,
      );
      this.stmts.bumpRevision.run(now, projectId);
      this.stmts.audit.run(projectId, rev + 1, "upsert_issue", "issue", issueId, now);
      return {
        issue: issue as unknown as IssueRecord,
        revision: rev + 1,
        project: this.rowToSummary(this.loadProjectRow(projectId)),
      };
    });
  }

  deleteIssue(
    projectId: string,
    issueId: string,
    expectedRevision: number | undefined,
  ): { deleted: boolean; revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const row = this.stmts.getIssue.get(issueId) as Record<string, unknown> | undefined;
      if (!row || row.project_id !== projectId) {
        return { deleted: false, revision: rev, project: this.rowToSummary(this.loadProjectRow(projectId)) };
      }
      const now = Date.now();
      this.stmts.deleteIssue.run(issueId);
      this.stmts.bumpRevision.run(now, projectId);
      this.stmts.audit.run(projectId, rev + 1, "delete_issue", "issue", issueId, now);
      return { deleted: true, revision: rev + 1, project: this.rowToSummary(this.loadProjectRow(projectId)) };
    });
  }

  deleteProject(projectId: string, expectedRevision: number | undefined): { deleted: boolean } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      this.db.prepare("DELETE FROM issues WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM segments WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM srt_source WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
      this.stmts.audit.run(projectId, rev + 1, "delete_project", "project", projectId, now);
      return { deleted: true };
    });
  }

  /**
   * 幂等迁移（PRD POST /api/projects/:id/migrate / AC-056）：
   * - 服务端缺失 → 创建（含 issues）；
   * - 服务端已存在 → 不覆盖任何数据，返回服务端现状 + stale 标记（本地 SRT 哈希与服务端不同）。
   */
  migrateProject(payload: CreateProjectPayload): {
    created: boolean;
    stale: boolean;
    revision: number;
    project: ProjectSummary;
  } {
    return this.transaction(() => {
      const existing = this.findProject(payload.meta.projectId);
      if (existing) {
        const src = this.db
          .prepare("SELECT sha256 FROM srt_source WHERE project_id = ?")
          .get(payload.meta.projectId) as { sha256: string } | undefined;
        return {
          created: false,
          stale: !!src && src.sha256 !== payload.srtSource.sha256,
          revision: existing.revision,
          project: existing,
        };
      }
      const project = this.insertProjectTx(payload, Date.now());
      return { created: true, stale: false, revision: project.revision, project };
    });
  }

  private validateSegmentShape(seg: Omit<SegmentRecord, "projectId" | "revisionNo" | "updatedAt">): void {
    rejectUnknownKeys(seg as unknown as Record<string, unknown>, SEGMENT_KEYS, "segment");
    if (typeof seg.segmentId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(seg.segmentId)) {
      throw new TypeError("segment.segmentId 必须是 1-80 位稳定 ID");
    }
    intOf(seg.startMs, "segment.startMs", { min: 0 });
    intOf(seg.endMs, "segment.endMs", { min: 0 });
    if (seg.startMs >= seg.endMs) throw new TypeError("segment.startMs 必须小于 endMs");
    if (typeof seg.originalText !== "string" || typeof seg.correctedText !== "string") {
      throw new TypeError("segment 文本必须是字符串");
    }
    if (!SEGMENT_STATUSES.includes(seg.status)) throw new TypeError(`非法片段状态：${String(seg.status)}`);
    if (seg.cueNo !== null && seg.cueNo !== undefined && !Number.isSafeInteger(seg.cueNo)) {
      throw new TypeError("segment.cueNo 必须是整数或 null");
    }
  }

  private validateIssueShape(issue: Record<string, unknown>): void {
    rejectUnknownKeys(issue, ISSUE_KEYS, "issue");
    const required = ["issueId", "projectId", "segmentId", "startMs", "endMs", "type", "severity", "note", "status", "createdAt"];
    for (const key of required) {
      if (issue[key] === undefined) throw new TypeError(`疑点缺少字段：${key}`);
    }
    intOf(issue.startMs as number, "issue.startMs", { min: 0 });
    intOf(issue.endMs as number, "issue.endMs", { min: 0 });
    if ((issue.startMs as number) >= (issue.endMs as number)) {
      throw new TypeError("issue.startMs 必须小于 issue.endMs");
    }
    intOf(issue.createdAt as number, "issue.createdAt", { min: 0 });
    if (typeof issue.issueId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(issue.issueId)) {
      throw new TypeError("issue.issueId 必须是 1-80 位稳定 ID");
    }
    if (typeof issue.projectId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(issue.projectId)) {
      throw new TypeError("issue.projectId 必须是 1-80 位稳定 ID");
    }
    if (typeof issue.segmentId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(issue.segmentId)) {
      throw new TypeError("issue.segmentId 必须是 1-80 位稳定 ID");
    }
    if (typeof issue.note !== "string") throw new TypeError("issue.note 必须是字符串");
    if (!ISSUE_TYPES.includes(issue.type as IssueType)) throw new TypeError(`非法疑点类型：${String(issue.type)}`);
    if (!ISSUE_SEVERITIES.includes(issue.severity as IssueSeverity)) throw new TypeError(`非法疑点级别：${String(issue.severity)}`);
    if (!ISSUE_STATUSES.includes(issue.status as IssueStatus)) throw new TypeError(`非法疑点状态：${String(issue.status)}`);
    if (issue.resolvedAt !== null && issue.resolvedAt !== undefined && !Number.isSafeInteger(issue.resolvedAt)) {
      throw new TypeError("issue.resolvedAt 必须是整数或 null");
    }
  }
}
