// @vitest-environment jsdom
/**
 * 选中段订阅回归测试（审计 P0-2）。
 * 使用真实 usePlaybackSelection hook + 稳定的假 player 订阅源：
 * - 纯 selectedId/文本 render 不重订阅（subscribe 恰好一次），
 *   因此暂停时聚焦第二行后，不会被旧播放位置（第一段）覆盖；
 * - 播放真正进入第二段范围时，选中被接管；
 * - 卸载时正确退订。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlaybackSelection } from "../src/audio/usePlaybackSelection.js";
import type { SegmentLike } from "../src/core/selection.js";

afterEach(() => cleanup());

const SEGMENTS: SegmentLike[] = [
  { segmentId: "s1", startMs: 0, endMs: 5000, status: "unreviewed", correctedText: "一" },
  { segmentId: "s2", startMs: 6000, endMs: 12000, status: "unreviewed", correctedText: "二" },
];

/** 复刻 Workbench 的用法：稳定 subscribe 源 + 显式选中通道。 */
function Harness({
  player,
  bump,
  explicitSelect,
}: {
  player: { subscribeCurrentMs: (cb: (ms: number) => void) => () => void; positionMs: number };
  bump: number;
  explicitSelect: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>("s1");
  const shown = explicitSelect ?? selectedId;
  usePlaybackSelection(
    player.subscribeCurrentMs,
    () => SEGMENTS,
    (id) => {
      if (explicitSelect === null) setSelectedId(id);
    },
  );
  void bump; // 触发纯 render 的道具
  return (
    <div>
      <div data-testid="selected">{shown}</div>
      <button data-testid="pick-s2" onClick={() => setSelectedId("s2")}>
        选中第二行
      </button>
    </div>
  );
}

function makeFakePlayer(initialPos: number) {
  const listeners = new Set<(ms: number) => void>();
  let pos = initialPos;
  let subscribeCount = 0;
  return {
    get subscribeCount() {
      return subscribeCount;
    },
    get positionMs() {
      return pos;
    },
    set positionMs(v: number) {
      pos = v;
    },
    subscribeCurrentMs(cb: (ms: number) => void) {
      subscribeCount += 1;
      listeners.add(cb);
      cb(pos); // 与 usePlayer 相同：订阅时立即回调当前播放位置
      return () => {
        subscribeCount -= 1;
        listeners.delete(cb);
      };
    },
    notify() {
      for (const cb of listeners) cb(pos);
    },
  };
}

describe("usePlaybackSelection（P0-2 回归）", () => {
  it("暂停在第一段时显式选中第二行：纯 render 不重订阅、不回切到第一段", () => {
    const player = makeFakePlayer(1000); // 播放头位于 s1 且暂停
    const { rerender } = render(<Harness player={player} bump={0} explicitSelect={null} />);
    expect(player.subscribeCount).toBe(1);

    // 用户点进第二行（显式选中）。
    act(() => {
      screen.getByTestId("pick-s2").click();
    });
    expect(screen.getByTestId("selected").textContent).toBe("s2");

    // 纯 render（文本编辑等引起的重渲染，播放位置不变）：
    // 修复前——effect 依赖整个 player 对象 → 重订阅 → 立即回调用旧位置覆盖选中；
    // 修复后——订阅稳定，选中保持 s2。
    rerender(<Harness player={player} bump={1} explicitSelect={null} />);
    expect(player.subscribeCount).toBe(1);
    expect(screen.getByTestId("selected").textContent).toBe("s2");
  });

  it("播放真正进入第二段 → 选中被接管（策略行为不变）", () => {
    const player = makeFakePlayer(1000);
    render(<Harness player={player} bump={0} explicitSelect={null} />);
    expect(screen.getByTestId("selected").textContent).toBe("s1");
    act(() => {
      player.positionMs = 7000; // 进入 s2 范围
      player.notify();
    });
    expect(screen.getByTestId("selected").textContent).toBe("s2");
  });

  it("播放位于间隙 → 不接管（保持当前选中）", () => {
    const player = makeFakePlayer(5500); // s1 与 s2 之间的间隙
    render(<Harness player={player} bump={0} explicitSelect={null} />);
    act(() => {
      player.notify();
    });
    expect(screen.getByTestId("selected").textContent).toBe("s1");
  });

  it("卸载时退订", () => {
    const player = makeFakePlayer(1000);
    const { unmount } = render(<Harness player={player} bump={0} explicitSelect={null} />);
    expect(player.subscribeCount).toBe(1);
    unmount();
    expect(player.subscribeCount).toBe(0);
  });

  it("同一段的重复位置通知只上报一次（避免播放期每帧 setRange churn，审计项 4）", () => {
    const player = makeFakePlayer(1000);
    const onTakeover = vi.fn();
    function Harness2() {
      usePlaybackSelection(player.subscribeCurrentMs, () => SEGMENTS, onTakeover);
      return null;
    }
    render(<Harness2 />);
    expect(onTakeover).toHaveBeenCalledTimes(1); // 订阅时立即上报一次
    act(() => {
      player.notify(); // 同段同位置：不再上报
      player.notify();
    });
    expect(onTakeover).toHaveBeenCalledTimes(1);
    act(() => {
      player.positionMs = 7000; // 进入 s2：上报
      player.notify();
    });
    expect(onTakeover).toHaveBeenCalledTimes(2);
  });

  it("订阅源引用变化才重订阅（vi.fn 计数）", () => {
    const subA = vi.fn().mockImplementation(() => () => undefined);
    const { rerender } = render(<Harness player={{ subscribeCurrentMs: subA, positionMs: 0 }} bump={0} explicitSelect={null} />);
    expect(subA).toHaveBeenCalledTimes(1);
    // 同一个 subscribe 引用 + 多次 render：不重订阅。
    rerender(<Harness player={{ subscribeCurrentMs: subA, positionMs: 0 }} bump={2} explicitSelect={null} />);
    expect(subA).toHaveBeenCalledTimes(1);
    // 引用变化（真实场景：切换播放源）→ 重订阅。
    const subB = vi.fn().mockImplementation(() => () => undefined);
    rerender(<Harness player={{ subscribeCurrentMs: subB, positionMs: 0 }} bump={3} explicitSelect={null} />);
    expect(subB).toHaveBeenCalledTimes(1);
  });
});
