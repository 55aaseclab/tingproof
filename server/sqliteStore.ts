/**
 * 服务端持久化存储（PRD 4.4.2/4.4.4/4.4.6）：
 * - Node 内置 SQLite（node:sqlite DatabaseSync），单文件 + WAL，进程重启后数据与 revision 完整保留；
 * - 项目归属服务端工作空间（service_workspace_id），不归属浏览器/设备/origin；
 * - 每次成功写入在事务中更新数据、revision 与 updated_at，并追加富审计事件（ground-truth 契约）；
 * - 绝不持久化音频正文或文件句柄（media 白名单 + 防御性剥离 audioFile/srtHandle/audioHandle）；
 * - schema version（PRAGMA user_version）驱动旧库原地、幂等、无损迁移：不 drop/recreate 表、不丢旧事件。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { badRequest, conflict, notFound, sourceConflict } from "./errors.ts";
import type {
  AuditEventRecord,
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

/** 当前服务端 schema 版本（PRAGMA user_version）。V1.1.1：audit_events 富审计列。 */
export const SCHEMA_VERSION = 2;

/**
 * 写入请求的客户端来源（PRD V1.1.1 §4.4.6 二）：
 * - clientId 是持久但非实名的客户端实例 ID，不代表经过认证的人；
 * - 缺失请求头时由 apiHandler 以诚实的 unknown/api 回退构造。
 */
export interface AuditClientContext {
  clientId: string;
  source: string;
}

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
  at INTEGER NOT NULL,
  client_id TEXT,
  source TEXT,
  before_json TEXT,
  after_json TEXT,
  changed_fields_json TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_events_project ON audit_events(project_id, id);
