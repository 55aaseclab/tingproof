/**
 * 持久化关键逻辑测试：fake-indexeddb 模拟真实 IndexedDB。
 * 覆盖：项目创建、刷新后恢复（重开数据库连接）、同名碰撞、原始层不可覆盖。
 */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSrt } from "../src/core/srt.js";
import { resetDbForTests } from "../src/store/db.js";
import {
  createProject,
  getProject,
  getProjectIssues,
  getProjectSegments,
  getSrtSource,
  listProjects,
  savePlayback,
  SourceImmutableError,
  updateMediaDuration,
  updateSegment,
  upsertIssue,
  makeSegmentFromCue,
} from "../src/store/repo.js";
import type { IssueRecord, ProjectMeta } from "../src/store/types.js";

const RAW_SRT = "1\n00:00:01,600 --> 00:00:02,940\n欢迎大家来到创业课\n\n2\n00:00:03,600 --> 00:00:09,460\n今天讲第一个问题\n";

const AUDIO_FP = "afp1|98320717|aaa|bbb";

function makeInput(projectId: string, srtRaw = RAW_SRT) {
  const parsed = parseSrt(srtRaw);
  return {
    meta: {
      projectId,
      name: "青创 一 1 7月25日 上午9点10分",
      normalizedStem: "青创 一 1 7月25日 上午9点10分",
      media: {
        audioName: "青创 一   1   7月25日 上午9点10分.mp3",
        audioSize: 98_320_717,
        audioLastModified: 1_754_400_000_000,
        audioFingerprint: AUDIO_FP,
        srtFileName: "青创 一 1 7月25日 上午9点10分.srt",
        srtSha256: "deadbeef",
        mediaKey: "key-" + projectId,
        durationMs: null,
        srtHandle: null,
        audioHandle: null,
      },
      playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
    },
    srtSource: {
      rawContent: srtRaw,
      sha256: "deadbeef",
      sourceFilename: "青创 一 1 7月25日 上午9点10分.srt",
      cueCount: parsed.cues.length,
    },
    segments: parsed.cues.map((c) => makeSegmentFromCue(projectId, c)),
  };
}

beforeEach(() => {
  // 完全重建 IndexedDB 工厂，保证用例之间数据隔离（模拟“全新安装”）。
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
});

