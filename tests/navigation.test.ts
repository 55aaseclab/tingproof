/**
 * 导航保存护栏测试（审计 P0-2b）：
 * - 有待保存内容 → 先 flush 再放行；
 * - flush 失败 → 不放行，reason 需可解释（留在工作台提示用户重试）；
 * - 无待保存内容 → 直接放行（不调用 flush）。
 */
import { describe, expect, it, vi } from "vitest";
import { safeNavigate, type FlushableSaver } from "../src/core/navigation.js";
import { SaveCoordinator } from "../src/store/saveCoordinator.js";

function stub(
  pending: number,
  flushBehavior: "ok" | "fail" | "throw",
  stateAfter: FlushableSaver["state"],
): FlushableSaver {
  return {
    pendingCount: pending,
    flush: vi.fn(async () => {
      // 模拟真实 SaveCoordinator：内部捕获错误并把 state 置为 failed，不向外抛。
      if (flushBehavior === "throw") throw new Error("x");
    }),
    state: stateAfter,
  };
}

describe("safeNavigate", () => {
  it("有待保存且保存成功 → 放行", async () => {
    const save = stub(2, "ok", { state: "saved", at: 1 });
    const r = await safeNavigate(save);
    expect(r).toEqual({ allowed: true });
    expect(save.flush).toHaveBeenCalledTimes(1);
  });

  it("无待保存 → 直接放行，不调用 flush", async () => {
    const save = stub(0, "ok", { state: "idle" });
    const r = await safeNavigate(save);
    expect(r).toEqual({ allowed: true });
    expect(save.flush).not.toHaveBeenCalled();
  });

  it("保存失败 → 不放行并给出可解释 reason（留在工作台）", async () => {
    const save = stub(3, "fail", { state: "failed", message: "磁盘写入失败", failedCount: 3 });
    const r = await safeNavigate(save);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.failedCount).toBe(3);
      expect(r.reason).toContain("3 项未保存");
      expect(r.reason).toContain("磁盘写入失败");
    }
  });

  it("flush 本身抛错（防御路径）→ 也不放行", async () => {
    const save = stub(2, "throw", { state: "saving" });
    const r = await safeNavigate(save);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("保存过程出现异常");
  });

  it("与真实 SaveCoordinator 集成：失败后不放行，修复后放行", async () => {
    const c = new SaveCoordinator(0);
    let fail = true;
    c.enqueue("seg:1", async () => {
      if (fail) throw new Error("boom");
    });
    const first = await safeNavigate(c);
    expect(first.allowed).toBe(false);
    fail = false;
    const second = await safeNavigate(c);
    expect(second).toEqual({ allowed: true });
  });
});
