/**
 * 旧 SQLite schema 数据库迁移探针（PRD V1.1.2 §4.4.6 四 / AC-064）：
 * 真实构造 V1.1.1 之前的数据库（audit_events 仅旧 7 列：id、project_id、revision、action、
 * object_type、object_id、at；user_version=0），然后验证：
 * - 构造 store 后原地迁移（不 drop/recreate 表）、schema version 升至当前值；
 * - 旧 audit_events 行全部保留且可读，新列诚实为 null；
 * - 项目/片段/疑点数据无损；
 * - 新写入产生带完整富审计列的事件；
 * - 重复启动幂等（无重复列、数据不变）；
 * - 全新数据库直接为最新 schema；
 * - 高于当前程序版本的数据库被拒绝打开（不降级、不改表、不执行 DDL、句柄关闭）；
 * - 损坏的非 NULL 审计 JSON 使查询明确失败，SQL NULL 仍诚实返回 null。
 * 只使用临时目录数据库，不触碰 data/tingproof.db。
 */
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS_MAX_LIMIT,
  SCHEMA_VERSION,
  SqliteProjectStore,
} from "../server/sqliteStore.js";

/** V1.1.1 之前的首版 schema（audit_events 仅旧 7 列，无 user_version；富表 13 列 = 旧 7 + 新增 6）。 */
const LEGACY_SCHEMA = `
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

const PROJECT_ID = "tp-legacy-audit";
const CLIENT = { clientId: "ci-legacy-probe", source: "api" };

const dirs: string[] = [];

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tingproof-audit-mig-"));
  dirs.push(dir);
  return join(dir, `${name}.db`);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造带旧审计事件的 V1.1.1 前数据库，返回库文件路径。 */
function buildLegacyDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(LEGACY_SCHEMA);
  const media = {
    audioName: "legacy.mp3",
    audioSize: 123,
    audioLastModified: 1,
    audioFingerprint: "fp",
    srtFileName: "legacy.srt",
    srtSha256: "sha",
    mediaKey: "key-legacy",
    durationMs: null,
  };
  db.prepare(
    "INSERT INTO projects (project_id, service_workspace_id, name, normalized_stem, created_at, updated_at, revision, media_json, playback_json) VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?)",
  ).run(
    PROJECT_ID,
    "workspace-local",
    "旧审计项目",
    "旧审计项目",
    111,
    222,
    JSON.stringify(media),
    JSON.stringify({ positionMs: 42_000, speed: 1, autoRewindMs: 1500, loopSegmentId: null }),
  );
  db.prepare(
    "INSERT INTO srt_source (project_id, raw_content, sha256, source_filename, cue_count, imported_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(PROJECT_ID, "1\n00:00:01,000 --> 00:00:02,000\n旧正文\n", "sha-legacy", "legacy.srt", 1, 333);
  db.prepare(
    "INSERT INTO segments (segment_id, project_id, cue_no, start_ms, end_ms, original_text, corrected_text, status, revision_no, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("seg-legacy-1", PROJECT_ID, 1, 1000, 2000, "旧正文", "旧正文（已校对）", "editing", 2, 444);
  db.prepare(
    "INSERT INTO issues (issue_id, project_id, segment_id, start_ms, end_ms, type, severity, note, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("issue-legacy-1", PROJECT_ID, "seg-legacy-1", 1000, 2000, "unclear", "blocking", "旧疑点", "open", 555, null);
  // 两条旧审计事件（首版 7 列口径）。
  db.prepare(
    "INSERT INTO audit_events (project_id, revision, action, object_type, object_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(PROJECT_ID, 1, "create_project", "project", PROJECT_ID, 111);
  db.prepare(
    "INSERT INTO audit_events (project_id, revision, action, object_type, object_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(PROJECT_ID, 2, "update_segment", "segment", "seg-legacy-1", 444);
  db.close();
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => String(r.name));
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Number(row.user_version ?? 0);
  } finally {
    db.close();
  }
}

describe("旧 schema 数据库探针：原地、幂等、无损迁移（AC-064）", () => {
  it("构造 store 后迁移无损：旧事件仍可读（新列 null）、业务数据不变、schema version 升级", () => {
    const dbPath = tempDbPath("legacy");
    buildLegacyDatabase(dbPath);
    expect(userVersion(dbPath)).toBe(0);

    const store = new SqliteProjectStore(dbPath);
    try {
      // 显式 schema version 可测试。
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);

      // 原地迁移：表未重建（仍叫 audit_events），新列补齐，旧 7 列保留。
      const columns = tableColumns(dbPath, "audit_events");
      expect(columns).toEqual([
        "id",
        "project_id",
        "revision",
        "action",
        "object_type",
        "object_id",
        "at",
        "client_id",
        "source",
        "before_json",
        "after_json",
        "changed_fields_json",
        "metadata_json",
      ]);

      // 旧事件仍可读，数量与内容无损；新列诚实为 null。
      const { events, pagination } = store.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT);
      expect(events).toHaveLength(2);
      expect(pagination.hasMore).toBe(false);
      expect(events[0]).toMatchObject({
        id: 1,
        projectId: PROJECT_ID,
        revision: 1,
        action: "create_project",
        objectType: "project",
        objectId: PROJECT_ID,
        timestamp: 111,
        clientId: null,
        source: null,
        before: null,
        after: null,
        changedFields: null,
        metadata: null,
      });
      expect(events[1]).toMatchObject({ id: 2, action: "update_segment", revision: 2 });

      // 业务数据无损。
      const project = store.findProject(PROJECT_ID);
      expect(project?.revision).toBe(3);
      expect(project?.name).toBe("旧审计项目");
      expect(project?.playback.positionMs).toBe(42_000);
      const segments = store.listSegments(PROJECT_ID);
      expect(segments).toHaveLength(1);
      expect(segments[0].correctedText).toBe("旧正文（已校对）");
      expect(segments[0].revisionNo).toBe(2);
      const issues = store.listIssues(PROJECT_ID);
      expect(issues).toHaveLength(1);
      expect(issues[0].note).toBe("旧疑点");

      // 迁移后的新写入产生带完整富审计列的事件（id 续在旧行之后）。
      store.updateSegment(
        PROJECT_ID,
        "seg-legacy-1",
        { correctedText: "迁移后的新修订" },
        3,
        CLIENT,
      );
      const after = store.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT);
      expect(after.events).toHaveLength(3);
      const newEvent = after.events[2];
      expect(newEvent.id).toBe(3);
      expect(newEvent.action).toBe("edit_segment_text");
      expect(newEvent.clientId).toBe("ci-legacy-probe");
      expect(newEvent.source).toBe("api");
      expect(newEvent.changedFields).toEqual(["correctedText"]);
      expect((newEvent.before as Record<string, unknown>).correctedText).toBe("旧正文（已校对）");
      expect((newEvent.after as Record<string, unknown>).correctedText).toBe("迁移后的新修订");
      // 旧两行原样保留。
      expect(after.events[0].id).toBe(1);
      expect(after.events[1].clientId).toBeNull();
    } finally {
      store.close();
    }
  });

  it("重复启动幂等：再次构造 store 不报错、无重复列、数据与 schema version 不变", () => {
    const dbPath = tempDbPath("idempotent");
    buildLegacyDatabase(dbPath);

    const first = new SqliteProjectStore(dbPath);
    first.updateSegment(PROJECT_ID, "seg-legacy-1", { status: "confirmed" }, 3, CLIENT);
    const snapshot = JSON.stringify(first.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT));
    const columnsAfterFirst = tableColumns(dbPath, "audit_events");
    first.close();

    // 第二次启动（模拟服务重启）：迁移重复执行仍幂等。
    const second = new SqliteProjectStore(dbPath);
    try {
      expect(second.schemaVersion).toBe(SCHEMA_VERSION);
      expect(tableColumns(dbPath, "audit_events")).toEqual(columnsAfterFirst); // 无重复新增列
      expect(JSON.stringify(second.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT))).toBe(
        snapshot,
      ); // 事件不多不少
      expect(second.listSegments(PROJECT_ID)[0].status).toBe("confirmed");
    } finally {
      second.close();
    }

    // 第三次启动同样幂等。
    const third = new SqliteProjectStore(dbPath);
    try {
      expect(third.schemaVersion).toBe(SCHEMA_VERSION);
      expect(JSON.stringify(third.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT))).toBe(
        snapshot,
      );
    } finally {
      third.close();
    }
  });

  it("全新数据库直接为最新 schema：建库即含富审计列与 schema version", () => {
    const dbPath = tempDbPath("fresh");
    const store = new SqliteProjectStore(dbPath);
    try {
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      const columns = tableColumns(dbPath, "audit_events");
      expect(columns).toContain("client_id");
      expect(columns).toContain("source");
      expect(columns).toContain("before_json");
      expect(columns).toContain("after_json");
      expect(columns).toContain("changed_fields_json");
      expect(columns).toContain("metadata_json");
      expect(tableColumns(dbPath, "audit_events").length).toBe(13);
    } finally {
      store.close();
    }
  });

  it("未来 schema 版本被拒绝：不降级、不改表、不执行 DDL、构造失败关闭句柄", () => {
    const dbPath = tempDbPath("future");
    buildLegacyDatabase(dbPath);
    const columnsBefore = tableColumns(dbPath, "audit_events");
    expect(userVersion(dbPath)).toBe(0);

    // 抬到未来版本（模拟“新版程序写过的库被旧程序打开”）。
    const bump = new DatabaseSync(dbPath);
    bump.exec("PRAGMA user_version = 99");
    bump.close();
    expect(userVersion(dbPath)).toBe(99);

    const fdsBefore = openFdsFor(dbPath);
    expect(() => new SqliteProjectStore(dbPath)).toThrow(/高于当前程序支持的版本/);
    if (fdsBefore >= 0) {
      expect(openFdsFor(dbPath)).toBe(fdsBefore); // 构造失败必须关闭句柄，不泄漏
    }

    // 版本号、表结构与数据完全保持（未降级、未执行当前 schema DDL）。
    expect(userVersion(dbPath)).toBe(99);
    expect(tableColumns(dbPath, "audit_events")).toEqual(columnsBefore);
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const seg = verify
        .prepare("SELECT corrected_text FROM segments WHERE segment_id = ?")
        .get("seg-legacy-1") as Record<string, unknown>;
      expect(seg.corrected_text).toBe("旧正文（已校对）");
      const count = verify
        .prepare("SELECT COUNT(*) AS n FROM audit_events")
        .get() as Record<string, unknown>;
      expect(count.n).toBe(2);
    } finally {
      verify.close();
    }

    // 版本降回低值后可正常打开并完成迁移（恢复可用路径）。
    const fix = new DatabaseSync(dbPath);
    fix.exec("PRAGMA user_version = 0");
    fix.close();
    const store = new SqliteProjectStore(dbPath);
    try {
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(store.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT).events).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("不兼容 schema 的构造失败同样释放句柄：抛错、FD 不增加、既有表/数据不被删除", () => {
    const dbPath = tempDbPath("incompatible");
    // 构造不兼容库：只有残缺的 projects 表（缺 updated_at 等列），user_version=0。
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    raw.prepare("INSERT INTO projects (project_id, name) VALUES ('tp-broken', '残缺项目')").run();
    raw.close();

    // 构造在语句预编译阶段失败（listProjects 需要 updated_at 列），原样重抛。
    const fdsBefore = openFdsFor(dbPath);
    expect(() => new SqliteProjectStore(dbPath)).toThrow(/no such column/i);
    if (fdsBefore >= 0) {
      expect(openFdsFor(dbPath)).toBe(fdsBefore); // 句柄已释放，不泄漏
    }

    // 既有表/数据不被删除（失败的是初始化，不是数据清理）。
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = verify
        .prepare("SELECT name FROM projects WHERE project_id = ?")
        .get("tp-broken") as Record<string, unknown>;
      expect(row.name).toBe("残缺项目");
    } finally {
      verify.close();
    }
  });

  it("损坏的审计 JSON：查询明确失败暴露数据损坏；SQL NULL 旧行仍诚实返回 null", () => {
    const dbPath = tempDbPath("corrupt");
    buildLegacyDatabase(dbPath);
    const store = new SqliteProjectStore(dbPath);
    // 追加一条带富审计列的新事件（id=3）。
    store.updateSegment(PROJECT_ID, "seg-legacy-1", { correctedText: "迁移后的新修订" }, 3, CLIENT);
    store.close();

    // 破坏 id=3 的 before_json（非 NULL、无法解析）。
    const corrupt1 = new DatabaseSync(dbPath);
    corrupt1.prepare("UPDATE audit_events SET before_json = ? WHERE id = 3").run("{not-valid-json");
    corrupt1.close();

    const reopened = new SqliteProjectStore(dbPath);
    try {
      // 旧行（SQL NULL）不受影响，可先读到。
      const head = reopened.listAuditEvents(PROJECT_ID, 0, 2);
      expect(head.events).toHaveLength(2);
      expect(head.events[0].before).toBeNull();
      expect(head.events[0].changedFields).toBeNull();
      // 读到损坏行时必须明确失败，不得静默变成 null。
      expect(() => reopened.listAuditEvents(PROJECT_ID, 0, AUDIT_EVENTS_MAX_LIMIT)).toThrow(
        /数据损坏/,
      );
    } finally {
      reopened.close();
    }

    // 类型不符：changed_fields_json 是 JSON 对象而非字符串数组。
    const corrupt2 = new DatabaseSync(dbPath);
    corrupt2
      .prepare("UPDATE audit_events SET before_json = NULL, changed_fields_json = ? WHERE id = 3")
      .run('{"a":1}');
    corrupt2.close();
    const reopened2 = new SqliteProjectStore(dbPath);
    try {
      expect(() => reopened2.listAuditEvents(PROJECT_ID, 2, AUDIT_EVENTS_MAX_LIMIT)).toThrow(
        /数据损坏/,
      );
    } finally {
      reopened2.close();
    }

    // 类型不符：after_json 是数组而非对象。
    const corrupt3 = new DatabaseSync(dbPath);
    corrupt3
      .prepare("UPDATE audit_events SET changed_fields_json = NULL, after_json = ? WHERE id = 3")
      .run("[1,2]");
    corrupt3.close();
    const reopened3 = new SqliteProjectStore(dbPath);
    try {
      expect(() => reopened3.listAuditEvents(PROJECT_ID, 2, AUDIT_EVENTS_MAX_LIMIT)).toThrow(
        /数据损坏/,
      );
    } finally {
      reopened3.close();
    }
  });
});

/** 统计当前进程指向指定数据库文件的打开句柄数；/proc 不可用（非 Linux）返回 -1。 */
function openFdsFor(dbPath: string): number {
  try {
    const fds = readdirSync("/proc/self/fd");
    let count = 0;
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/self/fd/${fd}`) === dbPath) count += 1;
      } catch {
        // fd 在遍历间隙被关闭：忽略。
      }
    }
    return count;
  } catch {
    return -1;
  }
}
