/**
 * 生产仓库接线测试（PRD V1.1.0）：客户端 remote 仓库（fetch + revision 缓存）
 * 直连真实服务端 API——验证 ImportScreen/App/Workbench 生产路径的完整语义：
 * 列表/创建/段编辑/播放保存/疑点增删/原始层读取/幂等创建与冲突/服务不可用/409 不覆盖。
 */
import { afterEach, describe, expect, it } from "vitest";
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
});
