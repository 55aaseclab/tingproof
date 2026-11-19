import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_ACTIONS, businessSecurity, type BusinessClaims, type BusinessRequest } from "../server/businessAssertion.ts";
import { createTingProofServer } from "../server/main.ts";
import { SCHEMA_VERSION, SqliteProjectStore } from "../server/sqliteStore.ts";
import { makeProjectPayload, startTestServer, type TestServer } from "./serverHarness.ts";

const KEY = randomBytes(32);
const fixtures: TestServer[] = [];

async function fixture() {
  const server = await startTestServer({ business: { managed: true, key: KEY }, legacySpaceId: "family-a" });
  fixtures.push(server);
  server.store.createProject(makeProjectPayload("project-a"), { clientId: "fixture", source: "test" });
  server.store.createProject(makeProjectPayload("project-b"), { clientId: "fixture", source: "test" });
  return server;
}

function headers(body: BusinessRequest, overrides: Partial<BusinessClaims> = {}, key = KEY, raw = JSON.stringify(body)) {
  const claims: BusinessClaims = {
    v: 1, appId: "tingproof", userId: "user-a", clientId: "client-a", grantId: "grant-a",
    spaceId: body.spaceId, action: BUSINESS_ACTIONS[body.operation], resources: [body.resourceId],
    expiresAt: Date.now() + 20_000, requestId: randomUUID(), method: "POST", path: "/api/business",
    bodyHash: createHash("sha256").update(raw).digest("hex"), ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { "x-praxis-assertion": `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}` };
}

async function invoke(server: TestServer, body: BusinessRequest, overrides: Partial<BusinessClaims> = {}) {
  return server.req("POST", "/api/business", body, headers(body, overrides));
}

function assignment(id = "task-a", segments = ["seg-project-a-1"], extras: Record<string, unknown> = {}): BusinessRequest {
  return {
    operation: "create_assignment", spaceId: "family-a", resourceId: id,
    input: { projectId: "project-a", segmentIds: segments, title: "听校任务", ...extras },
    expectedRevision: 1, idempotencyKey: `create-${id}`,
  };
}

async function createAssignment(server: TestServer, body = assignment()) {
  return invoke(server, body, { resources: ["*"] });
}

function correction(key = "edit-a", segmentId = "seg-project-a-1", expectedRevision = 1): BusinessRequest {
  return {
    operation: "submit_corrections", spaceId: "family-a", resourceId: "task-a", expectedRevision,
    idempotencyKey: key, input: { corrections: [{ segmentId, correctedText: "汉字校正", status: "confirmed" }] },
  };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.dispose()));
});

