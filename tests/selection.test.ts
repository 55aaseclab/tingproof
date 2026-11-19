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
  reuseTimelineData,
  sameSortedOrderShape,
  sameTimelineData,
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


describe("排序/时间轴精确比较（V1.0.5 AC-048 + 第 10 轮审计 2/3）", () => {
  it("sameSortedOrderShape：正文/状态变化不影响；时间变化、ID 替换、数量变化、重叠同时间段都判不同", () => {
    const base: SegmentLike[] = [seg("a", 0, 100), seg("b", 200, 300)];
    const byId = (list: SegmentLike[]) => new Map(list.map((x) => [x.segmentId, x]));
    // 仅文本/状态变化 → 形状相同（跳过重排）
    expect(
      sameSortedOrderShape(base, byId([seg("a", 0, 100, { correctedText: "改了", status: "confirmed" }), seg("b", 200, 300)])),
    ).toBe(true);
    // 同和边界变化：0..100 改成 10..90（start+end 不变）→ 必须判不同
    expect(sameSortedOrderShape(base, byId([seg("a", 10, 90), seg("b", 200, 300)]))).toBe(false);
    // ID 替换（时间段完全相同）→ 必须判不同
    expect(sameSortedOrderShape(base, byId([seg("x", 0, 100), seg("b", 200, 300)]))).toBe(false);
    // 重叠同时间段、不同 ID → 必须判不同
    expect(sameSortedOrderShape(base, byId([seg("a", 0, 100), seg("z", 0, 100)]))).toBe(false);
    // 数量变化 → false
    expect(sameSortedOrderShape(base, byId([...base, seg("c", 400, 500)]))).toBe(false);
  });

  it("sameSortedOrderShape：不假设输入顺序与缓存排序顺序相同（按 ID 查表比较）", () => {
    const cachedSorted: SegmentLike[] = [seg("a", 0, 100), seg("b", 200, 300)];
    const incomingUnsorted = [seg("b", 200, 300, { correctedText: "编辑过" }), seg("a", 0, 100)];
    expect(sameSortedOrderShape(cachedSorted, new Map(incomingUnsorted.map((x) => [x.segmentId, x])))).toBe(true);
    const timeChanged = [seg("b", 200, 300), seg("a", 10, 90)];
    expect(sameSortedOrderShape(cachedSorted, new Map(timeChanged.map((x) => [x.segmentId, x])))).toBe(false);
  });

  it("sameTimelineData：正文变化不失效；id/start/end/status/数量变化必失效（审计项 3）", () => {
    const data = [{ segmentId: "a", startMs: 0, endMs: 100, status: "editing" }];
    expect(sameTimelineData(data, [{ segmentId: "a", startMs: 0, endMs: 100, status: "editing" }])).toBe(true);
    expect(sameTimelineData(data, [{ segmentId: "a", startMs: 0, endMs: 100, status: "confirmed" }])).toBe(false);
    expect(sameTimelineData(data, [{ segmentId: "a", startMs: 10, endMs: 90, status: "editing" }])).toBe(false);
    expect(sameTimelineData(data, [{ segmentId: "z", startMs: 0, endMs: 100, status: "editing" }])).toBe(false);
    expect(sameTimelineData(data, [])).toBe(false);
  });
});


describe("reuseTimelineData（第 11 轮审计 3）", () => {
  const records = [
    { segmentId: "a", startMs: 0, endMs: 100, status: "editing", correctedText: "v1" },
    { segmentId: "b", startMs: 200, endMs: 300, status: "unreviewed", correctedText: "v1" },
  ];

  it("纯正文变化：reused=true 且严格返回同一引用（不每键新建 1,676 个对象）", () => {
    const { reused, value } = reuseTimelineData(null, records);
    expect(reused).toBe(false);
    const again = reuseTimelineData(value, [
      { segmentId: "a", startMs: 0, endMs: 100, status: "editing", correctedText: "v2" },
      { segmentId: "b", startMs: 200, endMs: 300, status: "unreviewed", correctedText: "v2" },
    ]);
    expect(again.reused).toBe(true);
    expect(again.value).toBe(value); // 严格同一引用 → React.memo 跳过
  });

  it("状态/时间变化：返回新引用（静态层必须重绘）", () => {
    const { value } = reuseTimelineData(null, records);
    const statusChanged = reuseTimelineData(value, [
      { segmentId: "a", startMs: 0, endMs: 100, status: "confirmed" },
      { segmentId: "b", startMs: 200, endMs: 300, status: "unreviewed" },
    ]);
    expect(statusChanged.reused).toBe(false);
    expect(statusChanged.value).not.toBe(value);
    const timeChanged = reuseTimelineData(value, [
      { segmentId: "a", startMs: 10, endMs: 90, status: "editing" },
      { segmentId: "b", startMs: 200, endMs: 300, status: "unreviewed" },
    ]);
    expect(timeChanged.reused).toBe(false);
    expect(timeChanged.value[0]).toEqual({ segmentId: "a", startMs: 10, endMs: 90, status: "editing" });
  });

  it("缓存为空（首帧）：投影新数组", () => {
    const first = reuseTimelineData(null, records);
    expect(first.reused).toBe(false);
    expect(first.value).toHaveLength(2);
  });
});


describe("planConfirm 草稿覆盖（第 13 轮审计 P0）", () => {
  it("原非空段被草稿清空 → 确认被阻止（不得保存 confirmed + 空文本）", () => {
    const sorted = [seg("a", 0, 100, { correctedText: "有内容" })];
    const plan = planConfirm(sorted, "a", "");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("文本为空");
  });

  it("原空段输入非空草稿 → 确认放行（不误阻止）", () => {
    const sorted = [seg("e", 0, 100, { correctedText: "" })];
    const plan = planConfirm(sorted, "e", "新内容");
    expect(plan).toEqual({ ok: true, confirmedId: "e", nextId: null });
  });

  it("无草稿时行为不变（correctedText 仍是判定依据）", () => {
    expect(planConfirm([seg("a", 0, 100, { correctedText: "" })], "a").ok).toBe(false);
    expect(planConfirm([seg("a", 0, 100, { correctedText: "ok" })], "a").ok).toBe(true);
  });
});
