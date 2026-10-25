/**
 * 选中/确认策略回归测试（审计项 3）。
 * 锁定行为：
 * - 行内确认作用于被点击的 segmentId（与播放位置无关）；
 * - 播放位于间隙/首段之前时，computePlaybackSegmentId 返回 null（选中段保持不变）；
 * - 定位带预卷（start-300ms）落在间隙 → 播放不接管选中，目标段保持选中；
 * - 确认后自动选择下一未校对段。
 */
import { describe, expect, it } from "vitest";
import {
  computePlaybackSegmentId,
  nextUnreviewedAfter,
  planConfirm,
  planLoopToggle,
  planUnconfirm,
  segmentIdForRange,
  type SegmentLike,
} from "../src/core/selection.js";

function seg(id: string, startMs: number, endMs: number, over: Partial<SegmentLike> = {}): SegmentLike {
  return {
    segmentId: id,
    startMs,
    endMs,
    status: "unreviewed",
    correctedText: `文本${id}`,
    ...over,
  };
}

const S1 = seg("s1", 1600, 2940);
const S2 = seg("s2", 3600, 9460);
const S3 = seg("s3", 10_000, 12_000);
const SORTED = [S1, S2, S3];

describe("computePlaybackSegmentId", () => {
  it("首段之前（含预卷 start-300ms）→ null（选中段不被清空，由调用方保持）", () => {
    expect(computePlaybackSegmentId(SORTED, 1300)).toBeNull();
    expect(computePlaybackSegmentId(SORTED, 0)).toBeNull();
    expect(computePlaybackSegmentId(SORTED, 1599)).toBeNull();
  });

  it("位于某段内 → 该段", () => {
    expect(computePlaybackSegmentId(SORTED, 1600)).toBe("s1");
    expect(computePlaybackSegmentId(SORTED, 2939)).toBe("s1");
    expect(computePlaybackSegmentId(SORTED, 3600)).toBe("s2");
    expect(computePlaybackSegmentId(SORTED, 11_999)).toBe("s3");
  });

  it("段间间隙 → null（播放不接管选中）", () => {
    expect(computePlaybackSegmentId(SORTED, 2940)).toBeNull();
    expect(computePlaybackSegmentId(SORTED, 3599)).toBeNull();
    expect(computePlaybackSegmentId(SORTED, 9999)).toBeNull();
  });

  it("末段之后 → null", () => {
    expect(computePlaybackSegmentId(SORTED, 12_000)).toBeNull();
    expect(computePlaybackSegmentId(SORTED, 999_999)).toBeNull();
  });

  it("空列表 → null；单段边界", () => {
    expect(computePlaybackSegmentId([], 100)).toBeNull();
    expect(computePlaybackSegmentId([S1], 1599)).toBeNull();
    expect(computePlaybackSegmentId([S1], 1600)).toBe("s1");
    expect(computePlaybackSegmentId([S1], 2940)).toBeNull();
  });
});

describe("planConfirm（行内确认与 Ctrl+Enter 共用）", () => {
  it("点击第二段的确认 → 确认第二段（即使播放位于第一段；审计项 3 回归）", () => {
    const plan = planConfirm(SORTED, "s2");
    expect(plan).toEqual({ ok: true, confirmedId: "s2", nextId: "s3" });
  });

  it("点击第一段的确认 → 确认第一段（即使预卷把播放头放在其之前）", () => {
    const plan = planConfirm(SORTED, "s1");
    expect(plan).toEqual({ ok: true, confirmedId: "s1", nextId: "s2" });
  });

  it("确认后跳过已确认段选择下一未校对段", () => {
    const sorted = [seg("a", 0, 100), seg("b", 200, 300, { status: "confirmed" }), seg("c", 400, 500)];
    expect(planConfirm(sorted, "a")).toEqual({ ok: true, confirmedId: "a", nextId: "c" });
  });

  it("最后一段的 nextId 为 null", () => {
    expect(planConfirm(SORTED, "s3")).toEqual({ ok: true, confirmedId: "s3", nextId: null });
  });

  it("空文本段阻止确认并给出可解释原因", () => {
    const sorted = [seg("e", 0, 100, { correctedText: "  " })];
    const plan = planConfirm(sorted, "e");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("文本为空");
  });

  it("不存在的 segmentId 返回失败而不是误确认相邻段", () => {
    expect(planConfirm(SORTED, "nope").ok).toBe(false);
  });
});

describe("nextUnreviewedAfter", () => {
  it("跳过已确认，找不到返回 null", () => {
    const sorted = [seg("a", 0, 100, { status: "confirmed" }), seg("b", 200, 300, { status: "confirmed" })];
    expect(nextUnreviewedAfter(sorted, "a")).toBeNull();
    const withOpen = [...sorted, seg("c", 400, 500)];
    expect(nextUnreviewedAfter(withOpen, "a")?.segmentId).toBe("c");
  });
});


describe("segmentIdForRange / planLoopToggle（审计项 3）", () => {
  it("loop region 反查真实字幕段；不匹配任何段时为 null", () => {
    expect(segmentIdForRange(SORTED, { startMs: 3600, endMs: 9460 })).toBe("s2");
    expect(segmentIdForRange(SORTED, { startMs: 1, endMs: 2 })).toBeNull();
    expect(segmentIdForRange(SORTED, null)).toBeNull();
  });

  it("行内循环：目标段不是当前选中段时必须先定位（成为当前段/范围），不自动播放", () => {
    expect(planLoopToggle("s1", "s1")).toEqual({ locateFirst: false });
    expect(planLoopToggle("s1", "s2")).toEqual({ locateFirst: true });
    expect(planLoopToggle(null, "s2")).toEqual({ locateFirst: true });
  });
});


describe("planUnconfirm（审计/PRD V1.0.4 行内确认可撤销）", () => {
  it("有未解决疑点 → questioned；无 → editing", () => {
    expect(planUnconfirm(true)).toBe("questioned");
    expect(planUnconfirm(false)).toBe("editing");
  });
});