describe("createProject + 重开后恢复", () => {
  it("写入后重开连接仍能读回项目、片段与原始层", async () => {
    const meta = await createProject(makeInput("tp-test1"));
    expect(meta.projectId).toBe("tp-test1");

    // 模拟刷新/重启：丢弃连接缓存后重读。
    resetDbForTests();
    const restored = await getProject("tp-test1");
    expect(restored).toBeDefined();
    expect(restored?.media.srtFileName).toBe("青创 一 1 7月25日 上午9点10分.srt");
    expect(restored?.media.audioHandle).toBeNull();

    const segs = await getProjectSegments("tp-test1");
    expect(segs.map((s) => s.correctedText)).toEqual(["欢迎大家来到创业课", "今天讲第一个问题"]);
    expect(segs[0].originalText).toBe("欢迎大家来到创业课");
    expect(segs[0].status).toBe("unreviewed");
    expect(segs[0].cueNo).toBe(1);

    const src = await getSrtSource("tp-test1");
    expect(src?.rawContent).toBe(RAW_SRT);
    expect(src?.cueCount).toBe(2);
  });

  it("编辑校对文本后重开连接，恢复的是编辑后的内容", async () => {
    await createProject(makeInput("tp-test2"));
    const segs = await getProjectSegments("tp-test2");
    const first = segs[0];

    const updated = await updateSegment(first.segmentId, {
      correctedText: "欢迎大家来到创业课（已校对）",
      status: "confirmed",
    });
    expect(updated?.status).toBe("confirmed");
    expect(updated?.revisionNo).toBe(2);

    resetDbForTests();
    const segs2 = await getProjectSegments("tp-test2");
    expect(segs2[0].correctedText).toBe("欢迎大家来到创业课（已校对）");
    expect(segs2[0].status).toBe("confirmed");
    expect(segs2[0].originalText).toBe("欢迎大家来到创业课");
  });

  it("播放位置与设置持久化，重开后可恢复", async () => {
    await createProject(makeInput("tp-test3"));
    await savePlayback("tp-test3", {
      positionMs: 1_200_878,
      speed: 0.8,
      autoRewindMs: 1500,
      loopSegmentId: null,
    });
    resetDbForTests();
    const meta = await getProject("tp-test3");
    expect(meta?.playback.positionMs).toBe(1_200_878);
    expect(meta?.playback.speed).toBe(0.8);
  });

  it("listProjects 按更新时间倒序", async () => {
    await createProject(makeInput("tp-a"));
    await new Promise((r) => setTimeout(r, 15));
    await createProject(makeInput("tp-b"));
    const list = await listProjects();
    expect(list.map((p) => p.projectId)).toEqual(["tp-b", "tp-a"]);
  });

  it("音频时长经 updateMediaDuration 写回，重开连接后仍在（审计项 7）", async () => {
    await createProject(makeInput("tp-duration"));
    await updateMediaDuration("tp-duration", 12_290_090);
    resetDbForTests();
    const meta = await getProject("tp-duration");
    expect(meta?.media.durationMs).toBe(12_290_090);
    // 重复写相同值不更新 updatedAt。
    const before = (await getProject("tp-duration"))?.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateMediaDuration("tp-duration", 12_290_090);
    const after = (await getProject("tp-duration"))?.updatedAt;
    expect(after).toBe(before);
  });

  it("重复导入（同 ID + 同原文）幂等：不重置校对稿/状态/疑点/版本（审计项 6）", async () => {
    await createProject(makeInput("tp-idem"));
    const segs = await getProjectSegments("tp-idem");
    // 用户已校对并确认第一段，还建了疑点。
    await updateSegment(segs[0].segmentId, {
      correctedText: "欢迎大家来到创业课（已校对）",
      status: "confirmed",
    });
    const issue: IssueRecord = {
      issueId: "issue-idem-1",
      projectId: "tp-idem",
      segmentId: segs[1].segmentId,
      startMs: segs[1].startMs,
      endMs: segs[1].endMs,
      type: "proper_noun",
      severity: "blocking",
      note: "专名待查",
      status: "open",
      createdAt: 1,
      resolvedAt: null,
    };
    await upsertIssue(issue);

    const beforeSegs = await getProjectSegments("tp-idem");
    const beforeMeta = await getProject("tp-idem");
    const beforeIssues = await getProjectIssues("tp-idem");

    // 模拟用户重新选择同一对文件再次导入。
    const again = await createProject(makeInput("tp-idem"));
    expect(again.updatedAt).toBe(beforeMeta?.updatedAt);
    expect(again.createdAt).toBe(beforeMeta?.createdAt);

    const afterSegs = await getProjectSegments("tp-idem");
    expect(afterSegs).toEqual(beforeSegs);
    expect(afterSegs[0].correctedText).toBe("欢迎大家来到创业课（已校对）");
    expect(afterSegs[0].status).toBe("confirmed");
    expect(afterSegs[0].revisionNo).toBe(2);
    expect(await getProjectIssues("tp-idem")).toEqual(beforeIssues);
  });

  it("repo 不再导出 upsertSegment（原始层唯一写入路径是 createProject；审计项 6）", async () => {
    const repoModule = await import("../src/store/repo.js");
    expect((repoModule as Record<string, unknown>)["upsertSegment"]).toBeUndefined();
  });
});

