// @vitest-environment jsdom
/**
 * V1.1.4 idbRepo.confirmSegment 独立事务测试（AC-068，测试后端镜像）：
 * 真实播种 IndexedDB 后验证——单事务确认段（含草稿文本）并按稳定 issueId 顺序
 * 解决本段全部 open 疑点（同一确认时间）；既有已解决记录不变；
 * 不存在的段返回 undefined 且零副作用；已确认且无 open 疑点 → no-op。
 */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSrt } from "../src/core/srt.js";
import { resetDbForTests } from "../src/store/db.js";
import {
  confirmSegment,
  createProject,
  getProjectIssues,
  getProjectSegments,
  makeSegmentFromCue,
  upsertIssue,
} from "../src/store/repo.js";
import type { IssueRecord } from "../src/store/types.js";

const RAW_SRT =
  "1\n00:00:01,600 --> 00:00:02,940\n欢迎大家来到创业课\n\n2\n00:00:03,600 --> 00:00:09,460\n今天讲第一个问题\n";

function makeInput(projectId: string) {
  const parsed = parseSrt(RAW_SRT);
  return {
    meta: {
      projectId,
      name: "原子确认测试",
      normalizedStem: "原子确认测试",
      media: {
        audioName: "a.mp3",
        audioSize: 1,
        audioLastModified: 1,
        audioFingerprint: "fp",
        srtFileName: "a.srt",
        srtSha256: "deadbeef",
        mediaKey: "key-" + projectId,
        durationMs: null,
        srtHandle: null,
        audioHandle: null,
      },
      playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
    },
    srtSource: {
      rawContent: RAW_SRT,
      sha256: "deadbeef",
      sourceFilename: "a.srt",
      cueCount: parsed.cues.length,
    },
    segments: parsed.cues.map((c) => makeSegmentFromCue(projectId, c)),
  };
}

function issueOf(projectId: string, issueId: string, segmentId: string, overrides: Record<string, unknown> = {}): IssueRecord {
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

beforeEach(() => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
});

describe("idbRepo.confirmSegment 事务语义（AC-068）", () => {
  it("单事务确认段并解决本段全部 open 疑点：稳定顺序、同一确认时间、既有已解决不变", async () => {
    await createProject(makeInput("tp-idb-cf"));
    const segs = await getProjectSegments("tp-idb-cf");
    const target = segs[0];
    // 两条 open（乱序写入）+ 一条已解决。
    await upsertIssue(issueOf("tp-idb-cf", "issue-z", target.segmentId));
    await upsertIssue(issueOf("tp-idb-cf", "issue-a", target.segmentId));
    await upsertIssue(issueOf("tp-idb-cf", "issue-done", target.segmentId, { status: "resolved", resolvedAt: 999 }));

    const result = await confirmSegment(target.segmentId, { correctedText: "确认时草稿" });
    expect(result).toBeDefined();
    expect(result!.segment.status).toBe("confirmed");
    expect(result!.segment.correctedText).toBe("确认时草稿");
    expect(result!.segment.revisionNo).toBe(target.revisionNo + 1);
    // 稳定 issueId 顺序 + 同一确认时间。
    expect(result!.resolvedIssues.map((i) => i.issueId)).toEqual(["issue-a", "issue-z"]);
    expect(result!.resolvedIssues[0].resolvedAt).toBe(result!.resolvedIssues[1].resolvedAt);

    // 持久层复核。
    const after = await getProjectSegments("tp-idb-cf");
    expect(after[0].status).toBe("confirmed");
    const issues = await getProjectIssues("tp-idb-cf");
    const byId = new Map(issues.map((i) => [i.issueId, i]));
    expect(byId.get("issue-a")!.status).toBe("resolved");
    expect(byId.get("issue-z")!.status).toBe("resolved");
    expect(byId.get("issue-done")!.resolvedAt).toBe(999); // 既有已解决记录不变
    // 另一段不受影响。
    expect(after[1].status).toBe("unreviewed");
  });

  it("不存在的段 → undefined 且零副作用", async () => {
    await createProject(makeInput("tp-idb-miss"));
    const result = await confirmSegment("seg-not-exist");
    expect(result).toBeUndefined();
    const segs = await getProjectSegments("tp-idb-miss");
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.status === "unreviewed")).toBe(true);
  });

  it("已确认且无 open 疑点 → no-op：返回当前段、零解决、revisionNo 不变", async () => {
    await createProject(makeInput("tp-idb-noop"));
    const segs = await getProjectSegments("tp-idb-noop");
    const first = await confirmSegment(segs[0].segmentId);
    expect(first!.segment.status).toBe("confirmed");
    const again = await confirmSegment(segs[0].segmentId);
    expect(again!.segment.status).toBe("confirmed");
    expect(again!.segment.revisionNo).toBe(first!.segment.revisionNo); // 未重写
    expect(again!.resolvedIssues).toHaveLength(0);
  });
});
