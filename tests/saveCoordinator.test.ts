/**
 * SaveCoordinator 回归测试（审计项 5）：
 * - 写入失败不静默丢失：失败操作保留队列，状态 failed，可重试；
 * - 成功后状态 saved；空 flush 不覆盖 failed 状态；
 * - 同 label 去重（后写覆盖前写）。
 */
import { describe, expect, it, vi } from "vitest";
import { safeNavigate } from "../src/core/navigation.js";
import { SaveCoordinator } from "../src/store/saveCoordinator.js";

describe("SaveCoordinator", () => {
  it("成功路径：enqueue → schedule → flush 后 saved", async () => {
    vi.useFakeTimers();
    const c = new SaveCoordinator(5);
    const run = vi.fn().mockResolvedValue(undefined);
    c.enqueue("a", run);
    c.schedule();
    expect(c.state.state).toBe("saving");
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(c.state.state).toBe("saved");
    expect(c.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("失败路径：状态 failed、操作保留队列、retry 成功后清空（不静默丢失）", async () => {
    const c = new SaveCoordinator(0);
    let fail = true;
    const okOp = vi.fn().mockResolvedValue(undefined);
    c.enqueue("op1", async () => {
      if (fail) throw new Error("磁盘写入失败");
      fail = false;
    });
    c.enqueue("op2", okOp);
    await c.flush();
    expect(c.state).toMatchObject({ state: "failed", failedCount: 2 });
    expect(c.state.state === "failed" && c.state.message).toContain("磁盘写入失败");
    // 失败后不静默：队列仍保留两个操作。
    expect(c.pendingCount).toBe(2);
    // 重试成功。
    fail = false;
    await c.flush();
    expect(c.state.state).toBe("saved");
    expect(c.pendingCount).toBe(0);
    expect(okOp).toHaveBeenCalledTimes(1);
  });

  it("flush 中途失败时，后续操作也保留（顺序执行，不丢 op2）", async () => {
    const c = new SaveCoordinator(0);
    const order: string[] = [];
    c.enqueue("op1", async () => {
      order.push("op1");
      throw new Error("boom");
    });
    c.enqueue("op2", async () => {
      order.push("op2");
    });
    await c.flush();
    expect(order).toEqual(["op1"]); // op1 失败即停止，op2 未执行
    expect(c.pendingCount).toBe(2);
  });

  it("同 label 去重：后入队覆盖先入队", async () => {
    vi.useFakeTimers();
    const c = new SaveCoordinator(5);
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    c.enqueue("seg:1", first);
    c.enqueue("seg:1", second);
    c.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("已处于 saving 时 schedule 不重复发布相同状态（V1.0.5 AC-048）", async () => {
    const c = new SaveCoordinator(0);
    const seen: string[] = [];
    c.subscribe((s) => seen.push(s.state));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    c.enqueue("a", async () => { await gate; }); // flush 保持 saving
    const flushPromise = c.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.state.state).toBe("saving");
    // 逐键输入：多次 schedule 都不重复发布 saving。
    c.enqueue("b", async () => undefined);
    c.schedule();
    c.schedule();
    c.schedule();
    const savingCount = seen.filter((x) => x === "saving").length;
    expect(savingCount).toBe(1); // 只通知一次
    release();
    await flushPromise;
    expect(c.state.state).toBe("saved");
  });

  it("完整防抖生命周期：saving 仅发布一次，saved 一次（schedule→500ms→flush→mid-flush join）", async () => {
    vi.useFakeTimers();
    const c = new SaveCoordinator(500);
    const seen: string[] = [];
    c.subscribe((s) => seen.push(s.state));
    let release1: () => void = () => undefined;
    const gate1 = new Promise<void>((r) => { release1 = r; });
    c.enqueue("op1", async () => { await gate1; });
    c.schedule(); // idle → saving（第 1 次）
    await vi.advanceTimersByTimeAsync(500); // 防抖到点 → flush 开始（已 saving，不重复发布）
    expect(c.state.state).toBe("saving");
    const savingBefore = seen.filter((x) => x === "saving").length;
    expect(savingBefore).toBe(1);
    // flush 进行中继续入队 + schedule + join flush：仍不重复发布 saving。
    c.enqueue("op2", async () => undefined);
    c.schedule();
    const joined = c.flush();
    release1(); // 先释放再等待 join
    await joined;
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();
    const savingAfter = seen.filter((x) => x === "saving").length;
    expect(savingAfter).toBe(1); // 全生命周期只发布一次 saving
    expect(seen[seen.length - 1]).toBe("saved");
    expect(c.state.state).toBe("saved");
    vi.useRealTimers();
  });

  it("空队列 flush：saving → saved；但不会把 failed 洗成 saved", async () => {
    const c = new SaveCoordinator(0);
    c.enqueue("x", async () => {
      throw new Error("e");
    });
    await c.flush();
    expect(c.state.state).toBe("failed");
    await c.flush();
    expect(c.state.state).toBe("failed");
  });

  it("执行中同 label 入队不得丢写（审计 P0-2）：op1 完成后 op2 仍执行且队列清空", async () => {
    const c = new SaveCoordinator(0);
    const calls: string[] = [];
    let releaseOp1: () => void = () => undefined;
    const op1Done = new Promise<void>((resolve) => {
      releaseOp1 = resolve;
    });
    // 先入队 op1（deferred），flush 启动后 op1 挂起。
    c.enqueue("k", async () => {
      calls.push("op1");
      await op1Done;
    });
    const flushPromise = c.flush();
    // 等待微任务让 flush 快照并进入 op1。
    await Promise.resolve();
    await Promise.resolve();
    // op1 执行中，同 label 的新 op 入队（模拟用户继续输入）。
    c.enqueue("k", async () => {
      calls.push("op2");
    });
    releaseOp1();
    await flushPromise;
    expect(calls).toEqual(["op1", "op2"]); // 两次写都执行
    expect(c.pendingCount).toBe(0); // 队列最终清空
    expect(c.state.state).toBe("saved");
  });

  it("并发 flush join（审计 P0-1）：第二个 flush 等待进行中的队列真正完成，release 前不 resolve", async () => {
    const c = new SaveCoordinator(0);
    const calls: string[] = [];
    let releaseOp1: () => void = () => undefined;
    const op1Done = new Promise<void>((resolve) => {
      releaseOp1 = resolve;
    });
    c.enqueue("k", async () => {
      calls.push("op1");
      await op1Done;
    });
    const p1 = c.flush(); // 进入执行，op1 挂起
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["op1"]);
    const p2 = c.flush(); // join 同一个 activeFlush
    let p2Resolved = false;
    void p2.then(() => {
      p2Resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Resolved).toBe(false); // release 前第二个 flush 不得提前返回
    // 执行中入队新 op：join 的第二个 flush 也要等到它完成。
    c.enqueue("k2", async () => {
      calls.push("op2");
    });
    releaseOp1();
    await Promise.all([p1, p2]);
    expect(calls).toEqual(["op1", "op2"]);
    expect(c.pendingCount).toBe(0);
    expect(c.state.state).toBe("saved");
    expect(p2Resolved).toBe(true);
  });

  it("并发 flush join：第一个失败 → 第二个观察到 failed，safeNavigate 不放行（审计 P0-1）", async () => {
    const c = new SaveCoordinator(0);
    let fail = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    c.enqueue("seg:1", async () => {
      await gate;
      if (fail) throw new Error("boom");
    });
    const p1 = c.flush();
    await Promise.resolve();
    await Promise.resolve();
    const p2 = c.flush();
    release();
    await Promise.all([p1, p2]);
    expect(c.state.state).toBe("failed"); // join 者观察到最终失败状态
    const guard = await safeNavigate(c);
    expect(guard.allowed).toBe(false);
    fail = false;
    expect((await safeNavigate(c)).allowed).toBe(true);
  });

  it("subscribe 收到状态变化；schedule 在 failed 时保持 failed 可见", async () => {
    const c = new SaveCoordinator(0);
    const seen: string[] = [];
    const un = c.subscribe((s) => seen.push(s.state));
    c.enqueue("x", async () => {
      throw new Error("e");
    });
    c.schedule();
    await c.flush();
    expect(c.state.state).toBe("failed");
    c.schedule(); // failed 状态下 schedule 不回退为 saving
    expect(c.state.state).toBe("failed");
    expect(seen).toContain("failed");
    un();
  });
});

describe("P0-1（第 6 轮）：flush 快照跳过陈旧同-label op", () => {
  it("A 挂起期间 B-old 被替换 → A、B-new 执行，B-old 为 0", async () => {
    const calls: string[] = [];
    const coordinator = new SaveCoordinator(0);

    let releaseA!: () => void;
    const opA = () =>
      new Promise<void>((resolve) => {
        releaseA = () => {
          calls.push("A");
          resolve();
        };
      });
    const opB_old = () => {
      calls.push("B-old"); // 绝不应该执行
      return Promise.resolve();
    };
    const opB_new = () => {
      calls.push("B-new");
      return Promise.resolve();
    };

    coordinator.enqueue("label:a", opA);
    coordinator.enqueue("label:b", opB_old);
    const flushPromise = coordinator.flush();

    // A 挂起期间，B-old 被替换。
    await new Promise((r) => setTimeout(r, 10)); // 等 flush 开始执行 A
    coordinator.enqueue("label:b", opB_new);

    // 释放 A → flush 继续执行快照里的下一个 op。
    releaseA();
    await flushPromise;

    // B-old 被跳过（已被替换），只有 A 和 B-new 执行。
    expect(calls).toEqual(["A", "B-new"]);
    expect(calls).not.toContain("B-old");
    expect(coordinator.state.state).toBe("saved");
  });

  it("正在执行中的 A 完成后新 A-new 仍继续执行（既有语义保留）", async () => {
    const calls: string[] = [];
    const coordinator = new SaveCoordinator(0);

    let releaseA!: () => void;
    const opA_old = () =>
      new Promise<void>((resolve) => {
        releaseA = () => {
          calls.push("A-old-exec");
          resolve();
        };
      });
    const opA_new = () => {
      calls.push("A-new-exec");
      return Promise.resolve();
    };

    coordinator.enqueue("label:a", opA_old);
    const flushPromise = coordinator.flush();

    // A-old 正在执行中被替换。
    await new Promise((r) => setTimeout(r, 10));
    coordinator.enqueue("label:a", opA_new);

    releaseA();
    await flushPromise;

    // A-old 已在执行（完成），A-new 也执行。
    expect(calls).toEqual(["A-old-exec", "A-new-exec"]);
    expect(coordinator.state.state).toBe("saved");
  });
});