describe("原始识别层不可覆盖", () => {
  it("updateSegment 显式传入 originalText 也不会改写原始层", async () => {
    await createProject(makeInput("tp-guard1"));
    const segs = await getProjectSegments("tp-guard1");
    const patch = {
      originalText: "恶意覆盖",
      correctedText: "正常校对",
    } as Record<string, unknown>;
    const updated = await updateSegment(segs[0].segmentId, patch);
    expect(updated?.correctedText).toBe("正常校对");
    expect(updated?.originalText).toBe("欢迎大家来到创业课");
  });

  it("重复 updateSegment 也不改写 originalText，且 revisionNo 递增", async () => {
    await createProject(makeInput("tp-guard2b"));
    const segs = await getProjectSegments("tp-guard2b");
    const first = await updateSegment(segs[0].segmentId, {
      originalText: "再次尝试覆盖",
      correctedText: "第一轮校对",
    } as Record<string, unknown>);
    const second = await updateSegment(segs[0].segmentId, {
      originalText: "又试一次",
      correctedText: "第二轮校对",
    } as Record<string, unknown>);
    expect(first?.originalText).toBe("欢迎大家来到创业课");
    expect(second?.originalText).toBe("欢迎大家来到创业课");
    expect(second?.revisionNo).toBe((first?.revisionNo ?? 1) + 1);
  });

  it("同 ID 不同原始内容 → SourceImmutableError，原始层保持不变", async () => {
    await createProject(makeInput("tp-guard3"));
    const src = await getSrtSource("tp-guard3");
    expect(src).toBeDefined();
    await expect(
      createProject(makeInput("tp-guard3", "另一次导入的不同 SRT")),
    ).rejects.toBeInstanceOf(SourceImmutableError);
    const after = await getSrtSource("tp-guard3");
    expect(after?.rawContent).toBe(RAW_SRT);
    // 被拒绝的导入也不应污染片段层。
    const segs = await getProjectSegments("tp-guard3");
    expect(segs).toHaveLength(2);
    expect(segs[0].originalText).toBe("欢迎大家来到创业课");
  });

  it("同 ID 相同原始内容 → 允许重复创建（幂等，不抛错）", async () => {
    await createProject(makeInput("tp-guard4"));
    const again = await createProject(makeInput("tp-guard4"));
    expect(again.projectId).toBe("tp-guard4");
  });
});

describe("疑点持久化", () => {
  it("创建/解决疑点后重开连接保持一致", async () => {
    await createProject(makeInput("tp-issue1"));
    const segs = await getProjectSegments("tp-issue1");
    const issue: IssueRecord = {
      issueId: "issue-1",
      projectId: "tp-issue1",
      segmentId: segs[0].segmentId,
      startMs: segs[0].startMs,
      endMs: segs[0].endMs,
      type: "proper_noun",
      severity: "blocking",
      note: "这里的人名不确定",
      status: "open",
      createdAt: Date.now(),
      resolvedAt: null,
    };
    await upsertIssue(issue);
    resetDbForTests();
    const loaded = await getProjectIssues("tp-issue1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].type).toBe("proper_noun");
    expect(loaded[0].status).toBe("open");

    await upsertIssue({ ...issue, status: "resolved", resolvedAt: 123 });
    resetDbForTests();
    const after = await getProjectIssues("tp-issue1");
    expect(after[0].status).toBe("resolved");
  });
});

describe("同名碰撞", () => {
  it("规范化名相同、身份不同 → 两个独立项目互不影响", async () => {
    const a = await createProject(makeInput("tp-collide-1"));
    const inputB = makeInput("tp-collide-2", RAW_SRT.replace("创业课", "创业课（第二版本）"));
    inputB.meta.media = {
      ...inputB.meta.media,
      audioSize: 123_456_789, // 不同文件 → 不同 mediaKey
    };
    const b = await createProject(inputB);
    expect(a.normalizedStem).toBe(b.normalizedStem);
    const list = await listProjects();
    expect(list.filter((p) => p.normalizedStem === a.normalizedStem)).toHaveLength(2);
    const segsB = await getProjectSegments("tp-collide-2");
    expect(segsB[0].originalText).toContain("第二版本");
    const segsA = await getProjectSegments("tp-collide-1");
    expect(segsA[0].originalText).not.toContain("第二版本");
  });
});

describe("项目元数据类型", () => {
  it("ProjectMeta 必填字段齐全（防止未来字段漂移）", async () => {
    const meta: ProjectMeta = (await createProject(makeInput("tp-shape"))) as ProjectMeta;
    expect(meta.createdAt).toBeGreaterThan(0);
    expect(meta.updatedAt).toBeGreaterThan(0);
    expect(meta.media.mediaKey).toBe("key-tp-shape");
  });
});
