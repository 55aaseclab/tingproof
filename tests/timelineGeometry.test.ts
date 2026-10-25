/**
 * 时间轴静态层几何键（第 11 轮审计 2）：O(1) 键覆盖时长/宽高/DPR，任一变化即失效。
 */
import { describe, expect, it } from "vitest";
import { timelineGeometryKey } from "../src/ui/Timeline.js";

describe("timelineGeometryKey", () => {
  it("相同输入 → 相同键；任一维度变化 → 不同键", () => {
    const base = timelineGeometryKey(12_290_090, 800, 64, 1);
    expect(timelineGeometryKey(12_290_090, 800, 64, 1)).toBe(base);
    expect(timelineGeometryKey(12_300_000, 800, 64, 1)).not.toBe(base); // 时长
    expect(timelineGeometryKey(12_290_090, 640, 64, 1)).not.toBe(base); // 宽
    expect(timelineGeometryKey(12_290_090, 800, 128, 1)).not.toBe(base); // 高
    expect(timelineGeometryKey(12_290_090, 800, 64, 2)).not.toBe(base); // DPR
  });
});
