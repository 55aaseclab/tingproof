/**
 * 段内播放模型纯函数测试（PRD docs/听校_PRD_V1.0.0.md V1.0.2 §3.2.5 / AC-042 / AC-043）。
 */
import { describe, expect, it } from "vitest";
import {
  clampSkipToScope,
  END_TOLERANCE_MS,
  normalizeRange,
  resolvePlayTarget,
  sameRange,
  tickAction,
  type PlaybackRange,
} from "../src/core/segmentPlayback.js";

const A: PlaybackRange = { startMs: 0, endMs: 5000 };
const B: PlaybackRange = { startMs: 10_000, endMs: 15_000 };

describe("normalizeRange", () => {
  it("合法负起点钳到 0 并取整", () => {
    expect(normalizeRange(-100, 5000.6)).toEqual({ startMs: 0, endMs: 5001 });
    expect(normalizeRange(0, 5000)).toEqual({ startMs: 0, endMs: 5000 });
  });
  it("倒置范围拒绝（不静默交换；start_ms >= end_ms 属无效字幕段，PRD 3.2.7）", () => {
    expect(normalizeRange(5000, 1000)).toBeNull();
  });
  it("相等/非法范围返回 null", () => {
    expect(normalizeRange(1000, 1000)).toBeNull();
    expect(normalizeRange(Number.NaN, 5000)).toBeNull();
  });
  it("全负范围在 clamp 后复验为 null，而不是返回 {0,0}（审计项 6）", () => {
    expect(normalizeRange(-5000, -1000)).toBeNull();
    expect(normalizeRange(-3000, -3000)).toBeNull();
    expect(normalizeRange(-100, 5000)).toEqual({ startMs: 0, endMs: 5000 });
  });
});

describe("tickAction（段尾决策）", () => {
  it("普通模式：到/越过 endMs → 暂停（位置由调用方稳定在段尾）", () => {
    expect(tickAction(5000, A, null)).toEqual({ kind: "pauseAtEnd" });
    expect(tickAction(5400, A, null)).toEqual({ kind: "pauseAtEnd" });
  });
  it("循环 region 与当前段一致：到段尾 → 回段首继续（唯一回绕模式）", () => {
    expect(tickAction(5050, A, A)).toEqual({ kind: "restart" });
  });
  it("循环 region 不对应当前段：不回绕，按普通暂停处理", () => {
    expect(tickAction(5050, A, B)).toEqual({ kind: "pauseAtEnd" });
  });
  it("段内继续播放", () => {
    expect(tickAction(2500, A, null)).toEqual({ kind: "continue" });
  });
  it("无范围时继续（由调用方兜底）", () => {
    expect(tickAction(9999, null, null)).toEqual({ kind: "continue" });
  });
});

describe("resolvePlayTarget（恢复起点）", () => {
  it("同段段内暂停恢复：自动回退且不早于段首", () => {
    expect(
      resolvePlayTarget({
        currentTimeMs: 2500, pausedAtMs: 2500, pausedAtInRange: true,
        seekedSincePause: false, autoRewindMs: 1500, range: A,
      }),
    ).toBe(1000);
    expect(
      resolvePlayTarget({
        currentTimeMs: 1000, pausedAtMs: 1000, pausedAtInRange: true,
        seekedSincePause: false, autoRewindMs: 1500, range: A,
      }),
    ).toBe(0);
  });

  it("已到段尾（含容差）再次播放：从段首", () => {
    expect(
      resolvePlayTarget({
        currentTimeMs: A.endMs, pausedAtMs: A.endMs, pausedAtInRange: true,
        seekedSincePause: false, autoRewindMs: 1500, range: A,
      }),
    ).toBe(0);
    expect(
      resolvePlayTarget({
        currentTimeMs: A.endMs - 10, pausedAtMs: A.endMs - 10, pausedAtInRange: true,
        seekedSincePause: false, autoRewindMs: 1500, range: A,
      }),
    ).toBe(0);
  });

  it("换段（暂停点不属于目标段）：播放头已在目标段段首 → 原地播放；在段外 → 从段首", () => {
    // 点击 B 行定位后（播放头 = B.startMs）再按播放：原地播放。
    expect(
      resolvePlayTarget({
        currentTimeMs: B.startMs, pausedAtMs: 2500, pausedAtInRange: false,
        seekedSincePause: false, autoRewindMs: 1500, range: B,
      }),
    ).toBeNull();
    // 直接对 B 段按播放（播放头还在 A 段内）：从 B 段首开始。
    expect(
      resolvePlayTarget({
        currentTimeMs: 2500, pausedAtMs: 2500, pausedAtInRange: false,
        seekedSincePause: false, autoRewindMs: 1500, range: B,
      }),
    ).toBe(B.startMs);
  });

  it("暂停期间 seek 过：段内原地播放，段外/段尾从段首", () => {
    expect(
      resolvePlayTarget({
        currentTimeMs: 3000, pausedAtMs: 3000, pausedAtInRange: true,
        seekedSincePause: true, autoRewindMs: 1500, range: A,
      }),
    ).toBeNull();
    expect(
      resolvePlayTarget({
        currentTimeMs: 6000, pausedAtMs: 6000, pausedAtInRange: false,
        seekedSincePause: true, autoRewindMs: 1500, range: A,
      }),
    ).toBe(0);
  });

  it("无范围上下文：保持旧自动回退语义", () => {
    expect(
      resolvePlayTarget({
        currentTimeMs: 5000, pausedAtMs: 5000, pausedAtInRange: false,
        seekedSincePause: false, autoRewindMs: 1500, range: null,
      }),
    ).toBe(3500);
  });
});

describe("clampSkipToScope（F7/F9 钳制）", () => {
  it("前后跳钳制在当前段内", () => {
    expect(clampSkipToScope(1000, -2000, A)).toBe(0);
    expect(clampSkipToScope(4500, 2000, A)).toBe(5000);
    expect(clampSkipToScope(2500, 2000, A)).toBe(4500);
    expect(clampSkipToScope(2500, -2000, A)).toBe(500);
  });
  it("无范围时仅钳非负", () => {
    expect(clampSkipToScope(1000, -5000, null)).toBe(0);
  });
});

describe("sameRange / END_TOLERANCE_MS", () => {
  it("同段判定与容差 ≤ 100ms（AC-043）", () => {
    expect(sameRange(A, { startMs: 0, endMs: 5000 })).toBe(true);
    expect(sameRange(A, B)).toBe(false);
    expect(sameRange(null, A)).toBe(false);
    expect(END_TOLERANCE_MS).toBeLessThanOrEqual(100);
  });
});
