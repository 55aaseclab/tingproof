// @vitest-environment jsdom
/**
 * usePlayer 段内播放行为测试（jsdom + 假 audio 元素 + renderHook）。
 * 覆盖：首次点击从段首播放；播放中再次点击暂停在当前位置（不回段首）；
 * 同段恢复自动回退（不早于段首）；换段从新段首；段尾再播从段首；
 * 普通模式段尾暂停并稳定在 end_ms（不串段）；循环回绕；换段旧 loop 安全解除；
 * F7/F9 钳制；播放中 seek 越界即暂停。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "../src/audio/usePlayer.js";
import type { PlaybackRange } from "../src/core/segmentPlayback.js";

const A: PlaybackRange = { startMs: 0, endMs: 5000 };
const B: PlaybackRange = { startMs: 10_000, endMs: 15_000 };

/** 假 HTMLAudioElement：只实现 usePlayer 触碰的表面（currentTime 以秒存储）。 */
function makeFakeAudio(durationSec = 3600) {
  const listeners = new Map<string, Set<() => void>>();
  let curSec = 0;
  const el = {
    get currentTime() {
      return curSec;
    },
    set currentTime(v: number) {
      curSec = v;
    },
    duration: durationSec,
    paused: true,
    playbackRate: 1,
    preservesPitch: false,
    webkitPreservesPitch: false,
    play: vi.fn(() => {
      el.paused = false;
      fire("play");
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      el.paused = true;
      fire("pause");
    }),
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  function fire(type: string) {
    for (const fn of listeners.get(type) ?? []) fn();
  }
  return {
    el: el as unknown as HTMLAudioElement,
    fire,
    /** 以毫秒读写播放头。 */
    setMs: (ms: number) => {
      el.currentTime = ms / 1000;
    },
    getMs: () => Math.round(el.currentTime * 1000),
  };
}

/** 可执行回调的 rAF 桩：用于验证循环回绕后 rAF 链不断。 */
function installRaf() {
  const queue: (FrameRequestCallback | undefined)[] = [];
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = vi.fn((id: number) => {
    queue[id - 1] = undefined;
  }) as unknown as typeof cancelAnimationFrame;
  return {
    get pending() {
      return queue.filter(Boolean).length;
    },
    runOne() {
      const cb = queue.shift();
      cb?.(0);
    },
  };
}

function setup(rewindMs = 1500) {
  const fake = makeFakeAudio();
  const ref = { current: fake.el };
  const onDuration = vi.fn();
  const onPauseChange = vi.fn();
  const { result } = renderHook(() =>
    usePlayer(ref, { initialAutoRewindMs: rewindMs, onDuration, onPauseChange }),
  );
  return { result, fake, onDuration, onPauseChange };
}

beforeEach(() => {
  // jsdom 无 rAF：以空实现替换，段尾检测走 timeupdate 事件路径。
  globalThis.requestAnimationFrame = vi.fn(() => 1 as unknown as number);
  globalThis.cancelAnimationFrame = vi.fn();
});

describe("usePlayer 段内播放（PRD V1.0.2 AC-042/AC-043）", () => {
  it("首次点击（播放头在段外）：选中范围并从段首播放", () => {
    const { result, fake } = setup();
    fake.setMs(2500); // 播放头位于 A 段内
    act(() => result.current.toggleRange(B)); // 直接对 B 段按播放
    expect(result.current.playing).toBe(true);
    expect(fake.getMs()).toBe(B.startMs);
    expect(result.current.range).toEqual(B);
  });

  it("播放中第二次点击：暂停在当前位置，不回段首", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(2500);
    act(() => result.current.toggleRange(A)); // 播放
    expect(result.current.playing).toBe(true);
    fake.setMs(3210);
    act(() => result.current.toggleRange(A)); // 再点 → 暂停在当前位置
    expect(result.current.playing).toBe(false);
    expect(fake.getMs()).toBe(3210);
  });

  it("同段段内恢复：自动回退 1.5s 且不早于段首", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(2500);
    act(() => result.current.toggleRange(A));
    fake.setMs(3210);
    act(() => result.current.toggleRange(A)); // 暂停 @3210
    act(() => result.current.toggleRange(A)); // 恢复
    expect(fake.getMs()).toBe(1710); // 3210 - 1500
    expect(result.current.playing).toBe(true);
  });

  it("段内回退不早于段首", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A));
    fake.setMs(1200);
    act(() => result.current.toggleRange(A)); // 暂停 @1200
    act(() => result.current.toggleRange(A)); // 恢复
    expect(fake.getMs()).toBe(0); // max(start, 1200-1500)
  });

  it("普通模式：到 end_ms 自动暂停并稳定停在段尾，不串入下一段", () => {
    const { result, fake, onPauseChange } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A)); // 播放中
    fake.setMs(5040); // 越过段尾
    act(() => fake.fire("timeupdate"));
    expect(result.current.playing).toBe(false);
    expect(fake.getMs()).toBe(5000); // 稳定在段尾
    expect(fake.el.pause).toHaveBeenCalled();
    expect(onPauseChange).toHaveBeenCalledWith(false, 5000);
  });

  it("段尾再次播放：从段首开始", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A));
    fake.setMs(5040);
    act(() => fake.fire("timeupdate")); // 段尾暂停 @5000
    act(() => result.current.toggleRange(A)); // 再播
    expect(fake.getMs()).toBe(0);
    expect(result.current.playing).toBe(true);
  });

  it("循环模式：段尾回段首继续（唯一回绕模式）", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A));
    act(() => result.current.loopSegment(A.startMs, A.endMs)); // 开启循环
    fake.setMs(5060);
    act(() => fake.fire("timeupdate"));
    expect(result.current.playing).toBe(true); // 不暂停
    expect(fake.getMs()).toBe(0); // 回段首继续
  });

  it("换段时旧 loop 安全解除：不会跳回旧段", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    act(() => result.current.loopSegment(A.startMs, A.endMs)); // A 段循环
    act(() => result.current.setRange(B)); // 切到 B 段
    expect(result.current.loop).toBeNull(); // 旧 loop 解除
    fake.setMs(B.startMs);
    act(() => result.current.toggleRange(B)); // 播放 B
    fake.setMs(B.endMs + 60);
    act(() => fake.fire("timeupdate"));
    expect(result.current.playing).toBe(false); // B 段尾普通暂停
    expect(fake.getMs()).toBe(B.endMs); // 不跳回 A 段首
  });

  it("F7/F9（skip）钳制在当前段内（播放中与暂停时一致）", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.skip(-2000));
    expect(fake.getMs()).toBe(0); // 不越过段首
    fake.setMs(4500);
    act(() => result.current.skip(2000));
    expect(fake.getMs()).toBe(5000); // 不越过段尾
    fake.setMs(2500);
    act(() => result.current.skip(2000));
    expect(fake.getMs()).toBe(4500);
  });

  it("播放中 seek 越出当前段：立即暂停在该位置（不继续出声）", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A)); // 播放中
    act(() => result.current.seek(20_000)); // 越界
    expect(result.current.playing).toBe(false);
    expect(fake.getMs()).toBe(20_000);
  });

  it("换段时正在播放的旧段立即暂停（点击另一条目定位场景）", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A)); // 播放 A
    act(() => result.current.setRange(B)); // 切换范围（定位到 B）
    expect(result.current.playing).toBe(false);
    act(() => result.current.seek(B.startMs));
    expect(fake.getMs()).toBe(B.startMs);
  });

  it("pause() 记录恢复点；无范围时保持旧回退语义", () => {
    const { result, fake } = setup();
    fake.setMs(8000);
    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    act(() => result.current.toggleRange(A)); // 无暂停点归属 A → 从段首
    expect(fake.getMs()).toBe(0);
  });
});