describe("controlled task business API", () => {
  it("returns only assigned segments and safe assignment metadata", async () => {
    const server = await fixture();
    expect((await createAssignment(server)).status).toBe(200);
    await createAssignment(server, assignment("task-b", ["seg-project-a-2"]));
    const read: BusinessRequest = { operation: "get_assignment", spaceId: "family-a", resourceId: "task-a" };
    const result = await invoke(server, read);
    expect(result.status).toBe(200);
    expect(result.body?.segments).toEqual([expect.objectContaining({ segmentId: "seg-project-a-1" })]);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("seg-project-a-2");
    expect(serialized).not.toContain("srtSource");
    expect(serialized).not.toContain("media");
    expect(serialized).not.toContain("projectId");
    expect(result.body?.cursor).toBeGreaterThan(0);
    expect((await invoke(server, { ...read, resourceId: "task-b" }, { resources: ["task-a"] })).status).toBe(403);
    expect((await invoke(server, { ...read, spaceId: "family-b" })).status).toBe(404);
    expect((await createAssignment(server, { ...assignment("task-c"), spaceId: "family-b" })).status).toBe(404);
    expect((await createAssignment(server, { ...assignment("task-d", ["seg-project-b-1"], { projectId: "project-b" }), spaceId: "family-b" })).status).toBe(404);
  });

  it("binds signatures to app, identity, action, resource, space, method, path, body and short lifetime", async () => {
    const server = await fixture();
    await createAssignment(server);
    const body = correction();
    for (const overrides of [
      { appId: "reminder" }, { userId: "" }, { clientId: "bad.client" }, { grantId: "" },
      { action: "assign" }, { resources: ["task-b"] }, { spaceId: "family-b" },
      { method: "GET" }, { path: "/api/projects" }, { bodyHash: "bad" },
      { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 60_000 },
    ] as Partial<BusinessClaims>[]) {
      expect((await invoke(server, body, overrides)).status).toBe(403);
    }
    expect((await server.req("POST", "/api/business", body)).status).toBe(403);
    expect((await server.req("POST", "/api/business", body, headers(body, {}, randomBytes(32)))).status).toBe(403);
    expect((await server.req("POST", "/api/business?x=1", body, headers(body))).status).toBe(403);
    expect(server.store.currentRevision("project-a")).toBe(1);
    expect((await invoke(server, assignment("task-c"))).status).toBe(403);
  });

  it("blocks every legacy API route and alias in managed mode", async () => {
    const server = await fixture();
    const paths = [
      ["GET", "/api/projects"], ["POST", "/api/projects"], ["GET", "/api/projects/project-a"],
      ["DELETE", "/api/projects/project-a"], ["GET", "/api/projects/project-a/segments"],
      ["GET", "/api/projects/project-a/issues"], ["GET", "/api/projects/project-a/srt"],
      ["GET", "/api/projects/project-a/audit-events"], ["PATCH", "/api/projects/project-a/playback"],
      ["PATCH", "/api/projects/project-a/media"], ["POST", "/api/projects/project-a/touch"],
      ["POST", "/api/projects/project-a/migrate"], ["PATCH", "/api/segments/seg-project-a-1"],
      ["PATCH", "/api/projects/project-a/segments/seg-project-a-1"],
      ["POST", "/api/projects/project-a/segments/seg-project-a-1/confirm"],
      ["DELETE", "/api/issues/issue-a"], ["PUT", "/api/projects/project-a/issues/issue-a"],
      ["GET", "/api/text-prefilter/config"], ["POST", "/api/projects/project-a/text-prefilter-runs"],
      ["POST", "/api/projects/project-a/text-prefilter-runs/run-a/next"], ["GET", "/api/unknown"],
    ];
    for (const [method, path] of paths) {
      const result = await server.req(method, path, method === "GET" ? undefined : {});
      expect(result.status, path).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain("欢迎");
    }
    expect(server.store.currentRevision("project-a")).toBe(1);
  });

  it("commits corrections through existing confirmation rules and persists trusted audit plus replay", async () => {
    const server = await fixture();
    await createAssignment(server);
    const body = correction();
    const first = await invoke(server, body);
    expect(first.status).toBe(200);
    expect(first.body?.revision).toBe(2);
    expect((first.body?.segments as Record<string, unknown>[])[0]).toMatchObject({ correctedText: "汉字校正", status: "confirmed" });
    const eventsBefore = server.store.listAuditEvents("project-a", 0, 100).events.length;
    await server.restart();
    const replay = await invoke(server, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(server.store.currentRevision("project-a")).toBe(2);
    expect(server.store.listAuditEvents("project-a", 0, 100).events).toHaveLength(eventsBefore);
    const reordered = { input: body.input, idempotencyKey: body.idempotencyKey, expectedRevision: body.expectedRevision, resourceId: body.resourceId, spaceId: body.spaceId, operation: body.operation };
    expect((await invoke(server, reordered)).body?.replayed).toBe(true);
    expect((await invoke(server, { ...body, input: { corrections: [{ segmentId: "seg-project-a-1", correctedText: "另一个值" }] } })).status).toBe(409);
    const db = new DatabaseSync(server.dbPath, { readOnly: true });
    try {
      const audit = db.prepare("SELECT * FROM business_events WHERE operation = 'submit_corrections'").all();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ user_id: "user-a", client_id: "client-a", grant_id: "grant-a", assignment_id: "task-a", revision: 2 });
    } finally { db.close(); }
  });

  it("rejects cross-task mixed batches, protected fields and stale versions without partial writes", async () => {
    const server = await fixture();
    await createAssignment(server);
    const body = correction();
    const invalid = { ...body, input: { corrections: [
      { segmentId: "seg-project-a-1", correctedText: "先改" },
      { segmentId: "seg-project-a-2", correctedText: "越权" },
    ] } };
    expect((await invoke(server, invalid)).status).toBe(403);
    expect((await invoke(server, { ...body, input: { corrections: [{ segmentId: "seg-project-a-1", correctedText: "改", originalText: "篡改" }] } })).status).toBe(403);
    expect((await invoke(server, { ...body, expectedRevision: 0 })).status).toBe(409);
    expect(server.store.listSegments("project-a")[0].correctedText).toBe("欢迎大家来到创业课");
    expect(server.store.currentRevision("project-a")).toBe(1);
  });

  it("rolls back the entire batch including audit and idempotency after a late database failure", async () => {
    const server = await fixture();
    await createAssignment(server, assignment("task-a", ["seg-project-a-1", "seg-project-a-2"]));
    const db = new DatabaseSync(server.dbPath);
    try {
      db.exec("CREATE TRIGGER fail_second_correction BEFORE UPDATE ON segments WHEN NEW.segment_id = 'seg-project-a-2' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
      const body = { ...correction(), input: { corrections: [
        { segmentId: "seg-project-a-1", correctedText: "第一段" },
        { segmentId: "seg-project-a-2", correctedText: "第二段" },
      ] } };
      expect((await invoke(server, body)).status).toBe(500);
      expect(server.store.currentRevision("project-a")).toBe(1);
      expect(server.store.listSegments("project-a")[0].correctedText).toBe("欢迎大家来到创业课");
      expect(db.prepare("SELECT COUNT(*) AS n FROM business_events WHERE operation = 'submit_corrections'").get()?.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM business_requests WHERE idempotency_key = 'edit-a'").get()?.n).toBe(0);
      db.exec("DROP TRIGGER fail_second_correction");
      expect((await invoke(server, body)).status).toBe(200);
    } finally { db.close(); }
  });

  it("rechecks the assertion deadline after final metadata writes and before SQLite commit", async () => {
    const server = await fixture();
    await createAssignment(server);
    const originalRevision = server.store.currentRevision("project-a");
    const originalAudit = server.store.listAuditEvents("project-a", 0, 100);
    let clock = Date.now();
    const deadline = clock + 10_000;
    const internal = server.store as unknown as { businessView: (...args: unknown[]) => Record<string, unknown> };
    const view = internal.businessView.bind(server.store);
    internal.businessView = (...args) => {
      const result = view(...args);
      clock = deadline + 1;
      return result;
    };
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      expect((await invoke(server, correction("expired-at-commit"), { expiresAt: deadline })).status).toBe(403);
      expect(server.store.currentRevision("project-a")).toBe(originalRevision);
      expect(server.store.listSegments("project-a")[0].correctedText).toBe("欢迎大家来到创业课");
      expect(server.store.listAuditEvents("project-a", 0, 100)).toEqual(originalAudit);
      const db = new DatabaseSync(server.dbPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS n FROM business_events WHERE operation = 'submit_corrections'").get()?.n).toBe(0);
        expect(db.prepare("SELECT COUNT(*) AS n FROM business_requests WHERE idempotency_key = 'expired-at-commit'").get()?.n).toBe(0);
      } finally { db.close(); }
    } finally {
      now.mockRestore();
      internal.businessView = view;
    }
  });

  it("rejects revoked or expired tasks before cached idempotency results are returned", async () => {
    const server = await fixture();
    await createAssignment(server);
    const body = correction();
    await invoke(server, body);
    const revoke: BusinessRequest = { operation: "revoke_assignment", spaceId: "family-a", resourceId: "task-a", expectedRevision: 2, idempotencyKey: "revoke-a" };
    expect((await invoke(server, revoke)).status).toBe(200);
    expect((await invoke(server, body)).status).toBe(404);
    expect((await invoke(server, { operation: "get_assignment", spaceId: "family-a", resourceId: "task-a" })).status).toBe(404);
    expect((await invoke(server, revoke)).body?.replayed).toBe(true);
    await createAssignment(server, { ...assignment("task-b"), expectedRevision: 2 });
    const db = new DatabaseSync(server.dbPath);
    try { db.prepare("UPDATE business_assignments SET expires_at = ? WHERE assignment_id = ?").run(Date.now() - 1, "task-b"); }
    finally { db.close(); }
    expect((await invoke(server, { operation: "get_assignment", spaceId: "family-a", resourceId: "task-b" })).status).toBe(404);
  });

  it("filters durable metadata events by space and task and supports cursor replay after restart", async () => {
    const server = await fixture();
    await createAssignment(server);
    await createAssignment(server, assignment("task-b", ["seg-project-a-2"]));
    await invoke(server, correction());
    const body: BusinessRequest = { operation: "events", spaceId: "family-a", resourceId: "events", input: { after: 0 } };
    const first = await invoke(server, body, { resources: ["task-a"] });
    expect(first.status).toBe(200);
    const events = first.body?.events as Record<string, unknown>[];
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.resourceId === "task-a")).toBe(true);
    expect(JSON.stringify(first.body)).not.toContain("correctedText");
    expect(JSON.stringify(first.body)).not.toContain("user-a");
    expect(JSON.stringify(first.body)).not.toContain("task-b");
    await server.restart();
    const next = await invoke(server, { ...body, input: { after: first.body?.cursor } }, { resources: ["task-a"] });
    expect(next.body?.events).toEqual([]);
    expect(next.body?.cursor).toBe(first.body?.cursor);
    expect((await invoke(server, { ...body, spaceId: "family-b" }, { resources: ["*"] })).body?.events).toEqual([]);
    expect((await invoke(server, { ...body, input: { after: -1 } }, { resources: ["*"] })).status).toBe(400);
  });

  it("discovers only active authorized assignments without segment content or project identities", async () => {
    const server = await fixture();
    expect((await createAssignment(server)).body?.segments).toBeUndefined();
    await createAssignment(server, assignment("task-b", ["seg-project-a-2"]));
    const body: BusinessRequest = { operation: "list_assignments", spaceId: "family-a", resourceId: "assignments" };
    const result = await invoke(server, body, { resources: ["task-a"] });
    expect(result.status).toBe(200);
    expect(result.body?.assignments).toEqual([{ id: "task-a", title: "听校任务", status: "active", revision: 1, expiresAt: null }]);
    expect(JSON.stringify(result.body)).not.toContain("segments");
    expect(JSON.stringify(result.body)).not.toContain("project-a");
    expect((await invoke(server, body, { resources: ["*"] })).body?.assignments).toHaveLength(2);
    await invoke(server, { operation: "revoke_assignment", spaceId: "family-a", resourceId: "task-a", expectedRevision: 1, idempotencyKey: "revoke-a" });
    expect((await invoke(server, body, { resources: ["task-a"] })).body?.assignments).toEqual([]);
  });

  it("paginates metadata events without skipping commits beyond the first hundred", async () => {
    const server = await fixture();
    await createAssignment(server);
    await createAssignment(server, assignment("task-b", ["seg-project-a-2"]));
    const db = new DatabaseSync(server.dbPath);
    try {
      const insert = db.prepare("INSERT INTO business_events(space_id, assignment_id, revision, operation, user_id, client_id, grant_id, request_id, committed_at) VALUES ('family-a', ?, 1, 'submit_corrections', 'fixture', 'fixture', 'fixture', ?, ?)");
      for (let index = 0; index < 110; index++) insert.run(index % 2 === 0 ? "task-a" : "task-b", `event-${index}`, Date.now());
    } finally { db.close(); }
    const body: BusinessRequest = { operation: "events", spaceId: "family-a", resourceId: "events" };
    const first = await invoke(server, body, { resources: ["*"] });
    expect(first.body?.events).toHaveLength(100);
    expect(first.body?.cursor).toBe(100);
    const second = await invoke(server, { ...body, input: { after: 100 } }, { resources: ["*"] });
    expect(second.body?.events).toHaveLength(12);
    expect(second.body?.cursor).toBe(112);
    const own = await invoke(server, body, { resources: ["task-a"] });
    expect(own.body?.events).toHaveLength(56);
    expect((own.body?.events as { resourceId: string }[]).every((event) => event.resourceId === "task-a")).toBe(true);
  });

  it("preserves atomic segment confirmation and records authenticated user attribution", async () => {
    const server = await fixture();
    await createAssignment(server);
    server.store.putIssue("project-a", "issue-fixture", {
      issueId: "issue-fixture", projectId: "project-a", segmentId: "seg-project-a-1", startMs: 1600, endMs: 2940,
      type: "unclear", severity: "warning", note: "需复核", status: "open", createdAt: Date.now(), resolvedAt: null,
    }, 1, { clientId: "fixture", source: "test" });
    const result = await invoke(server, correction("confirm-a", "seg-project-a-1", 2));
    expect(result.status).toBe(200);
    expect(server.store.listIssues("project-a")[0].status).toBe("resolved");
    const events = server.store.listAuditEvents("project-a", 0, 100).events.filter((event) => event.revision === 3);
    expect(events.map((event) => event.action)).toEqual(["confirm_segment", "resolve_issue"]);
    for (const event of events) expect(event.metadata?.business).toMatchObject({ userId: "user-a", grantId: "grant-a", spaceId: "family-a" });
    expect(JSON.stringify(result.body)).not.toContain("originalText");
    expect(JSON.stringify(result.body)).not.toContain("需复核");
  });

  it("upgrades a synthetic schema3 database without changing project content or old audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "tingproof-schema3-"));
    const path = join(dir, "fixture.db");
    try {
      let store = new SqliteProjectStore(path);
      store.createProject(makeProjectPayload("legacy"), { clientId: "fixture", source: "test" });
      const before = store.getProjectDetail("legacy");
      const audit = store.listAuditEvents("legacy", 0, 100);
      store.close();
      const old = new DatabaseSync(path);
      old.exec("DROP TABLE business_assignment_segments; DROP TABLE business_assignments; DROP TABLE business_project_spaces; DROP TABLE business_requests; DROP TABLE business_events; PRAGMA user_version = 3");
      old.close();
      store = new SqliteProjectStore(path);
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(store.getProjectDetail("legacy")).toEqual(before);
      expect(store.listAuditEvents("legacy", 0, 100)).toEqual(audit);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed before opening a database when managed signing configuration is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tingproof-key-"));
    try {
      expect(() => createTingProofServer({ dbPath: join(dir, "must-not-exist.db"), business: { managed: true } })).toThrow("signing key");
      expect(existsSync(join(dir, "must-not-exist.db"))).toBe(false);
      expect(() => businessSecurity({ managed: true, key: Buffer.alloc(1) })).toThrow("32 to 4096");
      const path = join(dir, "key");
      writeFileSync(path, KEY, { mode: 0o600 });
      vi.stubEnv("TINGPROOF_BUSINESS_KEY_FILE", path);
      expect(businessSecurity({ managed: true }).key).toEqual(KEY);
      chmodSync(path, 0o644);
      expect(() => businessSecurity({ managed: true })).toThrow("private regular file");
      chmodSync(path, 0o600);
      symlinkSync(path, join(dir, "link"));
      vi.stubEnv("TINGPROOF_BUSINESS_KEY_FILE", join(dir, "link"));
      expect(() => businessSecurity({ managed: true })).toThrow("private regular file");
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
});
