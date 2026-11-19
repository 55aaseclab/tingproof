/**
 * V1.1.4 原子确认服务端测试（PRD §4.4.4 写入约定 7 / AC-068）：
 * - 一次事务确认段（可选 correctedText 草稿）并解决本段全部 open 疑点；
 * - revision 只增长一次；confirm_segment + 按稳定 issueId 顺序的 resolve_issue 共享 revision/时间戳；
 * - 自动解决 metadata 含 cause=segment_confirm 与 confirmedSegmentId；
 * - 既有已解决记录不变；撤销确认只产生 unconfirm_segment，不自动重开；
 * - 409 与注入子写失败（SQL trigger）→ 整体回滚、零半成功事件；
 * - 无实际变化 → 语义 no-op（不增长 revision、不产生事件）；
 * - remoteRepo 生产路径：listSegments 提供 revision 后 confirm 成功并更新 revision 缓存。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRemoteRepository,
  RevisionConflictError,
} from "../src/store/remoteRepo.js";
import { makeProjectPayload, startTestServer, type TestServer } from "./serverHarness.js";

let server: TestServer | null = null;

async function srv(): Promise<TestServer> {
  if (!server) server = await startTestServer();
  return server;
}

afterEach(async () => {
  if (server) {
    await server.dispose();
    server = null;
  }
});

const CLIENT = { "x-tingproof-client-id": "ci-confirm", "x-tingproof-source": "web" };

function issuePayload(projectId: string, issueId: string, segmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    issueId,
    projectId,
    segmentId,
    startMs: 3600,
    endMs: 9460,
    type: "proper_noun",
    severity: "blocking",
    note: `疑点 ${issueId}`,
    status: "open",
    createdAt: 5,
    resolvedAt: null,
    ...overrides,
  };
}

/** 为 seg-1 预置 2 open + 1 resolved 疑点；返回确认前的 revision。 */
async function seedConfirmedTarget(s: TestServer, projectId: string): Promise<number> {
  await s.req("POST", "/api/projects", makeProjectPayload(projectId), CLIENT);
  const segId = `seg-${projectId}-1`;
  let rev = 1;
  for (const issueId of ["issue-a", "issue-b"]) {
    const res = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      { issue: issuePayload(projectId, issueId, segId), expectedRevision: rev },
      CLIENT,
    );
    rev = res.body?.revision as number;
  }
  // 既有已解决疑点（resolvedAt=999）。
  const res = await s.req(
    "PUT",
    `/api/projects/${projectId}/issues/issue-done`,
    {
      issue: issuePayload(projectId, "issue-done", segId, { status: "resolved", resolvedAt: 999 }),
      expectedRevision: rev,
    },
    CLIENT,
  );
  return res.body?.revision as number;
}

async function eventsOf(s: TestServer, projectId: string) {
  const collected: Array<Record<string, unknown>> = [];
  let afterId = 0;
  for (;;) {
    const res = await s.req(
      "GET",
      `/api/projects/${projectId}/audit-events?afterId=${afterId}&limit=50`,
    );
    const body = res.body as {
      events: Array<Record<string, unknown>>;
      pagination: { nextAfterId: number; hasMore: boolean };
    };
    collected.push(...body.events);
    afterId = body.pagination.nextAfterId;
    if (!body.pagination.hasMore) break;
  }
  return collected;
}

