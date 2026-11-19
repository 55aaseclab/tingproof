/**
 * ground-truth 富审计事件集成测试（PRD V1.1.2 §4.4.6 / AC-058…AC-065）：
 * - 动作分类（segment：edit/confirm/unconfirm/timing/update；issue：create/update/resolve/reopen/delete）
 *   与 before/after/changedFields/revision/客户端来源；
 * - 疑点删除后主表记录消失但 delete_issue 的 before 仍完整可查询；
 * - 409 / 非法请求 / 失败写入不产生事件；成功但无变化的幂等请求（segment/issue no-op）
 *   不写对象、不增长 revision、不产生审计；
 * - 跨项目 issueId 对抗（全局主键）：putIssue 拒绝他项目同名疑点、导入碰撞整体回滚；
 * - createdAt 创建后不可变；after/返回值为数据库 canonical 值（resolvedAt 缺省归一 null）；
 * - 服务重启后事件保留，分页无重复无遗漏，查询参数严格校验；
 * - 客户端来源：合法记录、非法 400、缺失诚实回退 unknown/api；remoteRepo 自动携带。
 * 全部使用临时数据库（serverHarness），不触碰 data/tingproof.db。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getClientInstanceId } from "../src/store/clientIdentity.js";
import { createRemoteRepository, type RemoteProjectRepository } from "../src/store/remoteRepo.js";
import type { AuditEventRecord } from "../src/store/types.js";
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

const CLIENT = { "x-tingproof-client-id": "ci-audit-device", "x-tingproof-source": "web" };

type Event = Record<string, unknown>;

async function eventsOf(s: TestServer, projectId: string): Promise<Event[]> {
  const collected: Event[] = [];
  let afterId = 0;
  for (;;) {
    const res = await s.req(
      "GET",
      `/api/projects/${projectId}/audit-events?afterId=${afterId}&limit=50`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { events: Event[]; pagination: { nextAfterId: number; hasMore: boolean } };
    collected.push(...body.events);
    afterId = body.pagination.nextAfterId;
    if (!body.pagination.hasMore) break;
  }
  return collected;
}

function issuePayload(projectId: string, issueId: string, overrides: Record<string, unknown> = {}) {
  return {
    issueId,
    projectId,
    segmentId: `seg-${projectId}-2`,
    startMs: 3600,
    endMs: 9460,
    type: "proper_noun",
    severity: "blocking",
    note: "专名待查",
    status: "open",
    createdAt: 5,
    resolvedAt: null,
    ...overrides,
  };
}

describe("富审计事件结构与客户端来源（AC-058/AC-061）", () => {
  it("create_project：字段齐全、after 为结构化项目快照、clientId/source 如实记录", async () => {
    const s = await srv();
    const created = await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-create"), CLIENT);
    expect(created.status).toBe(201);

    const page = await s.req("GET", "/api/projects/tp-audit-create/audit-events");
    expect(page.status).toBe(200);
    const events = page.body?.events as Event[];
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.id).toBeGreaterThanOrEqual(1);
    expect(ev.projectId).toBe("tp-audit-create");
    expect(ev.revision).toBe(1);
    expect(ev.action).toBe("create_project");
    expect(ev.objectType).toBe("project");
    expect(ev.objectId).toBe("tp-audit-create");
    expect(ev.timestamp).toBeGreaterThan(0);
    expect(ev.clientId).toBe("ci-audit-device");
    expect(ev.source).toBe("web");
    expect(ev.before).toBeNull();
    expect(ev.changedFields).toBeNull();
    const after = ev.after as Record<string, unknown>;
    expect(after.projectId).toBe("tp-audit-create");
    expect(after.name).toBe("项目 tp-audit-create");
    expect(after.segmentCount).toBe(2);
    expect(after.issueCount).toBe(0);
    expect((after.media as Record<string, unknown>).mediaKey).toBe("key-tp-audit-create");
    expect((ev.metadata as Record<string, unknown>).origin).toBe("create");
    expect((ev.metadata as Record<string, unknown>).cueCount).toBe(2);
  });

  it("缺失请求头 → 诚实回退 unknown/api；非法请求头 → 400", async () => {
    const s = await srv();
    const created = await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-unknown"));
    expect(created.status).toBe(201);
    const events = await eventsOf(s, "tp-audit-unknown");
    expect(events).toHaveLength(1);
    expect(events[0].clientId).toBe("unknown");
    expect(events[0].source).toBe("api");

    // 非法 clientId（非法字符）→ 400，不落任何事件。
    const bad1 = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-unknown-1",
      { patch: { correctedText: "x" }, projectId: "tp-audit-unknown", expectedRevision: 1 },
      { "x-tingproof-client-id": "bad id!" },
    );
    expect(bad1.status).toBe(400);
    // 非法 clientId（超长）→ 400。
    const bad2 = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-unknown-1",
      { patch: { correctedText: "x" }, projectId: "tp-audit-unknown", expectedRevision: 1 },
      { "x-tingproof-client-id": "x".repeat(81) },
    );
    expect(bad2.status).toBe(400);
    // 非法 source → 400。
    const bad3 = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-unknown-1",
      { patch: { correctedText: "x" }, projectId: "tp-audit-unknown", expectedRevision: 1 },
      { "x-tingproof-source": "bad source!" },
    );
    expect(bad3.status).toBe(400);
    expect(await eventsOf(s, "tp-audit-unknown")).toHaveLength(1);
  });

  it("remoteRepo 自动携带持久 clientId 与 source=web（生产前端路径）", async () => {
    const s = await srv();
    const repo = createRemoteRepository(`${s.baseUrl}/api`);
    const payload = makeProjectPayload("tp-audit-repo");
    await repo.createProject({
      meta: {
        projectId: "tp-audit-repo",
        name: payload.meta.name,
        normalizedStem: payload.meta.normalizedStem,
        media: payload.meta.media,
      } as unknown as Parameters<RemoteProjectRepository["createProject"]>[0]["meta"],
      srtSource: payload.srtSource,
      segments: payload.segments,
    });
    const events = await eventsOf(s, "tp-audit-repo");
    expect(events).toHaveLength(1);
    expect(events[0].clientId).toBe(getClientInstanceId());
    expect(events[0].source).toBe("web");
    // 客户端实例 ID 形如 ci-<uuid>，通过服务端字符集校验。
    expect(getClientInstanceId()).toMatch(/^ci-[0-9a-f-]{36}$/);
  });

  it("迁移创建（migrate）事件带 origin=migrate；幂等重复迁移不产生新事件", async () => {
    const s = await srv();
    const payload = makeProjectPayload("tp-audit-mig");
    const first = await s.req("POST", "/api/projects/tp-audit-mig/migrate", payload, CLIENT);
    expect(first.status).toBe(201);
    const second = await s.req("POST", "/api/projects/tp-audit-mig/migrate", payload, CLIENT);
    expect(second.status).toBe(200);
    expect(second.body?.created).toBe(false);
    const events = await eventsOf(s, "tp-audit-mig");
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("create_project");
    expect((events[0].metadata as Record<string, unknown>).origin).toBe("migrate");
  });
});

describe("字幕段动作分类（AC-059）", () => {
  it("仅正文 → edit_segment_text；仅确认 → confirm_segment；撤销确认 → unconfirm_segment", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-seg"), CLIENT);
    const segId = "seg-tp-audit-seg-1";

    // 仅正文变化。
    const r1 = await s.req(
      "PATCH",
      `/api/segments/${segId}`,
      { patch: { correctedText: "第一处修订" }, projectId: "tp-audit-seg", expectedRevision: 1 },
      CLIENT,
    );
    expect(r1.status).toBe(200);
    expect(r1.body?.revision).toBe(2);
    let events = await eventsOf(s, "tp-audit-seg");
    let ev = events[events.length - 1] as Event;
    expect(ev.action).toBe("edit_segment_text");
    expect(ev.revision).toBe(2);
    expect(ev.changedFields).toEqual(["correctedText"]);
    const before1 = ev.before as Record<string, unknown>;
    const after1 = ev.after as Record<string, unknown>;
    // before/after 是完整 SegmentRecord（结构化对象，字段齐全）。
    for (const key of [
      "segmentId",
      "projectId",
      "cueNo",
      "startMs",
      "endMs",
      "originalText",
      "correctedText",
      "status",
      "revisionNo",
      "updatedAt",
    ]) {
      expect(before1).toHaveProperty(key);
      expect(after1).toHaveProperty(key);
    }
    expect(before1.correctedText).toBe("欢迎大家来到创业课");
    expect(after1.correctedText).toBe("第一处修订");
    expect(before1.originalText).toBe("欢迎大家来到创业课");
    expect(after1.originalText).toBe("欢迎大家来到创业课"); // originalText 永不可改

    // 仅确认。
    await s.req(
      "PATCH",
      `/api/segments/${segId}`,
      { patch: { status: "confirmed" }, projectId: "tp-audit-seg", expectedRevision: 2 },
      CLIENT,
    );
    events = await eventsOf(s, "tp-audit-seg");
    ev = events[events.length - 1];
    expect(ev.action).toBe("confirm_segment");
    expect(ev.changedFields).toEqual(["status"]);
    expect((ev.before as Record<string, unknown>).status).toBe("unreviewed");
    expect((ev.after as Record<string, unknown>).status).toBe("confirmed");

    // 撤销确认。
    await s.req(
      "PATCH",
      `/api/segments/${segId}`,
      { patch: { status: "editing" }, projectId: "tp-audit-seg", expectedRevision: 3 },
      CLIENT,
    );
    events = await eventsOf(s, "tp-audit-seg");
    ev = events[events.length - 1];
    expect(ev.action).toBe("unconfirm_segment");
    expect(ev.changedFields).toEqual(["status"]);
    expect((ev.before as Record<string, unknown>).status).toBe("confirmed");
    expect((ev.after as Record<string, unknown>).status).toBe("editing");
  });

  it("仅时间范围 → update_segment_timing；多类字段同变 → update_segment 且 changedFields 准确", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-seg2"), CLIENT);
    const segId = "seg-tp-audit-seg2-1";

    await s.req(
      "PATCH",
      `/api/segments/${segId}`,
      { patch: { startMs: 1700, endMs: 3000 }, projectId: "tp-audit-seg2", expectedRevision: 1 },
      CLIENT,
    );
    let events = await eventsOf(s, "tp-audit-seg2");
    let ev = events[events.length - 1];
    expect(ev.action).toBe("update_segment_timing");
    expect(ev.changedFields).toEqual(["startMs", "endMs"]);
    expect((ev.before as Record<string, unknown>).startMs).toBe(1600);
    expect((ev.after as Record<string, unknown>).endMs).toBe(3000);

    // 一次请求同时改正文、状态与时间。
    await s.req(
      "PATCH",
      `/api/segments/${segId}`,
      {
        patch: { correctedText: "综合修订", status: "confirmed", startMs: 1800, endMs: 3100 },
        projectId: "tp-audit-seg2",
        expectedRevision: 2,
      },
      CLIENT,
    );
    events = await eventsOf(s, "tp-audit-seg2");
    ev = events[events.length - 1];
    expect(ev.action).toBe("update_segment");
    expect(ev.changedFields).toEqual(["correctedText", "status", "startMs", "endMs"]);
  });

  it("重复提交相同值（segment no-op）：不写对象、不 bump revision、不产生审计", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-noop"), CLIENT);
    // 先做一次真实修改（rev 2），再原样重复提交同一补丁。
    const first = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-noop-1",
      { patch: { correctedText: "第一稿" }, projectId: "tp-audit-noop", expectedRevision: 1 },
      CLIENT,
    );
    expect(first.status).toBe(200);
    expect(first.body?.revision).toBe(2);
    const again = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-noop-1",
      { patch: { correctedText: "第一稿" }, projectId: "tp-audit-noop", expectedRevision: 2 },
      CLIENT,
    );
    expect(again.status).toBe(200);
    expect(again.body?.revision).toBe(2); // 无变化：revision 不增长
    expect((again.body?.segment as Record<string, unknown>).correctedText).toBe("第一稿");
    expect((again.body?.segment as Record<string, unknown>).revisionNo).toBe(2); // 对象未重写
    const events = await eventsOf(s, "tp-audit-noop");
    expect(events).toHaveLength(2); // create_project + edit_segment_text；无空 update_segment
    expect(events[1].action).toBe("edit_segment_text");
    const detail = await s.req("GET", "/api/projects/tp-audit-noop");
    expect((detail.body?.project as Record<string, unknown>).revision).toBe(2);
  });
});

describe("疑点动作分类与删除留痕（AC-060）", () => {
  it("create → update → resolve → reopen → delete：前后状态完整、changedFields 准确", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-issue"), CLIENT);
    const projectId = "tp-audit-issue";
    const issueId = "issue-audit-1";
    let rev = 1;

    // 创建。
    const c = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      { issue: issuePayload(projectId, issueId), expectedRevision: rev },
      CLIENT,
    );
    expect(c.status).toBe(200);
    rev = c.body?.revision as number;
    let events = await eventsOf(s, projectId);
    let ev = events[events.length - 1];
    expect(ev.action).toBe("create_issue");
    expect(ev.before).toBeNull();
    expect(ev.changedFields).toBeNull();
    const created = ev.after as Record<string, unknown>;
    expect(created.issueId).toBe(issueId);
    expect(created.type).toBe("proper_noun");
    expect(created.status).toBe("open");
    expect(ev.clientId).toBe("ci-audit-device");

    // 更新备注。
    const u = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      { issue: issuePayload(projectId, issueId, { note: "查证后疑似品牌名" }), expectedRevision: rev },
      CLIENT,
    );
    rev = u.body?.revision as number;
    events = await eventsOf(s, projectId);
    ev = events[events.length - 1];
    expect(ev.action).toBe("update_issue");
    expect(ev.changedFields).toEqual(["note"]);
    expect((ev.before as Record<string, unknown>).note).toBe("专名待查");

    // 解决（保持已更新的备注，仅状态翻转）。
    const r = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      {
        issue: issuePayload(projectId, issueId, {
          note: "查证后疑似品牌名",
          status: "resolved",
          resolvedAt: 123456,
        }),
        expectedRevision: rev,
      },
      CLIENT,
    );
    rev = r.body?.revision as number;
    events = await eventsOf(s, projectId);
    ev = events[events.length - 1];
    expect(ev.action).toBe("resolve_issue");
    expect((ev.before as Record<string, unknown>).status).toBe("open");
    expect((ev.after as Record<string, unknown>).status).toBe("resolved");
    expect((ev.after as Record<string, unknown>).resolvedAt).toBe(123456);
    expect((ev.changedFields as string[]).sort()).toEqual(["resolvedAt", "status"]);

    // 重开（仅状态翻转回 open）。
    const o = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      {
        issue: issuePayload(projectId, issueId, { note: "查证后疑似品牌名" }),
        expectedRevision: rev,
      },
      CLIENT,
    );
    rev = o.body?.revision as number;
    events = await eventsOf(s, projectId);
    ev = events[events.length - 1];
    expect(ev.action).toBe("reopen_issue");
    expect((ev.before as Record<string, unknown>).status).toBe("resolved");
    expect((ev.after as Record<string, unknown>).status).toBe("open");

    // 删除：主表记录消失，但 delete_issue 的 before 完整可查询。
    const d = await s.req(
      "DELETE",
      `/api/projects/${projectId}/issues/${issueId}`,
      { expectedRevision: rev },
      CLIENT,
    );
    expect(d.status).toBe(200);
    expect(d.body?.deleted).toBe(true);
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    expect(issues.body?.issues).toHaveLength(0);
    events = await eventsOf(s, projectId);
    ev = events[events.length - 1];
    expect(ev.action).toBe("delete_issue");
    expect(ev.after).toBeNull();
    const deleted = ev.before as Record<string, unknown>;
    expect(deleted.issueId).toBe(issueId);
    expect(deleted.type).toBe("proper_noun");
    expect(deleted.severity).toBe("blocking");
    expect(deleted.note).toBe("查证后疑似品牌名");
    expect(deleted.startMs).toBe(3600);
    expect(deleted.segmentId).toBe("seg-tp-audit-issue-2");
  });

  it("级别（severity）变化 → update_issue 且 changedFields 只含 severity", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-issue2"), CLIENT);
    const projectId = "tp-audit-issue2";
    await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/issue-a2`,
      { issue: issuePayload(projectId, "issue-a2"), expectedRevision: 1 },
      CLIENT,
    );
    await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/issue-a2`,
      { issue: issuePayload(projectId, "issue-a2", { severity: "warning" }), expectedRevision: 2 },
      CLIENT,
    );
    const events = await eventsOf(s, projectId);
    const ev = events[events.length - 1];
    expect(ev.action).toBe("update_issue");
    expect(ev.changedFields).toEqual(["severity"]);
  });

  it("issue no-op：完全相同的 upsert 不写对象、不 bump revision、不产生审计", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-issue-noop"), CLIENT);
    const projectId = "tp-audit-issue-noop";
    const c = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/issue-noop-1`,
      { issue: issuePayload(projectId, "issue-noop-1"), expectedRevision: 1 },
      CLIENT,
    );
    expect(c.body?.revision).toBe(2);
    const again = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/issue-noop-1`,
      { issue: issuePayload(projectId, "issue-noop-1"), expectedRevision: 2 },
      CLIENT,
    );
    expect(again.status).toBe(200);
    expect(again.body?.revision).toBe(2); // 无变化：revision 不增长
    expect((again.body?.issue as Record<string, unknown>).status).toBe("open");
    const events = await eventsOf(s, projectId);
    expect(events).toHaveLength(2); // create_project + create_issue；无空 update_issue
    const detail = await s.req("GET", `/api/projects/${projectId}`);
    expect((detail.body?.project as Record<string, unknown>).revision).toBe(2);
  });

  it("after 为数据库 canonical 值：请求省略 resolvedAt 时返回值、审计 after 与持久行均为 null", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-canonical"), CLIENT);
    const projectId = "tp-audit-canonical";
    const issueId = "issue-canonical-1";
    // 省略 resolvedAt 字段（服务端允许：落库为 SQL NULL）。
    const payload = issuePayload(projectId, issueId);
    delete (payload as Record<string, unknown>).resolvedAt;
    const res = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      { issue: payload, expectedRevision: 1 },
      CLIENT,
    );
    expect(res.status).toBe(200);
    const returned = res.body?.issue as Record<string, unknown>;
    expect("resolvedAt" in returned).toBe(true); // 字段存在且明确为 null（不是缺失）
    expect(returned.resolvedAt).toBeNull();

    // 审计 after 同样是数据库最终值。
    const events = await eventsOf(s, projectId);
    const ev = events[events.length - 1];
    expect(ev.action).toBe("create_issue");
    const after = ev.after as Record<string, unknown>;
    expect("resolvedAt" in after).toBe(true);
    expect(after.resolvedAt).toBeNull();

    // 持久行与 listIssues 一致。
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    const stored = (issues.body?.issues as Array<Record<string, unknown>>)[0];
    expect(stored.resolvedAt).toBeNull();
  });

  it("createdAt 创建后不可变：篡改请求 400 回滚、无 revision/事件、持久值不变", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-createdat"), CLIENT);
    const projectId = "tp-audit-createdat";
    const issueId = "issue-cd-1";
    await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      { issue: issuePayload(projectId, issueId, { createdAt: 10 }), expectedRevision: 1 },
      CLIENT,
    );
    const tampered = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/${issueId}`,
      { issue: issuePayload(projectId, issueId, { createdAt: 999, note: "篡改创建时间" }), expectedRevision: 2 },
      CLIENT,
    );
    expect(tampered.status).toBe(400);
    expect(tampered.body?.message).toContain("createdAt");
    // 无事件、无 revision 增长、数据库仍是原值。
    const events = await eventsOf(s, projectId);
    expect(events).toHaveLength(2);
    const detail = await s.req("GET", `/api/projects/${projectId}`);
    expect((detail.body?.project as Record<string, unknown>).revision).toBe(2);
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    const stored = (issues.body?.issues as Array<Record<string, unknown>>)[0];
    expect(stored.createdAt).toBe(10);
    expect(stored.note).toBe("专名待查"); // 后续字段也未写入（整体回滚）
  });
});

describe("跨项目 issueId 对抗（全局主键隔离）", () => {
  it("putIssue 对属于另一项目的同名疑点：404，双方数据、revision 与审计均不受污染", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-a-x1"), CLIENT);
    await s.req("POST", "/api/projects", makeProjectPayload("tp-a-x2"), CLIENT);
    const p1 = "tp-a-x1";
    const p2 = "tp-a-x2";
    const sharedId = "issue-shared";

    // p2 先创建 shared 疑点（挂在 p2 的段上）。
    const created = await s.req(
      "PUT",
      `/api/projects/${p2}/issues/${sharedId}`,
      { issue: issuePayload(p2, sharedId, { note: "p2 的疑点" }), expectedRevision: 1 },
      CLIENT,
    );
    expect(created.status).toBe(200);
    const eventsP2Before = await eventsOf(s, p2);
    expect(eventsP2Before).toHaveLength(2);

    // 对抗：以 p1 名义写入同 ID 疑点（segmentId 挂到 p1 的段，绕过段归属检查）。
    const attack = await s.req(
      "PUT",
      `/api/projects/${p1}/issues/${sharedId}`,
      { issue: issuePayload(p1, sharedId, { note: "劫持尝试" }), expectedRevision: 1 },
      CLIENT,
    );
    expect(attack.status).toBe(404);
    expect(attack.body?.message).toContain("不属于该项目");

    // p1：无疑点、revision 不变、审计只有自己的 create_project。
    const issuesP1 = await s.req("GET", `/api/projects/${p1}/issues`);
    expect(issuesP1.body?.issues).toHaveLength(0);
    const detailP1 = await s.req("GET", `/api/projects/${p1}`);
    expect((detailP1.body?.project as Record<string, unknown>).revision).toBe(1);
    expect(await eventsOf(s, p1)).toHaveLength(1);

    // p2：疑点原样（未被改成 p1 的段）、revision 不变、审计无新增（无含 p1 before 的泄漏）。
    const issuesP2 = await s.req("GET", `/api/projects/${p2}/issues`);
    const survived = (issuesP2.body?.issues as Array<Record<string, unknown>>)[0];
    expect(survived.note).toBe("p2 的疑点");
    expect(survived.segmentId).toBe(`seg-${p2}-2`);
    expect(survived.projectId).toBe(p2);
    const detailP2 = await s.req("GET", `/api/projects/${p2}`);
    expect((detailP2.body?.project as Record<string, unknown>).revision).toBe(2);
    expect(await eventsOf(s, p2)).toEqual(eventsP2Before);
  });

  it("导入项目时 issueId 与既有项目碰撞：400，整个新项目创建事务回滚", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-a-y1"), CLIENT);
    await s.req(
      "PUT",
      "/api/projects/tp-a-y1/issues/issue-clash",
      { issue: issuePayload("tp-a-y1", "issue-clash"), expectedRevision: 1 },
      CLIENT,
    );

    // 新项目载荷携带与 tp-a-y1 碰撞的 issueId → 400，且项目完全不创建（原子回滚）。
    const payload = makeProjectPayload("tp-a-y2");
    (payload.issues as unknown[]).push({
      issueId: "issue-clash",
      projectId: "tp-a-y2",
      segmentId: "seg-tp-a-y2-2",
      startMs: 3600,
      endMs: 9460,
      type: "unclear",
      severity: "blocking",
      note: "试图占用全局 ID",
      status: "open",
      createdAt: 7,
      resolvedAt: null,
    });
    const created = await s.req("POST", "/api/projects", payload, CLIENT);
    expect(created.status).toBe(400);
    expect(created.body?.message).toContain("全局唯一");
    const list = await s.req("GET", "/api/projects");
    const ids = (list.body?.projects as Array<Record<string, unknown>>).map((p) => p.projectId);
    expect(ids).not.toContain("tp-a-y2"); // 项目未创建

    // 既有项目的疑点未被改写。
    const issues = await s.req("GET", "/api/projects/tp-a-y1/issues");
    const survived = (issues.body?.issues as Array<Record<string, unknown>>)[0];
    expect(survived.projectId).toBe("tp-a-y1");
    expect(survived.segmentId).toBe("seg-tp-a-y1-2");
  });

  it("create 与 migrate 共用 insertProjectTx：同一载荷内重复 issueId → 400，项目不存在、无遗留行", async () => {
    const s = await srv();
    const projectId = "tp-a-dup";
    const payload = makeProjectPayload(projectId);
    const base = {
      issueId: "issue-dup",
      projectId,
      segmentId: `seg-${projectId}-2`,
      startMs: 3600,
      endMs: 9460,
      type: "unclear",
      severity: "blocking",
      status: "open",
      createdAt: 7,
      resolvedAt: null,
    };
    // 两条同 issueId、不同 note/createdAt 的疑点（曾触发 last-write-wins 静默覆盖）。
    (payload.issues as unknown[]).push(
      { ...base, note: "第一条" },
      { ...base, note: "第二条（重复 ID）", createdAt: 8 },
    );
    const created = await s.req("POST", "/api/projects", payload, CLIENT);
    expect(created.status).toBe(400);
    expect(created.body?.message).toContain("重复");

    // 项目不存在（API 404 + 列表无此 ID）。
    const detail = await s.req("GET", `/api/projects/${projectId}`);
    expect(detail.status).toBe(404);
    const list = await s.req("GET", "/api/projects");
    expect(
      (list.body?.projects as Array<Record<string, unknown>>).map((p) => p.projectId),
    ).not.toContain(projectId);

    // 无遗留行：直接扫描临时库，issues / segments / srt_source / audit_events 均为 0。
    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      for (const table of ["issues", "segments", "srt_source", "audit_events"]) {
        const row = raw
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
          .get(projectId) as Record<string, unknown>;
        expect(row.n, `${table} 不应有遗留行`).toBe(0);
      }
    } finally {
      raw.close();
    }
  });

  it("成功创建含疑点的项目：create_project.after.issueCount 与主表 canonical 一致", async () => {
    const s = await srv();
    const projectId = "tp-a-count";
    const payload = makeProjectPayload(projectId);
    for (const issueId of ["issue-count-1", "issue-count-2"]) {
      (payload.issues as unknown[]).push({
        issueId,
        projectId,
        segmentId: `seg-${projectId}-2`,
        startMs: 3600,
        endMs: 9460,
        type: "unclear",
        severity: "blocking",
        note: `疑点 ${issueId}`,
        status: "open",
        createdAt: 7,
        resolvedAt: null,
      });
    }
    const created = await s.req("POST", "/api/projects", payload, CLIENT);
    expect(created.status).toBe(201);

    // 审计快照 issueCount 与主表实际行数一致（不再出现 2 vs 1 的分裂）。
    const events = await eventsOf(s, projectId);
    expect(events).toHaveLength(1);
    const after = events[0].after as Record<string, unknown>;
    expect(after.issueCount).toBe(2);
    const issues = await s.req("GET", `/api/projects/${projectId}/issues`);
    expect(issues.body?.issues).toHaveLength(2);
    // 载荷内疑点在导入后即为 canonical 记录（resolvedAt 明确 null）。
    const stored = issues.body?.issues as Array<Record<string, unknown>>;
    expect(stored.map((i) => i.issueId).sort()).toEqual(["issue-count-1", "issue-count-2"]);
    for (const issue of stored) expect(issue.resolvedAt).toBeNull();
  });
});

describe("失败与无操作不产生事件（AC-063）", () => {
  it("409 冲突、400 校验拒绝、删除不存在疑点均不产生事件、不增长 revision", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-fail"), CLIENT);
    const projectId = "tp-audit-fail";

    // 409：过期 revision。
    const conflict = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-fail-1",
      { patch: { correctedText: "旧版本" }, projectId, expectedRevision: 99 },
      CLIENT,
    );
    expect(conflict.status).toBe(409);

    // 400：未知补丁字段。
    const badPatch = await s.req(
      "PATCH",
      "/api/segments/seg-tp-audit-fail-1",
      { patch: { originalText: "恶意改原始层" }, projectId, expectedRevision: 1 },
      CLIENT,
    );
    expect(badPatch.status).toBe(400);

    // 400：非法疑点载荷。
    const badIssue = await s.req(
      "PUT",
      `/api/projects/${projectId}/issues/issue-bad`,
      { issue: issuePayload(projectId, "issue-bad", { type: "不存在类型" }), expectedRevision: 1 },
      CLIENT,
    );
    expect(badIssue.status).toBe(400);

    // 幂等删除不存在的疑点：deleted=false，不产生事件、revision 不变。
    const del = await s.req("DELETE", `/api/projects/${projectId}/issues/issue-ghost`, {
      expectedRevision: 1,
    }, CLIENT);
    expect(del.status).toBe(200);
    expect(del.body?.deleted).toBe(false);

    // media 首次写入时长 → 事件；重复相同值 → 无事件、revision 不变。
    const mediaSet = await s.req(
      "PATCH",
      `/api/projects/${projectId}/media`,
      { durationMs: 12_290_090, expectedRevision: 1 },
      CLIENT,
    );
    expect(mediaSet.status).toBe(200);
    expect(mediaSet.body?.revision).toBe(2);
    const mediaNoop = await s.req(
      "PATCH",
      `/api/projects/${projectId}/media`,
      { durationMs: 12_290_090, expectedRevision: 2 },
      CLIENT,
    );
    expect(mediaNoop.status).toBe(200);
    expect(mediaNoop.body?.revision).toBe(2);

    // create_project + update_media 共两条事件，revision 为 2。
    const events = await eventsOf(s, projectId);
    expect(events).toHaveLength(2);
    expect(events[1].action).toBe("update_media");
    expect(events[1].changedFields).toEqual(["durationMs"]);
    expect((events[1].before as Record<string, unknown>).durationMs).toBeNull();
    expect((events[1].after as Record<string, unknown>).durationMs).toBe(12_290_090);
    const after = await s.req("GET", `/api/projects/${projectId}`);
    expect((after.body?.project as Record<string, unknown>).revision).toBe(2);
  });

  it("updateMedia 分阶段补丁：净 no-op 零事件；同字段两阶段 changedFields 只计一次且 after 与持久值一致", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-a-media"), CLIENT);
    const projectId = "tp-a-media"; // 初始 media.durationMs = null

    // (a) 先改后抵消：durationMs 阶段设 100，relink 阶段覆盖回 null → 净状态无变化。
    const noop = await s.req(
      "PATCH",
      `/api/projects/${projectId}/media`,
      { durationMs: 100, relink: { durationMs: null }, expectedRevision: 1 },
      CLIENT,
    );
    expect(noop.status).toBe(200);
    expect(noop.body?.revision).toBe(1); // 不 bump
    const detail1 = await s.req("GET", `/api/projects/${projectId}`);
    const media1 = (detail1.body?.project as Record<string, unknown>).media as Record<string, unknown>;
    expect(media1.durationMs).toBeNull(); // 持久值未变
    expect(await eventsOf(s, projectId)).toHaveLength(1); // 仅 create_project，无 update_media

    // (b) 同一字段经历两阶段但最终确有变化：durationMs 100 → relink 覆盖 200。
    const change = await s.req(
      "PATCH",
      `/api/projects/${projectId}/media`,
      { durationMs: 100, relink: { durationMs: 200 }, expectedRevision: 1 },
      CLIENT,
    );
    expect(change.status).toBe(200);
    expect(change.body?.revision).toBe(2);
    const events = await eventsOf(s, projectId);
    expect(events).toHaveLength(2);
    const ev = events[1];
    expect(ev.action).toBe("update_media");
    expect(ev.changedFields).toEqual(["durationMs"]); // 两阶段同字段只出现一次，绝不重复
    expect((ev.before as Record<string, unknown>).durationMs).toBeNull();
    expect((ev.after as Record<string, unknown>).durationMs).toBe(200);
    // after 与持久值一致。
    const detail2 = await s.req("GET", `/api/projects/${projectId}`);
    const media2 = (detail2.body?.project as Record<string, unknown>).media as Record<string, unknown>;
    expect(media2.durationMs).toBe(200);
  });
});

describe("审计查询 API：只读与分页（AC-062）", () => {
  it("项目不存在 → 404；非 GET 方法被拒绝", async () => {
    const s = await srv();
    const missing = await s.req("GET", "/api/projects/tp-audit-none/audit-events");
    expect(missing.status).toBe(404);
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-ro"), CLIENT);
    const post = await s.req("POST", "/api/projects/tp-audit-ro/audit-events", {});
    expect(post.status).toBe(400);
    const del = await s.req("DELETE", "/api/projects/tp-audit-ro/audit-events");
    expect(del.status).toBe(400);
    const put = await s.req("PUT", "/api/projects/tp-audit-ro/audit-events", { evil: true });
    expect(put.status).toBe(400);
  });

  it("afterId/limit 参数严格校验", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-params"), CLIENT);
    for (const qs of [
      "limit=0",
      "limit=501",
      "limit=abc",
      "limit=1.5",
      "limit=-3",
      "afterId=-1",
      "afterId=abc",
      "afterId=1.5",
    ]) {
      const res = await s.req("GET", `/api/projects/tp-audit-params/audit-events?${qs}`);
      expect(res.status).toBe(400);
    }
    const ok = await s.req("GET", "/api/projects/tp-audit-params/audit-events?limit=500&afterId=0");
    expect(ok.status).toBe(200);
  });

  it("分页遍历：升序、无重复、无遗漏；默认 limit=100", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-page"), CLIENT);
    const projectId = "tp-audit-page";
    // 生成 105 条 playback 事件（轻量高频路径）。
    let rev = 1;
    for (let i = 0; i < 105; i += 1) {
      const res = await s.req(
        "PATCH",
        `/api/projects/${projectId}/playback`,
        {
          playback: { positionMs: 1000 * (i + 1), speed: 1, autoRewindMs: 1500, loopSegmentId: null },
          expectedRevision: rev,
        },
        CLIENT,
      );
      expect(res.status).toBe(200);
      rev = res.body?.revision as number;
    }
    expect(rev).toBe(106);

    // 默认 limit=100。
    const first = await s.req("GET", `/api/projects/${projectId}/audit-events`);
    const body1 = first.body as { events: Event[]; pagination: Record<string, unknown> };
    expect(body1.events).toHaveLength(100);
    expect(body1.pagination.hasMore).toBe(true);
    expect(body1.pagination.limit).toBe(100);

    // 以 nextAfterId 续页：无重复、无遗漏、严格升序。
    const all: Event[] = [];
    let afterId = 0;
    for (;;) {
      const res = await s.req(
        "GET",
        `/api/projects/${projectId}/audit-events?afterId=${afterId}&limit=7`,
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        events: Event[];
        pagination: { afterId: number; nextAfterId: number; limit: number; hasMore: boolean };
      };
      all.push(...body.events);
      expect(body.pagination.limit).toBe(7);
      afterId = body.pagination.nextAfterId;
      if (!body.pagination.hasMore) break;
    }
    expect(all).toHaveLength(106); // create_project + 105 update_playback
    const ids = all.map((e) => e.id as number);
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    expect(new Set(ids).size).toBe(ids.length);
    // playback 事件保持轻量：before/after 为 null，摘要进 metadata。
    const playback = all.filter((e) => e.action === "update_playback");
    expect(playback).toHaveLength(105);
    expect(playback[0].before).toBeNull();
    expect(playback[0].after).toBeNull();
    expect((playback[0].metadata as Record<string, unknown>).positionMs).toBe(1000);
    // afterId 越过末尾：空页、nextAfterId 保持游标。
    const tail = await s.req(
      "GET",
      `/api/projects/${projectId}/audit-events?afterId=${ids[ids.length - 1]}`,
    );
    const tailBody = tail.body as { events: Event[]; pagination: Record<string, unknown> };
    expect(tailBody.events).toHaveLength(0);
    expect(tailBody.pagination.hasMore).toBe(false);
    expect(tailBody.pagination.nextAfterId).toBe(ids[ids.length - 1]);
  });
});

describe("服务重启后审计完整（AC-065）", () => {
  it("重启后事件保留，分页遍历结果与重启前一致", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-audit-restart"), CLIENT);
    const projectId = "tp-audit-restart";
    let rev = 1;
    const steps: Array<(r: number) => Promise<number>> = [
      async (r) =>
        ((await s.req("PATCH", "/api/segments/seg-tp-audit-restart-1", {
          patch: { correctedText: "重启前修订" },
          projectId,
          expectedRevision: r,
        }, CLIENT)).body?.revision ?? 0) as number,
      async (r) =>
        ((await s.req("PATCH", "/api/segments/seg-tp-audit-restart-1", {
          patch: { status: "confirmed" },
          projectId,
          expectedRevision: r,
        }, CLIENT)).body?.revision ?? 0) as number,
      async (r) =>
        ((await s.req("PUT", `/api/projects/${projectId}/issues/issue-rs`, {
          issue: issuePayload(projectId, "issue-rs"),
          expectedRevision: r,
        }, CLIENT)).body?.revision ?? 0) as number,
      async (r) =>
        ((await s.req("PUT", `/api/projects/${projectId}/issues/issue-rs`, {
          issue: issuePayload(projectId, "issue-rs", { status: "resolved", resolvedAt: 9 }),
          expectedRevision: r,
        }, CLIENT)).body?.revision ?? 0) as number,
    ];
    for (const step of steps) rev = await step(rev);
    expect(rev).toBe(5);

    const before = await eventsOf(s, projectId);
    expect(before.map((e) => e.action)).toEqual([
      "create_project",
      "edit_segment_text",
      "confirm_segment",
      "create_issue",
      "resolve_issue",
    ]);

    await s.restart(); // 模拟服务进程重启（同一数据库文件）

    const after = await eventsOf(s, projectId);
    expect(after).toEqual(before); // 无重复、无遗漏、内容一致
    // 类型口径复核：事件可被消费方按 AuditEventRecord 解析。
    for (const ev of after as unknown as AuditEventRecord[]) {
      expect(ev.id).toBeGreaterThan(0);
      expect(typeof ev.timestamp).toBe("number");
      expect(ev.clientId).toBe("ci-audit-device");
    }
  });
});
