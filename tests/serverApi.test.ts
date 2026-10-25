/**
 * 服务端 API 集成测试（PRD V1.1.0 §4.4.4 / AC-052…AC-056）：
 * - 两个独立 API 客户端共享项目列表与编辑；
 * - 服务进程重启后数据与 revision 持久（SQLite 文件 + WAL，非内存）；
 * - 过期/缺失 expectedRevision → 409 且不覆盖；If-Match 等价处理；
 * - 旧 IndexedDB 项目幂等迁移；MP3 正文与文件句柄绝不上传/落库。
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
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

describe("服务端 API：双客户端共享（AC-052/AC-053）", () => {
  it("设备 A 创建与编辑，设备 B 立即可见同一列表、文本与播放位置", async () => {
    const s = await srv();
    const create = await s.req("POST", "/api/projects", makeProjectPayload("tp-share"));
    expect(create.status).toBe(201);
    expect(create.body?.created).toBe(true);

    // 设备 B 读取列表：看到同一服务端项目。
    const listB = await s.req("GET", "/api/projects");
    expect(listB.status).toBe(200);
    const projects = listB.body?.projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0].projectId).toBe("tp-share");
    expect(projects[0].revision).toBe(1);
    expect(projects[0].updatedAt).toBe(
      (create.body?.project as Record<string, unknown>).updatedAt,
    );

    // 设备 A 编辑字幕段。
    const patchA = await s.req("PATCH", "/api/segments/seg-tp-share-1", {
      patch: { correctedText: "欢迎大家来到创业课（A 已校对）", status: "editing" },
      projectId: "tp-share",
      expectedRevision: 1,
    });
    expect(patchA.status).toBe(200);
    expect(patchA.body?.revision).toBe(2); // 契约：写响应顶层 revision
    expect((patchA.body?.project as Record<string, unknown>).revision).toBe(2);
    const segment = patchA.body?.segment as Record<string, unknown>;
    expect(segment.revisionNo).toBe(2);

    // 设备 B 读取：同一文本。
    const segsB = await s.req("GET", "/api/projects/tp-share/segments");
    const segments = segsB.body?.segments as Array<Record<string, unknown>>;
    expect(segments[0].correctedText).toBe("欢迎大家来到创业课（A 已校对）");

    // 设备 B 更新播放位置；设备 A 读取同一进度。
    const playB = await s.req("PATCH", "/api/projects/tp-share/playback", {
      playback: { positionMs: 12_000, speed: 0.8, autoRewindMs: 1500, loopSegmentId: null },
      expectedRevision: 2,
    });
    expect(playB.status).toBe(200);
    const detailA = await s.req("GET", "/api/projects/tp-share");
    const project = detailA.body?.project as Record<string, unknown>;
    expect(project.revision).toBe(3);
    const playback = project.playback as Record<string, unknown>;
    expect(playback.positionMs).toBe(12_000);
    const listA = await s.req("GET", "/api/projects");
    const summary = (listA.body?.projects as Array<Record<string, unknown>>)[0];
    expect((summary.playback as Record<string, unknown>).positionMs).toBe(12_000);
    expect(summary.updatedAt).toBe(project.updatedAt);
  });
});

describe("服务端持久化：进程重启（AC-054）", () => {
  it("重启后项目、校对文本、疑点、播放位置与 revision 完整保留", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-restart"));
    await s.req("PATCH", "/api/segments/seg-tp-restart-1", {
      patch: { correctedText: "重启前最后的校对稿" },
      projectId: "tp-restart",
      expectedRevision: 1,
    });
    await s.req("PUT", "/api/projects/tp-restart/issues/issue-r1", {
      issue: {
        issueId: "issue-r1",
        projectId: "tp-restart",
        segmentId: "seg-tp-restart-2",
        startMs: 3600,
        endMs: 9460,
        type: "proper_noun",
        severity: "blocking",
        note: "专名待查",
        status: "open",
        createdAt: 1,
        resolvedAt: null,
      },
      expectedRevision: 2,
    });
    await s.req("PATCH", "/api/projects/tp-restart/playback", {
      playback: { positionMs: 68_580_000, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
      expectedRevision: 3,
    });

    expect(existsSync(s.dbPath)).toBe(true);
    await s.restart(); // 模拟服务进程重启（同一数据库文件）

    const detail = await s.req("GET", "/api/projects/tp-restart");
    expect(detail.status).toBe(200);
    const project = detail.body?.project as Record<string, unknown>;
    expect(project.revision).toBe(4);
    const playback = project.playback as Record<string, unknown>;
    expect(playback.positionMs).toBe(68_580_000);
    const segments = detail.body?.segments as Array<Record<string, unknown>>;
    expect(segments[0].correctedText).toBe("重启前最后的校对稿");
    const issues = detail.body?.issues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(1);
    const list = await s.req("GET", "/api/projects");
    expect(list.body?.projects).toHaveLength(1);
  });
});

describe("乐观并发保护（AC-055）", () => {
  it("过期 expectedRevision → 409，不覆盖另一设备的内容；缺失 revision 也 409；If-Match 等价", async () => {
    const s = await srv();
    await s.req("POST", "/api/projects", makeProjectPayload("tp-conflict"));

    // A 以 rev1 成功提交 → 服务端 rev2。
    const patchA = await s.req("PATCH", "/api/segments/seg-tp-conflict-1", {
      patch: { correctedText: "A 的版本" },
      projectId: "tp-conflict",
      expectedRevision: 1,
    });
    expect(patchA.status).toBe(200);

    // B 仍持有 rev1 → 409，服务端内容保持 A 的版本。
    const patchB = await s.req("PATCH", "/api/segments/seg-tp-conflict-1", {
      patch: { correctedText: "B 的旧版本（必须被拒绝）" },
      projectId: "tp-conflict",
      expectedRevision: 1,
    });
    expect(patchB.status).toBe(409);
    expect(patchB.body?.error).toBe("revision_conflict");
    expect(patchB.body?.currentRevision).toBe(2);
    const segs = await s.req("GET", "/api/projects/tp-conflict/segments");
    expect((segs.body?.segments as Array<Record<string, unknown>>)[0].correctedText).toBe("A 的版本");

    // 缺少 expectedRevision → 409（PRD 4.4.4 写入约定 2）。
    const noRev = await s.req("PATCH", "/api/segments/seg-tp-conflict-1", {
      patch: { correctedText: "没有版本号的写入" },
      projectId: "tp-conflict",
    });
    expect(noRev.status).toBe(409);

    // If-Match: "<rev>" 与 expectedRevision 等价。
    const ifMatch = await s.req(
      "PATCH",
      "/api/projects/tp-conflict/playback",
      { playback: { positionMs: 5_000, speed: 1, autoRewindMs: 1500, loopSegmentId: null } },
      { "If-Match": '"2"' },
    );
    expect(ifMatch.status).toBe(200);
    expect((ifMatch.body?.project as Record<string, unknown>).revision).toBe(3);
  });
});

describe("旧 IndexedDB 幂等迁移（AC-056）", () => {
  it("缺失才创建、重复不重复、服务端已有不覆盖；音频正文与句柄不落库", async () => {
    const s = await srv();
    // 模拟旧客户端载荷：混入 audioFile（序列化后的伪 Blob 字符串）与句柄字段。
    const legacy = makeProjectPayload("tp-legacy", {
      media: { audioFile: "<fake-mp3-blob>", srtHandle: "<fake-handle>", audioHandle: "<fake-handle>" },
    });

    const first = await s.req("POST", "/api/projects/tp-legacy/migrate", legacy);
    expect(first.status).toBe(201);
    expect(first.body?.created).toBe(true);

    const second = await s.req("POST", "/api/projects/tp-legacy/migrate", legacy);
    expect(second.status).toBe(200);
    expect(second.body?.created).toBe(false);
    const list = await s.req("GET", "/api/projects");
    expect(list.body?.projects).toHaveLength(1); // 幂等：无重复项目

    // 服务端已被另一设备推进；再次迁移（本地旧稿）绝不覆盖。
    await s.req("PATCH", "/api/segments/seg-tp-legacy-1", {
      patch: { correctedText: "服务端新稿（另一设备）" },
      projectId: "tp-legacy",
      expectedRevision: 1,
    });
    const third = await s.req("POST", "/api/projects/tp-legacy/migrate", legacy);
    expect(third.status).toBe(200);
    expect(third.body?.created).toBe(false);
    const segs = await s.req("GET", "/api/projects/tp-legacy/segments");
    expect((segs.body?.segments as Array<Record<string, unknown>>)[0].correctedText).toBe(
      "服务端新稿（另一设备）",
    );

    // 数据库内 media 永不含音频正文/句柄。
    const detail = await s.req("GET", "/api/projects/tp-legacy");
    const media = (detail.body?.project as Record<string, unknown>).media as Record<string, unknown>;
    expect(media).not.toHaveProperty("audioFile");
    expect(media).not.toHaveProperty("srtHandle");
    expect(media).not.toHaveProperty("audioHandle");
    expect(media.mediaKey).toBe("key-tp-legacy");
  });

  it("载荷校验：未知字段 400、非法字段 400，不静默落库", async () => {
    const s = await srv();
    const bad = await s.req("POST", "/api/projects", {
      ...makeProjectPayload("tp-bad"),
      hackerField: "x",
    });
    expect(bad.status).toBe(400);
    const list = await s.req("GET", "/api/projects");
    expect(list.body?.projects).toHaveLength(0);

    await s.req("POST", "/api/projects", makeProjectPayload("tp-valid"));
    const badPatch = await s.req("PATCH", "/api/segments/seg-tp-valid-1", {
      patch: { originalText: "恶意改原始层" },
      projectId: "tp-valid",
      expectedRevision: 1,
    });
    expect(badPatch.status).toBe(400); // originalText 不在白名单（原始层只读）
    const badPlayback = await s.req("PATCH", "/api/projects/tp-valid/playback", {
      playback: { positionMs: 1, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
      evil: true,
      expectedRevision: 1,
    });
    expect(badPlayback.status).toBe(400);
  });

  it("create/migrate 持久化 meta.playback：既有播放进度不丢失", async () => {
    const s = await srv();
    const payload = makeProjectPayload("tp-playback");
    (payload.meta as Record<string, unknown>).playback = {
      positionMs: 68_580_000,
      speed: 0.8,
      autoRewindMs: 2000,
      loopSegmentId: null,
    };
    const created = await s.req("POST", "/api/projects", payload);
    expect(created.status).toBe(201);
    const detail = await s.req("GET", "/api/projects/tp-playback");
    const playback = (detail.body?.project as Record<string, unknown>).playback as Record<string, unknown>;
    expect(playback.positionMs).toBe(68_580_000);
    expect(playback.speed).toBe(0.8);
    expect(playback.autoRewindMs).toBe(2000);

    // 迁移路径同样保留进度。
    const legacy = makeProjectPayload("tp-playback-mig");
    (legacy.meta as Record<string, unknown>).playback = { positionMs: 42_000, speed: 1, autoRewindMs: 1500, loopSegmentId: null };
    const migrated = await s.req("POST", "/api/projects/tp-playback-mig/migrate", legacy);
    expect(migrated.status).toBe(201);
    const detail2 = await s.req("GET", "/api/projects/tp-playback-mig");
    const playback2 = (detail2.body?.project as Record<string, unknown>).playback as Record<string, unknown>;
    expect(playback2.positionMs).toBe(42_000);

    // 非法 playback → 400（不能静默落库为默认值）。
    const bad = makeProjectPayload("tp-playback-bad");
    (bad.meta as Record<string, unknown>).playback = { positionMs: "many", speed: 1 };
    const rejected = await s.req("POST", "/api/projects", bad);
    expect(rejected.status).toBe(400);
  });

  it("导入/迁移时孤儿疑点被拒绝（issue.segmentId 不属于本项目 → 400，项目不创建）", async () => {
    const s = await srv();
    const payload = makeProjectPayload("tp-orphan");
    (payload.issues as unknown[]).push({
      issueId: "issue-orphan-1",
      projectId: "tp-orphan",
      segmentId: "seg-别的项目的段",
      startMs: 1000,
      endMs: 2000,
      type: "unclear",
      severity: "blocking",
      note: "越权孤儿疑点",
      status: "open",
      createdAt: 1,
      resolvedAt: null,
    });
    const created = await s.req("POST", "/api/projects", payload);
    expect(created.status).toBe(400);
    const list = await s.req("GET", "/api/projects");
    expect(list.body?.projects).toHaveLength(0); // 原子性：项目未创建

    // 迁移路径同样拒绝。
    const migrated = await s.req("POST", "/api/projects/tp-orphan/migrate", payload);
    expect(migrated.status).toBe(400);
    const list2 = await s.req("GET", "/api/projects");
    expect(list2.body?.projects).toHaveLength(0);
  });
});