describe("原子确认 API（AC-068）", () => {
  it("确认段并解决本段全部 open 疑点：revision+1、事件共享 revision/时间、稳定顺序、metadata 完整", async () => {
    const s = await srv();
    const projectId = "tp-cf-1";
    const rev = await seedConfirmedTarget(s, projectId);
    const segId = `seg-${projectId}-1`;

    const res = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev },
      CLIENT,
    );
    expect(res.status).toBe(200);
    expect(res.body?.revision).toBe(rev + 1); // 只增长一次
    expect((res.body?.segment as Record<string, unknown>).status).toBe("confirmed");
    const resolved = res.body?.resolvedIssues as Array<Record<string, unknown>>;
    expect(resolved.map((i) => i.issueId)).toEqual(["issue-a", "issue-b"]); // 稳定 issueId 顺序
    const resolvedAt = resolved[0].resolvedAt as number;
    expect(resolved[1].resolvedAt).toBe(resolvedAt); // 同一确认时间

    // 持久层：段 confirmed、两条 open → resolved、既有已解决记录不变。
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    const rows = issues.body?.issues as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.issueId, r]));
    expect((byId.get("issue-a") as Record<string, unknown>).status).toBe("resolved");
    expect((byId.get("issue-b") as Record<string, unknown>).status).toBe("resolved");
    expect((byId.get("issue-done") as Record<string, unknown>).status).toBe("resolved");
    expect((byId.get("issue-done") as Record<string, unknown>).resolvedAt).toBe(999); // 不变

    // 审计：confirm_segment + 2×resolve_issue 共享 revision 与时间戳。
    const events = await eventsOf(s, projectId);
    const confirmEvents = events.filter((e) => e.action === "confirm_segment");
    const resolveEvents = events.filter((e) => e.action === "resolve_issue");
    expect(confirmEvents).toHaveLength(1);
    expect(resolveEvents).toHaveLength(2);
    expect(resolveEvents.map((e) => e.objectId)).toEqual(["issue-a", "issue-b"]);
    const confirmAt = confirmEvents[0].timestamp as number;
    for (const e of [...confirmEvents, ...resolveEvents]) {
      expect(e.revision).toBe(rev + 1);
      expect(e.timestamp).toBe(confirmAt);
    }
    for (const [index, e] of resolveEvents.entries()) {
      const metadata = e.metadata as Record<string, unknown>;
      expect(metadata.cause).toBe("segment_confirm");
      expect(metadata.confirmedSegmentId).toBe(segId);
      expect(metadata.order).toBe(index);
      expect((e.before as Record<string, unknown>).status).toBe("open");
      expect((e.after as Record<string, unknown>).status).toBe("resolved");
    }
  });

  it("携带 correctedText 草稿：文本与状态在同一个 confirm_segment 事件中原子提交", async () => {
    const s = await srv();
    const projectId = "tp-cf-2";
    const rev = await seedConfirmedTarget(s, projectId);
    const segId = `seg-${projectId}-1`;

    const res = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev, correctedText: "确认前最后的草稿" },
      CLIENT,
    );
    expect(res.status).toBe(200);
    expect((res.body?.segment as Record<string, unknown>).correctedText).toBe("确认前最后的草稿");

    const events = await eventsOf(s, projectId);
    const confirmEvent = events.find((e) => e.action === "confirm_segment") as Record<string, unknown>;
    expect(confirmEvent.changedFields).toEqual(["correctedText", "status"]);
    expect((confirmEvent.before as Record<string, unknown>).correctedText).toBe("欢迎大家来到创业课");
    expect((confirmEvent.after as Record<string, unknown>).correctedText).toBe("确认前最后的草稿");
    const segs = await s.req("GET", `/api/projects/${projectId}/segments`);
    expect((segs.body?.segments as Array<Record<string, unknown>>)[0].correctedText).toBe("确认前最后的草稿");
  });

  it("无实际变化 → 语义 no-op：不增长 revision、不产生事件", async () => {
    const s = await srv();
    const projectId = "tp-cf-3";
    let rev = await seedConfirmedTarget(s, projectId);
    const segId = `seg-${projectId}-1`;
    const first = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev },
      CLIENT,
    );
    rev = first.body?.revision as number;
    const eventsAfterFirst = (await eventsOf(s, projectId)).length;

    // 再次确认（已 confirmed、文本相同、无 open 疑点）→ no-op。
    const again = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev },
      CLIENT,
    );
    expect(again.status).toBe(200);
    expect(again.body?.revision).toBe(rev); // 不增长
    expect(again.body?.resolvedIssues).toHaveLength(0);
    expect((await eventsOf(s, projectId)).length).toBe(eventsAfterFirst);
  });

  it("409：旧 expectedRevision → 冲突且零副作用（段与疑点全部不变、零事件）", async () => {
    const s = await srv();
    const projectId = "tp-cf-4";
    const rev = await seedConfirmedTarget(s, projectId);
    const segId = `seg-${projectId}-1`;
    const eventsBefore = (await eventsOf(s, projectId)).length;

    const res = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev + 99 },
      CLIENT,
    );
    expect(res.status).toBe(409);
    expect(res.body?.error).toBe("revision_conflict");

    const detail = await s.req("GET", `/api/projects/${projectId}`);
    expect((detail.body?.project as Record<string, unknown>).revision).toBe(rev);
    const segs = await s.req("GET", `/api/projects/${projectId}/segments`);
    expect((segs.body?.segments as Array<Record<string, unknown>>)[0].status).toBe("unreviewed");
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    const open = (issues.body?.issues as Array<Record<string, unknown>>).filter(
      (i) => i.status === "open",
    );
    expect(open).toHaveLength(2);
    expect((await eventsOf(s, projectId)).length).toBe(eventsBefore); // 零半成功事件
  });

  it("注入子写失败（SQL trigger 中止疑点更新）→ 整体回滚：段未确认、零事件、可重试", async () => {
    const s = await srv();
    const projectId = "tp-cf-5";
    const rev = await seedConfirmedTarget(s, projectId);
    const segId = `seg-${projectId}-1`;
    const eventsBefore = (await eventsOf(s, projectId)).length;

    // 在服务端库上注入 trigger：issue-a 的 resolved 更新直接 ABORT（模拟子写失败）。
    const inject = new DatabaseSync(s.dbPath);
    inject.exec(
      `CREATE TRIGGER fail_resolve_issue BEFORE UPDATE ON issues
       WHEN NEW.status = 'resolved' AND OLD.issue_id = 'issue-a'
       BEGIN SELECT RAISE(ABORT, 'injected sub-write failure'); END;`,
    );
    inject.close();

    const res = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev },
      CLIENT,
    );
    expect(res.status).toBe(500); // 注入失败原样上抛
    expect(String(res.body?.message)).toContain("injected");

    // 整体回滚：段未确认、疑点仍 open、revision 未推进、零事件。
    const detail = await s.req("GET", `/api/projects/${projectId}`);
    expect((detail.body?.project as Record<string, unknown>).revision).toBe(rev);
    const segs = await s.req("GET", `/api/projects/${projectId}/segments`);
    expect((segs.body?.segments as Array<Record<string, unknown>>)[0].status).toBe("unreviewed");
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    expect(
      (issues.body?.issues as Array<Record<string, unknown>>).filter((i) => i.status === "open"),
    ).toHaveLength(2);
    expect((await eventsOf(s, projectId)).length).toBe(eventsBefore);

    // 移除注入后重试 → 成功（可重试语义）。
    const clean = new DatabaseSync(s.dbPath);
    clean.exec("DROP TRIGGER fail_resolve_issue");
    clean.close();
    const retry = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev },
      CLIENT,
    );
    expect(retry.status).toBe(200);
    expect(retry.body?.revision).toBe(rev + 1);
    expect(retry.body?.resolvedIssues).toHaveLength(2);
  });

  it("撤销确认只产生 unconfirm_segment，不自动重开已解决疑点", async () => {
    const s = await srv();
    const projectId = "tp-cf-6";
    let rev = await seedConfirmedTarget(s, projectId);
    const segId = `seg-${projectId}-1`;
    const confirmed = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segId}/confirm`,
      { expectedRevision: rev },
      CLIENT,
    );
    rev = confirmed.body?.revision as number;

    const un = await s.req(
      "PATCH",
      `/api/segments/${segId}`,
      { patch: { status: "editing" }, projectId, expectedRevision: rev },
      CLIENT,
    );
    expect(un.status).toBe(200);

    const events = await eventsOf(s, projectId);
    expect(events.some((e) => e.action === "unconfirm_segment")).toBe(true);
    expect(events.filter((e) => e.action === "resolve_issue")).toHaveLength(2); // 不再新增
    expect(events.some((e) => e.action === "reopen_issue")).toBe(false);
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    expect(
      (issues.body?.issues as Array<Record<string, unknown>>).filter((i) => i.status === "open"),
    ).toHaveLength(0); // 疑点保持 resolved
  });

  it("remoteRepo 生产路径：revision 缓存更新，confirm 后可继续写入不 409", async () => {
    const s = await srv();
    const device = createRemoteRepository(`${s.baseUrl}/api`);
    const projectId = "tp-cf-7";
    const payload = makeProjectPayload(projectId);
    await device.createProject({
      meta: {
        projectId,
        name: payload.meta.name,
        normalizedStem: payload.meta.normalizedStem,
        media: payload.meta.media,
      } as unknown as Parameters<typeof device.createProject>[0]["meta"],
      srtSource: payload.srtSource,
      segments: payload.segments,
    });
    const segs = await device.getProjectSegments(projectId);
    // 先建一条 open 疑点，再原子确认。
    await device.upsertIssue({
      issueId: "issue-r1",
      projectId,
      segmentId: segs[1].segmentId,
      startMs: segs[1].startMs,
      endMs: segs[1].endMs,
      type: "unclear",
      severity: "blocking",
      note: "",
      status: "open",
      createdAt: 5,
      resolvedAt: null,
    });
    const result = await device.confirmSegment(segs[0].segmentId);
    expect(result?.segment.status).toBe("confirmed");
    expect(result?.segment.revisionNo).toBe(2);
    // 确认解决的疑点属于另一段：confirm 只解决目标段的 open 疑点。
    expect(result?.resolvedIssues).toHaveLength(0);
    // revision 缓存已更新：后续写操作不 409。
    const updated = await device.updateSegment(segs[1].segmentId, { correctedText: "确认后继续编辑" });
    expect(updated?.revisionNo).toBe(2);
    // 旧 revision 确认 → 409（不静默覆盖）。
    await expect(device.confirmSegment(segs[1].segmentId, { correctedText: "x" })).resolves.toBeDefined();
    const detail = await s.req("GET", `/api/projects/${projectId}`);
    const finalRev = (detail.body?.project as Record<string, unknown>).revision as number;
    const stale = await s.req(
      "POST",
      `/api/projects/${projectId}/segments/${segs[1].segmentId}/confirm`,
      { expectedRevision: 1 },
      CLIENT,
    );
    expect(stale.status).toBe(409);
    expect((stale.body as Record<string, unknown>).currentRevision).toBe(finalRev);
    await expect(
      (async () => {
        throw new RevisionConflictError("probe", undefined);
      })(),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });
});