`;

/**
 * V1.1.1 富审计列（相对首版 audit_events 的增量）。
 * 旧库原地迁移：逐列检查缺失后 ALTER TABLE ADD COLUMN，绝不 drop/recreate 表；
 * 旧行在新列上保持 null（诚实表达“当时未记录”），API 原样返回。
 */
const AUDIT_EVENT_V1_1_1_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "client_id", ddl: "TEXT" },
  { name: "source", ddl: "TEXT" },
  { name: "before_json", ddl: "TEXT" },
  { name: "after_json", ddl: "TEXT" },
  { name: "changed_fields_json", ddl: "TEXT" },
  { name: "metadata_json", ddl: "TEXT" },
];

/** 读取数据库 schema version（PRAGMA user_version）；只读，不修改任何状态。 */
function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  return Number(row.user_version ?? 0);
}

/** 原地、幂等、无损迁移：补齐 audit_events 富审计列并写入 schema version。
 *  只允许在当前版本 ≤ SCHEMA_VERSION 时调用（构造器已先行检查），因此升级永不倒退。 */
function migrateAuditEvents(db: DatabaseSync): void {
  const info = db.prepare("PRAGMA table_info(audit_events)").all() as unknown as Array<
    Record<string, unknown>
  >;
  const existing = new Set(info.map((col) => String(col.name)));
  for (const col of AUDIT_EVENT_V1_1_1_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE audit_events ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** 集中式审计事件草稿：所有写入路径共用，避免散落手写 JSON（PRD V1.1.1 §4.4.6）。 */
interface AuditDraft {
  projectId: string;
  revision: number;
  action: string;
  objectType: string;
  objectId: string;
  at: number;
  client: AuditClientContext;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changedFields?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

/** 字幕段动作分类所依据的实际差异字段（PRD V1.1.1 AC-059）。 */
function diffSegment(before: SegmentRecord, after: SegmentRecord): string[] {
  const changed: string[] = [];
  if (before.correctedText !== after.correctedText) changed.push("correctedText");
  if (before.status !== after.status) changed.push("status");
  if (before.startMs !== after.startMs) changed.push("startMs");
  if (before.endMs !== after.endMs) changed.push("endMs");
  return changed;
}

/**
 * 按实际前后差异分类字幕段动作（AC-059）：
 * - 仅正文 → edit_segment_text；仅确认 → confirm_segment；仅撤销确认 → unconfirm_segment；
 * - 仅时间范围 → update_segment_timing；多类字段同变（或未命名单一类别）→ update_segment。
 * 分类依据是真实差异而非请求补丁内容：重复提交相同值不会虚构 changedFields。
 */
function classifySegmentAction(before: SegmentRecord, after: SegmentRecord, changed: string[]): string {
  const textChanged = changed.includes("correctedText");
  const statusChanged = changed.includes("status");
  const timingChanged = changed.includes("startMs") || changed.includes("endMs");
  if (textChanged && !statusChanged && !timingChanged) return "edit_segment_text";
  if (statusChanged && !textChanged && !timingChanged) {
    if (after.status === "confirmed") return "confirm_segment";
    if (before.status === "confirmed") return "unconfirm_segment";
    return "update_segment"; // 其他状态迁移（如 unreviewed→editing/questioned）
  }
  if (timingChanged && !textChanged && !statusChanged) return "update_segment_timing";
  return "update_segment"; // fallback：多类字段同变，或未命名单一类别（changedFields=[] 的 no-op 已在调用前提前返回，不会到达此处）
}

/** 疑点动作分类所依据的实际差异字段（AC-060）。 */
const ISSUE_DIFF_FIELDS = [
  "segmentId",
  "startMs",
  "endMs",
  "type",
  "severity",
  "note",
  "status",
  "resolvedAt",
] as const;

function diffIssue(before: IssueRecord, after: IssueRecord): string[] {
  const changed: string[] = [];
  for (const field of ISSUE_DIFF_FIELDS) {
    if (before[field] !== after[field]) changed.push(field);
  }
  return changed;
}

/**
 * 疑点状态翻转主导分类（AC-060）：open→resolved 记 resolve_issue，resolved→open 记 reopen_issue，
 * 其余内容变化记 update_issue；changedFields 始终列出全部实际差异。
 */
function classifyIssueAction(before: IssueRecord, after: IssueRecord): string {
  if (before.status === "open" && after.status === "resolved") return "resolve_issue";
  if (before.status === "resolved" && after.status === "open") return "reopen_issue";
  return "update_issue";
}

/** 请求 → 数据库 canonical 疑点记录：resolvedAt 缺省归一为 null（与 SQL 写入口径一致）。 */
function canonicalIssue(issue: Record<string, unknown>): IssueRecord {
  return {
    ...(issue as unknown as IssueRecord),
    resolvedAt: (issue.resolvedAt as number | null) ?? null,
  };
}

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

/** 审计事件分页上限（PRD V1.1.1 §4.4.6 三：limit 1–500，严格校验）。 */
export const AUDIT_EVENTS_MAX_LIMIT = 500;
export const AUDIT_EVENTS_DEFAULT_LIMIT = 100;

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
    listAuditEvents: StatementSync;
    countSegments: StatementSync;
    countIssues: StatementSync;
  };

  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      // 先读 schema version 再做任何写动作：高于当前程序支持的版本时明确拒绝打开，
      // 保持版本号、表结构和数据完全不变（绝不降级、绝不先执行当前 schema DDL）。
      // 句柄由下方统一的失败清理路径释放（该分支只 throw，不重复 close）。
      const versionOnOpen = readUserVersion(this.db);
      if (versionOnOpen > SCHEMA_VERSION) {
        throw new Error(
          `数据库 schema 版本（${versionOnOpen}）高于当前程序支持的版本（${SCHEMA_VERSION}）：` +
            `为避免降级损坏已拒绝打开，请升级程序后再试。数据库路径：${dbPath}`,
        );
      }
      // WAL + FULL：进程重启/断电后已提交事务不丢（PRD 3.8 / 4.4.2 持久性要求）。
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec(SCHEMA);
      // 旧库原地、幂等、无损迁移（V1.1.1 富审计列）；新库为 no-op。
      // 此处只在 versionOnOpen ≤ SCHEMA_VERSION 时到达，升级不会倒退版本。
      migrateAuditEvents(this.db);
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
          `INSERT INTO audit_events (project_id, revision, action, object_type, object_id, at, client_id, source, before_json, after_json, changed_fields_json, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
        listAuditEvents: this.db.prepare(
          "SELECT * FROM audit_events WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
        ),
        countSegments: this.db.prepare(
          "SELECT COUNT(*) AS n FROM segments WHERE project_id = ?",
        ),
        countIssues: this.db.prepare(
          "SELECT COUNT(*) AS n FROM issues WHERE project_id = ?",
        ),
      };
    } catch (err) {
      // 构造失败释放句柄（P1-10）：open 成功之后的任何初始化异常
      // （读取版本、PRAGMA/SCHEMA/迁移、语句预编译等）都 best-effort close 后原样重抛；
      // 成功构造不受影响，future-version 分支只 throw，由这里统一 close，不重复关闭。
      try {
        this.db.close();
      } catch {
        // close 自身失败（句柄已坏等）：吞掉关闭错误，保留并重抛原始异常。
      }
      throw err;
    }
  }

  /** 当前数据库 schema version（PRAGMA user_version）；测试可断言迁移结果。 */
  get schemaVersion(): number {
    return readUserVersion(this.db);
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

  /**
   * 集中式审计追加（PRD V1.1.1 §4.4.6）：只在成功写入的事务内调用；
   * before/after/changedFields/metadata 统一在此序列化，避免各写入路径手写 JSON。
   */
  private appendAudit(draft: AuditDraft): void {
    const json = (value: Record<string, unknown> | string[] | null | undefined): string | null =>
      value === null || value === undefined ? null : JSON.stringify(value);
    this.stmts.audit.run(
      draft.projectId,
      draft.revision,
      draft.action,
      draft.objectType,
      draft.objectId,
      draft.at,
      draft.client.clientId,
      draft.client.source,
      json(draft.before),
      json(draft.after),
      json(draft.changedFields),
      json(draft.metadata),
    );
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

  private rowToSegment(row: Record<string, unknown>): SegmentRecord {
    return {
      segmentId: row.segment_id as string,
      projectId: row.project_id as string,
      cueNo: (row.cue_no as number | null) ?? null,
      startMs: row.start_ms as number,
      endMs: row.end_ms as number,
      originalText: row.original_text as string,
      correctedText: row.corrected_text as string,
      status: row.status as SegmentStatus,
      revisionNo: row.revision_no as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToIssue(row: Record<string, unknown>): IssueRecord {
    return {
      issueId: row.issue_id as string,
      projectId: row.project_id as string,
      segmentId: row.segment_id as string,
      startMs: row.start_ms as number,
      endMs: row.end_ms as number,
      type: row.type as IssueType,
      severity: row.severity as IssueSeverity,
      note: row.note as string,
      status: row.status as IssueStatus,
      createdAt: row.created_at as number,
      resolvedAt: (row.resolved_at as number | null) ?? null,
    };
  }

  /**
   * 旧行（迁移前）在新列上为 SQL NULL：诚实返回 null，不虚构默认值。
   * 但字段非 NULL 且 JSON 无法解析或类型不符合预期时，查询必须明确失败并暴露数据损坏，
   * 不得把损坏静默伪装成“历史未记录”（PRD V1.1.2 §4.4.6 三）。
   */
  private rowToAuditEvent(row: Record<string, unknown>): AuditEventRecord {
    const eventId = row.id as number;
    const parseField = (
      value: unknown,
      field: string,
      expect: "object" | "stringArray",
    ): Record<string, unknown> | string[] | null => {
      if (value === null || value === undefined) return null;
      if (typeof value !== "string") {
        throw new Error(
          `审计事件 #${eventId} 数据损坏：${field} 应为 JSON 文本或 SQL NULL，实际为 ${typeof value}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(
          `审计事件 #${eventId} 数据损坏：${field} 不是有效 JSON（前 80 字符：${value.slice(0, 80)}）`,
        );
      }
      if (expect === "object") {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(`审计事件 #${eventId} 数据损坏：${field} 应为 JSON 对象`);
        }
        return parsed as Record<string, unknown>;
      }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error(`审计事件 #${eventId} 数据损坏：${field} 应为字符串数组`);
      }
      return parsed as string[];
    };
    return {
      id: eventId,
      projectId: row.project_id as string,
      revision: row.revision as number,
      action: row.action as string,
      objectType: row.object_type as string,
      objectId: row.object_id as string,
      timestamp: row.at as number,
      clientId: (row.client_id as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      before: parseField(row.before_json, "before_json", "object") as Record<string, unknown> | null,
      after: parseField(row.after_json, "after_json", "object") as Record<string, unknown> | null,
      changedFields: parseField(row.changed_fields_json, "changed_fields_json", "stringArray") as
        | string[]
        | null,
      metadata: parseField(row.metadata_json, "metadata_json", "object") as
        | Record<string, unknown>
        | null,
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
    return rows.map((r) => this.rowToSegment(r));
  }

  listIssues(projectId: string): IssueRecord[] {
    this.loadProjectRow(projectId);
    const rows = this.stmts.listIssues.all(projectId) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.rowToIssue(r));
  }

  /**
   * 只读审计事件查询（PRD V1.1.1 §4.4.6 三 / AC-062）：
   * - 按 id 升序稳定分页（id > afterId），limit 1–500 严格校验；
   * - 项目不存在 → 404；不提供任何修改/删除审计事件的路径。
   */
  listAuditEvents(
    projectId: string,
    afterId: number,
    limit: number,
  ): {
    events: AuditEventRecord[];
    pagination: { afterId: number; nextAfterId: number; limit: number; hasMore: boolean };
  } {
    this.loadProjectRow(projectId);
    intOf(afterId, "afterId", { min: 0 });
    intOf(limit, "limit", { min: 1, max: AUDIT_EVENTS_MAX_LIMIT });
    const rows = this.stmts.listAuditEvents.all(projectId, afterId, limit + 1) as unknown as Array<
      Record<string, unknown>
    >;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => this.rowToAuditEvent(r));
    const nextAfterId = page.length > 0 ? page[page.length - 1].id : afterId;
    return { events: page, pagination: { afterId, nextAfterId, limit, hasMore } };
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

  private insertProjectTx(
    payload: CreateProjectPayload,
    now: number,
    client: AuditClientContext,
    origin: "create" | "migrate",
  ): ProjectSummary {
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
    const seenIssueIds = new Set<string>();
    let insertedIssueCount = 0;
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
      // 同一载荷内重复 issueId：显式拒绝（不得 last-write-wins 静默覆盖），
      // 整个创建/迁移事务回滚——项目、SRT、片段、疑点、审计一条不落库。
      if (seenIssueIds.has(rec.issueId as string)) {
        throw new TypeError(
          `issue.issueId 在载荷内重复（issue_id 全局唯一，last-write-wins 被拒绝）：${String(rec.issueId)}`,
        );
      }
      seenIssueIds.add(rec.issueId as string);
      // issue_id 为全局主键：与任何既有项目的疑点碰撞都拒绝，整个创建事务回滚
      // （项目、SRT、片段一条不落库；绝不改写其他项目的疑点）。
      const clash = this.stmts.getIssue.get(rec.issueId as string) as
        | Record<string, unknown>
        | undefined;
      if (clash && clash.project_id !== meta.projectId) {
        throw new TypeError(
          `issue.issueId 与其他项目的既有疑点冲突（issue_id 全局唯一）：${String(rec.issueId)}`,
        );
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
      insertedIssueCount += 1;
    }
    const summary: ProjectSummary = {
      projectId: meta.projectId,
      name: meta.name,
      normalizedStem: meta.normalizedStem,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      media,
      playback,
    };
    // 项目创建快照（AC-058）：低频事件按合理方式补充完整快照；
    // 计数取实际插入值（create/migrate 共用路径），保证快照与主表 canonical 一致。
    this.appendAudit({
      projectId: meta.projectId,
      revision: 1,
      action: "create_project",
      objectType: "project",
      objectId: meta.projectId,
      at: now,
      client,
      before: null,
      after: {
        ...summary,
        segmentCount: payload.segments.length,
        issueCount: insertedIssueCount,
      },
      changedFields: null,
      metadata: { origin, cueCount: payload.srtSource.cueCount },
    });
    return summary;
  }

  /**
   * 幂等创建（PRD POST /api/projects）：
   * - 不存在 → 创建（revision=1）；
   * - 存在且原始 SRT 相同 → 返回既有项目，不重写、不产生审计事件；
   * - 存在且原始 SRT 不同 → 409 source_conflict（原始识别层写一次）。
   */
  createProject(
    payload: CreateProjectPayload,
    client: AuditClientContext,
  ): { created: boolean; revision: number; project: ProjectSummary } {
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
      const project = this.insertProjectTx(payload, Date.now(), client, "create");
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
    client: AuditClientContext,
  ): { revision: number; project: ProjectSummary } {
    const state = sanitizePlayback(playback);
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      this.db
        .prepare("UPDATE projects SET playback_json = ? WHERE project_id = ?")
        .run(JSON.stringify(state), projectId);
      this.stmts.bumpRevision.run(now, projectId);
      // 每 5 秒一次的高频事件保持轻量：不复制大对象，摘要进 metadata（§4.4.6 一.5）。
      this.appendAudit({
        projectId,
        revision: rev + 1,
        action: "update_playback",
        objectType: "project",
        objectId: projectId,
        at: now,
        client,
        before: null,
        after: null,
        changedFields: null,
        metadata: { ...state },
      });
      const row = this.loadProjectRow(projectId);
      return { revision: rev + 1, project: this.rowToSummary(row) };
    });
  }

  updateMedia(
    projectId: string,
    body: { durationMs?: unknown; relink?: unknown },
    expectedRevision: number | undefined,
    client: AuditClientContext,
  ): { revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const row = this.loadProjectRow(projectId);
      const before = JSON.parse(row.media_json as string) as Record<string, unknown>;
      const media = { ...before };
      // 阶段一：受控 durationMs 补丁；阶段二：relink 白名单化覆盖。
      // 保持既有字段应用优先级与最终媒体语义（relink 覆盖 durationMs 阶段的结果）。
      if (body.durationMs !== undefined) {
        media.durationMs = intOf(body.durationMs as number, "durationMs", { min: 0 });
      }
      if (body.relink !== undefined) {
        const relink = sanitizeMediaForServer({
          ...media,
          ...(body.relink as Record<string, unknown>),
        }) as unknown as Record<string, unknown>;
        Object.assign(media, relink);
      }
      // 全部补丁应用并 canonical 后，一次性基于最终 before/after 计算实际差异：
      // 按白名单键序稳定排列、绝不重复；“先改后抵消”的净 no-op 不产生事件。
      const changedFields = MEDIA_KEYS.filter((key) => media[key] !== before[key]);
      const now = Date.now();
      if (changedFields.length > 0) {
        this.db
          .prepare("UPDATE projects SET media_json = ? WHERE project_id = ?")
          .run(JSON.stringify(media), projectId);
        this.stmts.bumpRevision.run(now, projectId);
        this.appendAudit({
          projectId,
          revision: rev + 1,
          action: "update_media",
          objectType: "project",
          objectId: projectId,
          at: now,
          client,
          before: { ...before },
          after: { ...media },
          changedFields,
          metadata: null,
        });
      }
      return { revision: changedFields.length > 0 ? rev + 1 : rev, project: this.rowToSummary(this.loadProjectRow(projectId)) };
    });
  }

  touchProject(
    projectId: string,
    expectedRevision: number | undefined,
    client: AuditClientContext,
  ): { revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      this.stmts.bumpRevision.run(now, projectId);
      this.appendAudit({
        projectId,
        revision: rev + 1,
        action: "touch_project",
        objectType: "project",
        objectId: projectId,
        at: now,
        client,
        before: null,
        after: null,
        changedFields: null,
        metadata: null,
      });
      return { revision: rev + 1, project: this.rowToSummary(this.loadProjectRow(projectId)) };
    });
  }

  updateSegment(
    projectId: string,
    segmentId: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
    client: AuditClientContext,
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
      const before = this.rowToSegment(row);
      const correctedText =
        patch.correctedText === undefined
          ? before.correctedText
          : (() => {
              if (typeof patch.correctedText !== "string") {
                throw new TypeError("correctedText 必须是字符串");
              }
              return patch.correctedText;
            })();
      let status = before.status;
      if (patch.status !== undefined) {
        if (!SEGMENT_STATUSES.includes(patch.status as SegmentStatus)) {
          throw new TypeError(`非法片段状态：${String(patch.status)}`);
        }
        status = patch.status as SegmentStatus;
      }
      let startMs = before.startMs;
      let endMs = before.endMs;
      if (patch.startMs !== undefined) startMs = intOf(patch.startMs, "startMs", { min: 0 });
      if (patch.endMs !== undefined) endMs = intOf(patch.endMs, "endMs", { min: 0 });
      if (startMs >= endMs) throw new TypeError("startMs 必须小于 endMs");
      // 语义 no-op：与当前持久值完全相同的补丁不写对象、不 bump revision、不产生审计，
      // 返回当前对象与当前 revision（PRD V1.1.2 §4.4.6 一.2）。分类基于实际前后差异。
      const changedFields = diffSegment(
        before,
        { ...before, correctedText, status, startMs, endMs },
      );
      if (changedFields.length === 0) {
        return {
          segment: before,
          revision: rev,
          project: this.rowToSummary(this.loadProjectRow(projectId)),
        };
      }
      const now = Date.now();
      const after: SegmentRecord = {
        ...before,
        correctedText,
        status,
        startMs,
        endMs,
        revisionNo: before.revisionNo + 1,
        updatedAt: now,
      };
      this.stmts.updateSegment.run(correctedText, status, now, segmentId);
      this.db
        .prepare("UPDATE segments SET start_ms = ?, end_ms = ? WHERE segment_id = ?")
        .run(startMs, endMs, segmentId);
      this.stmts.bumpRevision.run(now, projectId);
      // 动作分类基于实际前后差异（AC-059）：changedFields 准确，originalText 永不变化。
      this.appendAudit({
        projectId,
        revision: rev + 1,
        action: classifySegmentAction(before, after, changedFields),
        objectType: "segment",
        objectId: segmentId,
        at: now,
        client,
        before: { ...before },
        after: { ...after },
        changedFields,
        metadata: null,
      });
      return {
        segment: after,
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
    client: AuditClientContext,
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
      // 先读旧行再写入：upsert 前的状态决定动作分类（create/update/resolve/reopen）。
      const existingRow = this.stmts.getIssue.get(issueId) as Record<string, unknown> | undefined;
      if (existingRow && existingRow.project_id !== projectId) {
        // issue_id 为全局主键：同名疑点若属于其他项目，一律拒绝（404）——
        // 不修改任何项目、不增长 revision、不产生或泄漏审计（PRD 4.4.4 写入约定 4）。
        throw notFound(`疑点不存在或不属于该项目：${issueId}`);
      }
      const before = existingRow ? this.rowToIssue(existingRow) : null;
      if (before !== null) {
        // createdAt 创建后不可变：篡改请求直接 400 回滚（无写入、无事件）。
        if ((issue.createdAt as number) !== before.createdAt) {
          throw new TypeError("issue.createdAt 与既有记录不一致（创建时间不可变）");
        }
        // 语义 no-op：与当前持久值完全相同的 upsert 不写对象、不 bump revision、不产生审计，
        // 返回当前对象与当前 revision（PRD V1.1.2 §4.4.6 一.2）。
        if (diffIssue(before, canonicalIssue(issue)).length === 0) {
          return {
            issue: before,
            revision: rev,
            project: this.rowToSummary(this.loadProjectRow(projectId)),
          };
        }
      }
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
      // canonical after：从数据库行构造返回值与审计 after，与 listIssues 完全一致
      // （例如请求省略 resolvedAt 时，数据库、返回值和审计 after 均为 null）。
      const storedRow = this.stmts.getIssue.get(issueId) as Record<string, unknown>;
      const after = this.rowToIssue(storedRow);
      // 动作分类（AC-060）：首次写入 create_issue；状态翻转 resolve/reopen；其余 update_issue。
      if (before === null) {
        this.appendAudit({
          projectId,
          revision: rev + 1,
          action: "create_issue",
          objectType: "issue",
          objectId: issueId,
          at: now,
          client,
          before: null,
          after: { ...after },
          changedFields: null,
          metadata: null,
        });
      } else {
        const changedFields = diffIssue(before, after);
        this.appendAudit({
          projectId,
          revision: rev + 1,
          action: classifyIssueAction(before, after),
          objectType: "issue",
          objectId: issueId,
          at: now,
          client,
          before: { ...before },
          after: { ...after },
          changedFields,
          metadata: null,
        });
      }
      this.stmts.bumpRevision.run(now, projectId);
      return {
        issue: after,
        revision: rev + 1,
        project: this.rowToSummary(this.loadProjectRow(projectId)),
      };
    });
  }

  deleteIssue(
    projectId: string,
    issueId: string,
    expectedRevision: number | undefined,
    client: AuditClientContext,
  ): { deleted: boolean; revision: number; project: ProjectSummary } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const row = this.stmts.getIssue.get(issueId) as Record<string, unknown> | undefined;
      if (!row || row.project_id !== projectId) {
        // 幂等删除已不存在的疑点：不产生事件、不增长 revision（§4.4.6 一.2）。
        return { deleted: false, revision: rev, project: this.rowToSummary(this.loadProjectRow(projectId)) };
      }
      const now = Date.now();
      // 删除前完整 IssueRecord 保存在 before，after 为 null（AC-060）。
      const before = this.rowToIssue(row);
      this.stmts.deleteIssue.run(issueId);
      this.stmts.bumpRevision.run(now, projectId);
      this.appendAudit({
        projectId,
        revision: rev + 1,
        action: "delete_issue",
        objectType: "issue",
        objectId: issueId,
        at: now,
        client,
        before: { ...before },
        after: null,
        changedFields: null,
        metadata: null,
      });
      return { deleted: true, revision: rev + 1, project: this.rowToSummary(this.loadProjectRow(projectId)) };
    });
  }

  deleteProject(
    projectId: string,
    expectedRevision: number | undefined,
    client: AuditClientContext,
  ): { deleted: boolean } {
    return this.transaction(() => {
      const rev = this.assertRevision(projectId, expectedRevision);
      const now = Date.now();
      const row = this.loadProjectRow(projectId);
      const summary = this.rowToSummary(row);
      const segmentCount = (this.stmts.countSegments.get(projectId) as { n: number }).n;
      const issueCount = (this.stmts.countIssues.get(projectId) as { n: number }).n;
      this.db.prepare("DELETE FROM issues WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM segments WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM srt_source WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
      // 删除摘要快照进 before；audit_events 行长期保留（§4.4.5/§4.4.6 四.4）。
      this.appendAudit({
        projectId,
        revision: rev + 1,
        action: "delete_project",
        objectType: "project",
        objectId: projectId,
        at: now,
        client,
        before: { ...summary, segmentCount, issueCount },
        after: null,
        changedFields: null,
        metadata: null,
      });
      return { deleted: true };
    });
  }

  /**
   * 幂等迁移（PRD POST /api/projects/:id/migrate / AC-056）：
   * - 服务端缺失 → 创建（含 issues）；
   * - 服务端已存在 → 不覆盖任何数据，返回服务端现状 + stale 标记（本地 SRT 哈希与服务端不同）；
   *   已存在的幂等路径不产生审计事件。
   */
  migrateProject(
    payload: CreateProjectPayload,
    client: AuditClientContext,
  ): {
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
      const project = this.insertProjectTx(payload, Date.now(), client, "migrate");
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
