// @vitest-environment jsdom
/**
 * 周期持久化回归测试（审计 P0-3）。
 * 使用 fake timers + 真实 usePeriodicPersist hook：
 * - 无关 UI render（如播放进入新字幕段导致的选中变化）不重置 interval；
 * - 连续播放满 5 秒必定触发持久化（真实字幕段平均不足 5 秒的场景）；
 * - shouldRun=false（暂停）时不触发。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePeriodicPersist } from "../src/audio/usePeriodicPersist.js";

afterEach(() => cleanup());
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function Harness({
  playing,
  run,
  bump,
}: {
  playing: boolean;
  run: () => void;
  bump: number;
}) {
  usePeriodicPersist(() => playing, run, 5000);
  void bump;
  return <div data-testid="bump">{String(bump)}</div>;
}

describe("usePeriodicPersist（P0-3 回归）", () => {
  it("连续播放 5 秒触发持久化；中途多次纯 render 不重置计时", () => {
    const run = vi.fn();
    const { rerender } = render(<Harness playing run={run} bump={0} />);

    // 4.9 秒处发生多次无关 render（模拟 selectedId/文本变化）。
    act(() => {
      vi.advanceTimersByTime(4900);
    });
    rerender(<Harness playing run={run} bump={1} />);
    rerender(<Harness playing run={run} bump={2} />);
    expect(run).not.toHaveBeenCalled();

    // 到 5 秒：必须触发（修复前——effect 依赖整个 player 对象，
    // 每次字幕段切换的 render 都重置 interval，连续短段播放可能永不触发）。
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(run).toHaveBeenCalledTimes(1);

    // 继续播放：下一个 5 秒再次触发。
    rerender(<Harness playing run={run} bump={3} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("暂停（shouldRun=false）时不触发；恢复播放后继续", () => {
    const run = vi.fn();
    const { rerender } = render(<Harness playing={false} run={run} bump={0} />);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(run).not.toHaveBeenCalled();
    rerender(<Harness playing run={run} bump={1} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("卸载后不再触发", () => {
    const run = vi.fn();
    const { unmount } = render(<Harness playing run={run} bump={0} />);
    unmount();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(run).not.toHaveBeenCalled();
  });
});