describe("审计回归（第 7 轮）", () => {
  it("循环回绕后 rAF 链不断：restart 分支继续排帧，可连续回绕两次", () => {
    const raf = installRaf();
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    act(() => result.current.loopSegment(A.startMs, A.endMs));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A)); // play 事件启动 rAF
    expect(result.current.playing).toBe(true);
    expect(raf.pending).toBe(1);

    act(() => raf.runOne()); // 段内：继续播放并排下一帧
    expect(raf.pending).toBe(1);

    fake.setMs(5100); // 越过段尾
    act(() => raf.runOne()); // restart：回段首且必须继续排帧（修复点）
    expect(fake.getMs()).toBe(0);
    expect(raf.pending).toBe(1);

    fake.setMs(5200); // 第二次越过段尾
    act(() => raf.runOne());
    expect(fake.getMs()).toBe(0); // 第二次回绕
    expect(result.current.playing).toBe(true);
    expect(raf.pending).toBe(1);
  });

  it("普通模式段尾：rAF 检测到段尾后不再排帧", () => {
    const raf = installRaf();
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(1000);
    act(() => result.current.toggleRange(A));
    expect(raf.pending).toBe(1);
    fake.setMs(5040);
    act(() => raf.runOne()); // pauseAtEnd：不排帧
    expect(result.current.playing).toBe(false);
    expect(fake.getMs()).toBe(5000);
    expect(raf.pending).toBe(0);
  });

  it("重叠范围换段：也必须从新段 start_ms 开始", () => {
    const { result, fake } = setup();
    const OVERLAP: PlaybackRange = { startMs: 2500, endMs: 8000 };
    act(() => result.current.setRange(A));
    fake.setMs(3000); // 同时位于 A 与 OVERLAP 内
    act(() => result.current.toggleRange(A));
    expect(result.current.playing).toBe(true);
    act(() => result.current.toggleRange(OVERLAP)); // 换段（时间范围重叠）
    expect(result.current.range).toEqual(OVERLAP);
    expect(fake.getMs()).toBe(2500); // 强制从新段段首，而不是原地继续
    expect(result.current.playing).toBe(true);
  });

  it("setRange 暂停点归属旧范围：换段后不会把旧播放点当成新段恢复点", () => {
    const { result, fake } = setup();
    const C: PlaybackRange = { startMs: 10_000, endMs: 15_000 };
    act(() => result.current.setRange(A));
    fake.setMs(3000);
    act(() => result.current.toggleRange(A)); // 播放 A @3000
    act(() => result.current.setRange(C)); // 越界暂停（暂停点 3000 属于 A）
    expect(result.current.playing).toBe(false);
    act(() => result.current.toggleRange(C)); // 播放 C：必须从 C 段首
    expect(fake.getMs()).toBe(10_000);
  });

  it("setRange 幂等：同一数值范围重复设置不产生状态 churn", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    act(() => result.current.loopSegment(A.startMs, A.endMs));
    const before = result.current.range;
    fake.setMs(1000);
    act(() => result.current.toggleRange(A)); // 播放中
    // 播放期间上游每帧以同一数值范围调用 setRange：必须 no-op。
    act(() => result.current.setRange(A));
    act(() => result.current.setRange(A));
    expect(result.current.range).toBe(before); // 引用不变（未重建状态）
    expect(result.current.loop).toEqual(A); // 循环未被反复解除/重建
    expect(result.current.playing).toBe(true);
    expect(fake.getMs()).toBe(1000); // 播放未被打断
  });

  it("playRange：无论此前状态如何都从目标段段首播放（疑点面板跳转播放）", () => {
    const { result, fake } = setup();
    act(() => result.current.setRange(A));
    fake.setMs(4000);
    act(() => result.current.toggleRange(A)); // 暂停在 A 段内
    act(() => result.current.playRange(B));
    expect(fake.getMs()).toBe(B.startMs); // 从 B 段首
    expect(result.current.playing).toBe(true);
    // 正在播放 A 时跳转到 B：同样从 B 段首
    fake.setMs(11_000);
    act(() => result.current.playRange(A));
    expect(fake.getMs()).toBe(0);
    expect(result.current.playing).toBe(true);
  });

  it("无效范围被明确拒绝：不改变现有状态", () => {
    const { result } = setup();
    act(() => result.current.setRange(A));
    const before = result.current.range;
    act(() => result.current.setRange({ startMs: -8000, endMs: -1000 })); // 全负：normalize 后无效
    expect(result.current.range).toBe(before);
    act(() => result.current.toggleRange({ startMs: 3000, endMs: 3000 })); // 零宽
    expect(result.current.range).toBe(before);
    act(() => result.current.loopSegment(9999, 9999)); // 无效循环
    expect(result.current.loop).toBeNull();
  });
});
