/**
 * 生产仓库接线测试（PRD V1.1.0）：客户端 remote 仓库（fetch + revision 缓存）
 * 直连真实服务端 API——验证 ImportScreen/App/Workbench 生产路径的完整语义：
 * 列表/创建/段编辑/播放保存/疑点增删/原始层读取/幂等创建与冲突/服务不可用/409 不覆盖。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createRemoteRepository,
  RevisionConflictError,
  ServerUnavailableError,
  type RemoteProjectRepository,
} from "../src/store/remoteRepo.js";
import { SourceImmutableError } from "../src/store/idbRepo.js";
import type { IssueRecord } from "../src/store/types.js";
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

function repoInput(projectId: string) {
  const payload = makeProjectPayload(projectId);
  return {
    meta: {
      projectId,
      name: payload.meta.name,
      normalizedStem: payload.meta.normalizedStem,
      media: payload.meta.media,
    } as Parameters<RemoteProjectRepository["createProject"]>[0]["meta"],
    srtSource: payload.srtSource,
    segments: payload.segments,
  };
}

describe("remote 仓库接线（生产事实源 = 服务端 API）", () => {
  it("创建/列表/详情在两个独立仓库实例（两台设备）间共享", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    const deviceB = createRemoteRepository(`${s.baseUrl}/api`);

    expect(await deviceA.listProjects()).toHaveLength(0);

    const meta = await deviceA.createProject(repoInput("tp-wire"));
    expect(meta.createdAt).toBeGreaterThan(0);
    expect(meta.media.mediaKey).toBe("key-tp-wire");

    const listB = await deviceB.listProjects();
    expect(listB).toHaveLength(1);
    expect(listB[0].projectId).toBe("tp-wire");

    const detailB = await deviceB.getProject("tp-wire");
    expect(detailB?.name).toBe(meta.name);
    expect(await deviceA.getProject("missing") ?? undefined).toBeUndefined();
  });

  it("段编辑、播放保存、疑点增删经 API 持久并在另一设备可读", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    const deviceB = createRemoteRepository(`${s.baseUrl}/api`);
    await deviceA.createProject(repoInput("tp-wire2"));

    const segs = await deviceA.getProjectSegments("tp-wire2");
    expect(segs).toHaveLength(2);
    const updated = await deviceA.updateSegment(segs[0].segmentId, {
      correctedText: "远端已校对",
      status: "editing",
    });
    expect(updated?.revisionNo).toBe(2);
    const segsB = await deviceB.getProjectSegments("tp-wire2");
    expect(segsB[0].correctedText).toBe("远端已校对");

    await deviceA.savePlayback("tp-wire2", {
      positionMs: 42_000,
      speed: 0.75,
      autoRewindMs: 1500,
      loopSegmentId: null,
    });
    const detailB = await deviceB.getProject("tp-wire2");
    expect(detailB?.playback.positionMs).toBe(42_000);
    expect(detailB?.playback.speed).toBe(0.75);

    const issue: IssueRecord = {
      issueId: "issue-wire-1",
      projectId: "tp-wire2",
      segmentId: segs[1].segmentId,
      startMs: segs[1].startMs,
      endMs: segs[1].endMs,
      type: "unclear",
      severity: "blocking",
      note: "",
      status: "open",
      createdAt: 5,
      resolvedAt: null,
    };
    await deviceA.upsertIssue(issue);
    expect(await deviceB.getProjectIssues("tp-wire2")).toHaveLength(1);
    await deviceB.deleteIssue(issue.issueId);
    expect(await deviceA.getProjectIssues("tp-wire2")).toHaveLength(0);

    const src = await deviceB.getSrtSource("tp-wire2");
    expect(src?.projectId).toBe("tp-wire2");
    expect(src?.cueCount).toBe(2);
  });

  it("同 id 不同原始 SRT 的重复创建 → SourceImmutableError；幂等相同内容不重置", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    await deviceA.createProject(repoInput("tp-idem"));

    // 相同内容再次创建：幂等返回既有项目。
    const again = await deviceA.createProject(repoInput("tp-idem"));
    expect(again.projectId).toBe("tp-idem");

    // 同 id 不同 SRT：原始识别层写一次防线。
    const conflicting = repoInput("tp-idem");
    conflicting.srtSource = { ...conflicting.srtSource, rawContent: "另一次导入的不同 SRT" };
    await expect(deviceA.createProject(conflicting)).rejects.toBeInstanceOf(SourceImmutableError);
  });

  it("另一设备推进 revision 后，旧 revision 写入 → RevisionConflictError（不静默覆盖）", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    const deviceB = createRemoteRepository(`${s.baseUrl}/api`);
    await deviceA.createProject(repoInput("tp-409"));
    const segs = await deviceB.getProjectSegments("tp-409");

    // 绕过仓库缓存直接用原始 API 推进 revision。
    await s.req("PATCH", `/api/segments/${segs[0].segmentId}`, {
      patch: { correctedText: "其他设备的新版本" },
      projectId: "tp-409",
      expectedRevision: 1,
    });

    await expect(
      deviceB.updateSegment(segs[0].segmentId, { correctedText: "B 的旧草稿" }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    const after = await s.req("GET", "/api/projects/tp-409/segments");
    expect((after.body?.segments as Array<Record<string, unknown>>)[0].correctedText).toBe(
      "其他设备的新版本",
    );
  });

  it("服务不可达 → ServerUnavailableError（失败队列保留由 SaveCoordinator 承担）", async () => {
    const s = await srv();
    const baseUrl = s.baseUrl;
    await s.dispose();
    server = null;
    const orphan = createRemoteRepository(baseUrl);
    await expect(orphan.listProjects()).rejects.toBeInstanceOf(ServerUnavailableError);
  });

  it("迁移 API 经仓库调用：缺失创建、重复幂等、本地载荷含句柄/Blob 也不落库", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    const payload = makeProjectPayload("tp-mig-repo", {
      media: { audioFile: "<fake-mp3>", srtHandle: "<fake-handle>" },
    });
    const r1 = await deviceA.migrateProject({
      meta: payload.meta,
      srtSource: payload.srtSource,
      segments: payload.segments,
      issues: [],
    });
    expect(r1.created).toBe(true);
    const r2 = await deviceA.migrateProject({
      meta: payload.meta,
      srtSource: payload.srtSource,
      segments: payload.segments,
      issues: [],
    });
    expect(r2.created).toBe(false);
    const detail = await s.req("GET", "/api/projects/tp-mig-repo");
    const media = (detail.body?.project as Record<string, unknown>).media as Record<string, unknown>;
    expect(media).not.toHaveProperty("audioFile");
    expect(media).not.toHaveProperty("srtHandle");
  });

  it("迁移请求在客户端发送前剥离 audioFile 与浏览器句柄", async () => {
    const s = await srv();
    const device = createRemoteRepository(`${s.baseUrl}/api`);
    const payload = makeProjectPayload("tp-mig-wire", {
      media: {
        audioFile: "<fake-mp3-body>",
        srtHandle: "<fake-srt-handle>",
        audioHandle: "<fake-audio-handle>",
      },
    });
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await device.migrateProject({
        meta: payload.meta,
        srtSource: payload.srtSource,
        segments: payload.segments,
        issues: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestBody).not.toContain("audioFile");
    expect(requestBody).not.toContain("fake-mp3-body");
    expect(requestBody).not.toContain("srtHandle");
    expect(requestBody).not.toContain("audioHandle");
  });

  it("409 后不自动重删（AC-066）：冲突删除零副作用；刷新 revision 后显式再删成功且仅一条 delete_project", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    const deviceB = createRemoteRepository(`${s.baseUrl}/api`);
    await deviceA.createProject(repoInput("tp-del-409"));
    const segs = await deviceA.getProjectSegments("tp-del-409");

    // B 经 listProjects 获得 rev1。
    await deviceB.listProjects();
    // A 把项目推进到 rev2。
    await deviceA.updateSegment(segs[0].segmentId, { correctedText: "另一设备的新版本" });

    // B 携带旧 rev1 DELETE → RevisionConflictError（409），服务端零副作用。
    await expect(deviceB.deleteProject("tp-del-409")).rejects.toBeInstanceOf(RevisionConflictError);

    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      for (const [table, expected] of [
        ["projects", 1],
        ["srt_source", 1],
        ["segments", 2],
        ["issues", 0],
      ] as const) {
        const row = raw
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
          .get("tp-del-409") as Record<string, unknown>;
        expect(row.n, `${table} 行应保留`).toBe(expected);
      }
      // revision 未被失败的删除推进（仍为 A 推进后的 2）。
      const rev = raw
        .prepare("SELECT revision FROM projects WHERE project_id = ?")
        .get("tp-del-409") as Record<string, unknown>;
      expect(rev.revision).toBe(2);
      // audit_events 中没有 delete_project。
      const del = raw
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE project_id = ? AND action = 'delete_project'")
        .get("tp-del-409") as Record<string, unknown>;
      expect(del.n).toBe(0);
    } finally {
      raw.close();
    }

    // B 刷新（listProjects 更新 revision 缓存至 2）后显式再删 → 成功。
    await deviceB.listProjects();
    await deviceB.deleteProject("tp-del-409");
    const detail = await s.req("GET", "/api/projects/tp-del-409");
    expect(detail.status).toBe(404);

    // 只产生一个 delete_project；审计合计 create + edit + delete 三条。
    const raw2 = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      const del = raw2
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE project_id = ? AND action = 'delete_project'")
        .get("tp-del-409") as Record<string, unknown>;
      expect(del.n).toBe(1);
      const all = raw2
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE project_id = ?")
        .get("tp-del-409") as Record<string, unknown>;
      expect(all.n).toBe(3);
      const delEvent = raw2
        .prepare("SELECT revision, before_json FROM audit_events WHERE project_id = ? AND action = 'delete_project'")
        .get("tp-del-409") as Record<string, unknown>;
      expect(delEvent.revision).toBe(3);
      const before = JSON.parse(delEvent.before_json as string) as Record<string, unknown>;
      expect(before.projectId).toBe("tp-del-409");
      expect(before.segmentCount).toBe(2);
    } finally {
      raw2.close();
    }
  });

  it("删除历史记录（PRD V1.1.3 / AC-066）：listProjects 提供 revision 后 DELETE 成功；业务行消失、审计保留、源文件不涉及", async () => {
    const s = await srv();
    const deviceA = createRemoteRepository(`${s.baseUrl}/api`);
    const deviceB = createRemoteRepository(`${s.baseUrl}/api`);

    // 设备 A 创建项目并产生业务数据（校对文本 + 疑点）。
    await deviceA.createProject(repoInput("tp-del-remote"));
    const segs = await deviceA.getProjectSegments("tp-del-remote");
    await deviceA.updateSegment(segs[0].segmentId, { correctedText: "删除前的校对稿" });
    const issue: IssueRecord = {
      issueId: "issue-del-1",
      projectId: "tp-del-remote",
      segmentId: segs[1].segmentId,
      startMs: segs[1].startMs,
      endMs: segs[1].endMs,
      type: "unclear",
      severity: "blocking",
      note: "删除前的疑点",
      status: "open",
      createdAt: 5,
      resolvedAt: null,
    };
    await deviceA.upsertIssue(issue);

    // 设备 B 只经 listProjects 获得 revision，即可删除（生产路径：导入页删除按钮）。
    const list = await deviceB.listProjects();
    expect(list.some((p) => p.projectId === "tp-del-remote")).toBe(true);
    await deviceB.deleteProject("tp-del-remote");

    // 项目与业务行经 API 全部消失（跨设备可见）。
    const detail = await s.req("GET", "/api/projects/tp-del-remote");
    expect(detail.status).toBe(404);
    for (const path of [
      "/api/projects/tp-del-remote/segments",
      "/api/projects/tp-del-remote/issues",
      "/api/projects/tp-del-remote/srt",
      "/api/projects/tp-del-remote/audit-events",
    ]) {
      const res = await s.req("GET", path);
      expect(res.status).toBe(404);
    }
    const listAfter = await deviceA.listProjects();
    expect(listAfter.some((p) => p.projectId === "tp-del-remote")).toBe(false);

    // 直接扫描临时 SQLite：业务行消失；delete_project 审计行按 V1.1.2 契约长期保留
    // （含删除前项目摘要快照）；删除路径不涉及任何源文件操作（服务端只操作数据库）。
    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      for (const table of ["projects", "segments", "issues", "srt_source"]) {
        const row = raw
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
          .get("tp-del-remote") as Record<string, unknown>;
        expect(row.n, `${table} 行应消失`).toBe(0);
      }
      const auditRow = raw
        .prepare(
          "SELECT revision, action, before_json FROM audit_events WHERE project_id = ? AND action = ?",
        )
        .get("tp-del-remote", "delete_project") as Record<string, unknown>;
      expect(auditRow).toBeDefined();
      expect(auditRow.revision).toBe(4); // create + edit + issue + delete
      const before = JSON.parse(auditRow.before_json as string) as Record<string, unknown>;
      expect(before.projectId).toBe("tp-del-remote");
      expect(before.segmentCount).toBe(2);
      expect(before.issueCount).toBe(1);
      expect((before.media as Record<string, unknown>).audioName).toBe("tp-del-remote.mp3");
      // 其余审计行（create/edit/create_issue）同样保留。
      const all = raw
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE project_id = ?")
        .get("tp-del-remote") as Record<string, unknown>;
      expect(all.n).toBe(4);
    } finally {
      raw.close();
    }
  });
});
