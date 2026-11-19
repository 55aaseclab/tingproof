// @vitest-environment jsdom
/**
 * V1.1.4 编辑打断精确续播（PRD §3.2.5 / AC-067）：
 * - 当前段播放中聚焦其文本框 → 立即在精确打断位置暂停（不 seek、不回段首）；
 * - 下一次播放同一段从该位置继续，且仅这一次不应用自动回退；标记一次性消费；
 * - 主动暂停/恢复仍按设置自动回退；seek、±2s、循环、换段清除标记，旧位置不污染新段；
 * - Workbench 接线：聚焦当前播放段文本框只在精确位置暂停；聚焦另一段仍是旧行为。
 */
import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "../src/audio/usePlayer.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { PlaybackRange } from "../src/core/segmentPlayback.js";
import type { ProjectMeta, SegmentRecord } from "../src/store/types.js";

const A: PlaybackRange = { startMs: 10_000, endMs: 20_000 };
const B: PlaybackRange = { startMs: 30_000, endMs: 40_000 };

/** 假 HTMLAudioElement（与 usePlayerRange.test.tsx 同构：currentTime 以秒存储）。 */
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
    playMock: el.play,
    setMs: (ms: number) => {
      el.currentTime = ms / 1000;
    },
    getMs: () => Math.round(el.currentTime * 1000),
  };
}

function setupPlayer(rewindMs = 1500) {
  const fake = makeFakeAudio();
  const ref = { current: fake.el };
  const { result } = renderHook(() =>
    usePlayer(ref, { initialAutoRewindMs: rewindMs }),
  );
  return { result, fake };
}

beforeEach(() => {
  globalThis.requestAnimationFrame = vi.fn(() => 1 as unknown as number);
  globalThis.cancelAnimationFrame = vi.fn();
});

afterEach(() => cleanup());

describe("usePlayer 编辑打断精确续播（AC-067）", () => {
  it("当前段播放中 pauseForEdit：在精确位置暂停，不跳段首；下次播放从该点无回退续播", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A)); // 从段首起播
    expect(fake.getMs()).toBeCloseTo(10_000, -1);
    fake.setMs(15_000); // 模拟播放推进到 15.000s

    await act(async () => result.current.pauseForEdit());
    expect(result.current.playing).toBe(false);
    expect(fake.el.paused).toBe(true);
    // 精确位置暂停：仍在 15000ms±100ms，不回段首 10000ms。
    expect(Math.abs(fake.getMs() - 15_000)).toBeLessThanOrEqual(100);

    // 下一次播放同段：从打断点继续，且本次自动回退为 0ms（不回退到 13500）。
    await act(async () => result.current.toggleRange(A));
    expect(result.current.playing).toBe(true);
    expect(Math.abs(fake.getMs() - 15_000)).toBeLessThanOrEqual(100);
  });

  it("标记一次性消费：再做空闲暂停/恢复后仍按设置自动回退约 1.5s", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());

    await act(async () => result.current.toggleRange(A)); // 消费续播点
    expect(Math.abs(fake.getMs() - 15_000)).toBeLessThanOrEqual(100);
    fake.setMs(16_000); // 继续播放推进

    await act(async () => result.current.toggleRange(A)); // 用户主动暂停（在 16s）
    expect(result.current.playing).toBe(false);
    await act(async () => result.current.toggleRange(A)); // 主动恢复：常规规则 → 回退 1.5s
    expect(Math.abs(fake.getMs() - 14_500)).toBeLessThanOrEqual(100);
  });

  it("主动 seek（含 ±2s）清除标记：恢复按常规规则", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());
    await act(async () => result.current.seek(12_000)); // 用户主动 seek → 标记失效

    await act(async () => result.current.toggleRange(A));
    // 常规规则：seek 后（seekedSincePause）从当前位置起播，不使用打断点。
    expect(Math.abs(fake.getMs() - 12_000)).toBeLessThanOrEqual(100);

    // ±2s（skip → seek）同样清除。
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());
    await act(async () => result.current.skip(2000));
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 17_000)).toBeLessThanOrEqual(100);
  });

  it("开关循环清除标记；换段从新段段首开始且旧位置不污染新段", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());

    // 循环开关 → 标记失效 → 恢复按常规规则（回退 1.5s）。
    await act(async () => result.current.loopSegment(A.startMs, A.endMs));
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 13_500)).toBeLessThanOrEqual(100);

    // 换段：B 从段首开始，A 的打断位置不影响 B。
    await act(async () => result.current.pause());
    await act(async () => result.current.pauseForEdit()); // 无效（已暂停）
    await act(async () => result.current.toggleRange(B));
    expect(Math.abs(fake.getMs() - 30_000)).toBeLessThanOrEqual(100);
    // 再回 A：从 A 段首开始（标记早已清除，不回到 15s）。
    await act(async () => result.current.pause());
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 10_000)).toBeLessThanOrEqual(100);
  });

  it("用户主动暂停清除标记：恢复按常规自动回退", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit()); // 标记已设置
    await act(async () => result.current.pause()); // 已暂停：no-op，但标记仍在（尚未起播）

    // 起播消费标记 → 主动暂停 → 再恢复：常规回退。
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 15_000)).toBeLessThanOrEqual(100);
    fake.setMs(18_000);
    await act(async () => result.current.pause()); // 主动暂停清除（防御：此时刻本应为空）
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 16_500)).toBeLessThanOrEqual(100);
  });

  it("clearEditResume 显式清除（时间轴变化等外部更新）", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());
    await act(async () => result.current.clearEditResume());
    await act(async () => result.current.toggleRange(A));
    // 常规规则：pausedAt=15000 且未 seek → 回退 1.5s。
    expect(Math.abs(fake.getMs() - 13_500)).toBeLessThanOrEqual(100);
  });

  it("起播失败（play reject）保留标记：重试仍从精确打断点无回退续播；成功起播后才消费", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());

    // 第一次起播被拒绝（自动播放策略/解码失败）：保持暂停，标记保留。
    fake.playMock.mockRejectedValueOnce(new Error("play rejected"));
    await act(async () => result.current.toggleRange(A));
    await act(async () => Promise.resolve()); // flush play 的 reject/catch 微任务
    expect(result.current.playing).toBe(false);
    expect(fake.el.paused).toBe(true);
    expect(fake.getMs()).toBe(15_000); // 仍定位在打断点

    // 重试：仍从精确打断点无回退续播（不是回退 1.5s 到 13.5s）。
    await act(async () => result.current.toggleRange(A));
    expect(result.current.playing).toBe(true);
    expect(Math.abs(fake.getMs() - 15_000)).toBeLessThanOrEqual(100);

    // 成功起播后标记已消费：再次暂停/恢复回到常规回退规则。
    fake.setMs(16_000);
    await act(async () => result.current.toggleRange(A)); // 主动暂停
    await act(async () => result.current.toggleRange(A)); // 恢复：回退 1.5s
    expect(Math.abs(fake.getMs() - 14_500)).toBeLessThanOrEqual(100);
  });

  it("P1-1（第 2 轮）：用旧打断点发起 play（未决）→ 立即显式暂停 → 旧标记已清，下次走常规回退", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit()); // 打断点 @15000

    // 用打断点发起 play，promise 挂起。
    fake.playMock.mockImplementationOnce(() => {
      Object.defineProperty(fake.el, "paused", { value: false, configurable: true });
      return new Promise<void>(() => undefined); // 永不 resolve
    });
    await act(async () => result.current.toggleRange(A));
    expect(fake.el.paused).toBe(false); // play() 已置 paused=false

    // 立即再次点播放按钮 → 显式暂停 → P1-1：旧标记清除。
    fake.playMock.mockImplementationOnce(() => {
      Object.defineProperty(fake.el, "paused", { value: true, configurable: true });
      return Promise.resolve();
    });
    await act(async () => result.current.toggleRange(A));
    expect(result.current.playing).toBe(false);

    // 下一次播放：旧标记已清 → 常规 auto-rewind（15s - 1.5s = 13.5s），不用旧打断点 15s。
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 13_500)).toBeLessThanOrEqual(100);
  });

  it("play promise 竞态：旧 promise 迟到 resolve 不得清除新打断点（P1-4）", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit()); // 打断点 P1 @15000

    // 用 P1 发起播放，但 play promise 挂起（未决）。
    let releaseOldPlay!: () => void;
    fake.playMock.mockImplementationOnce(() => {
      Object.defineProperty(fake.el, "paused", { value: false, configurable: true });
      return new Promise<void>((resolve) => {
        releaseOldPlay = resolve;
      });
    });
    await act(async () => result.current.toggleRange(A));
    expect(fake.el.paused).toBe(false); // play() 已置 paused=false（promise 未决）

    // 用户立即再次编辑暂停 → 生成新打断点 P2 @16000（不同对象）。
    fake.setMs(16_000);
    await act(async () => result.current.pauseForEdit()); // P2 @16000
    expect(fake.el.paused).toBe(true);

    // 旧 play promise 现在才 resolve：不得清除 P2。
    await act(async () => releaseOldPlay());
    await act(async () => Promise.resolve()); // flush .then 微任务

    // 下一次播放应从 P2（16000）续播，而不是被旧 promise 清掉后走常规回退（13500）。
    await act(async () => result.current.toggleRange(A));
    expect(Math.abs(fake.getMs() - 16_000)).toBeLessThanOrEqual(100);
  });

  it("原生 ended 路径清除标记：恢复从段首开始", async () => {
    const { result, fake } = setupPlayer(1500);
    await act(async () => result.current.setRange(A));
    await act(async () => result.current.playRange(A));
    fake.setMs(15_000);
    await act(async () => result.current.pauseForEdit());
    // 模拟音频自然播完（ended 事件）：标记失效，pausedRef 稳定在段尾。
    await act(async () => fake.fire("ended"));
    expect(result.current.playing).toBe(false);
    await act(async () => result.current.toggleRange(A));
    // 段尾恢复规则：从段首开始（不使用 15s 打断点）。
    expect(Math.abs(fake.getMs() - 10_000)).toBeLessThanOrEqual(100);
  });
});

// ---------- Workbench 接线 ----------

const { TimelineSpy } = vi.hoisted(() => ({
  TimelineSpy: vi.fn((_props: { segments: unknown }) => <div data-testid="timeline" />),
}));
vi.mock("../src/ui/Timeline.js", async () => {
  const { memo } = await import("react");
  return { Timeline: memo(TimelineSpy) };
});

function makeSeg(id: string, startMs: number, endMs: number): SegmentRecord {
  return {
    segmentId: id,
    projectId: "tp-edit",
    cueNo: null,
    startMs,
    endMs,
    originalText: `原文${id}`,
    correctedText: `校对${id}`,
    status: "unreviewed",
    revisionNo: 1,
    updatedAt: 0,
  };
}

function makeMeta(): ProjectMeta {
  return {
    projectId: "tp-edit",
    name: "编辑打断测试",
    normalizedStem: "编辑打断测试",
    createdAt: 1,
    updatedAt: 1,
    media: {
      audioName: "a.mp3",
      audioSize: 1,
      audioLastModified: 1,
      audioFingerprint: "fp",
      srtFileName: "a.srt",
      srtSha256: "x",
      mediaKey: "k",
      durationMs: null,
      srtHandle: null,
      audioHandle: null,
    },
    playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
  };
}

const WB_SEGMENTS = [makeSeg("seg-a", 10_000, 20_000), makeSeg("seg-b", 30_000, 40_000)];

function audioEl(): HTMLAudioElement {
  return document.querySelector("audio")!;
}

describe("Workbench 编辑打断接线（AC-067）", () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { value: false, configurable: true });
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { value: true, configurable: true });
      this.dispatchEvent(new Event("pause"));
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("播放中聚焦当前段文本框：只在精确位置暂停；再点行内播放从该点无回退续播", async () => {
    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={WB_SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const editorOf = (id: string) => within(row(id)).getByRole("textbox");

    // 起播 A 段并推进到 15s（当前选中段 = A）。
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "播放" }));
    expect(audioEl().paused).toBe(false);
    audioEl().currentTime = 15;

    // 聚焦当前段（A）文本框：只在精确位置暂停，不跳段首。
    fireEvent.focus(editorOf("seg-a"));
    expect(audioEl().paused).toBe(true);
    expect(audioEl().currentTime).toBeCloseTo(15, 5); // 未被写回 10

    // 行内播放：从打断点 15s 续播（autoRewindMs=1500 不生效）。
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "播放" }));
    expect(audioEl().paused).toBe(false);
    expect(audioEl().currentTime).toBeCloseTo(15, 5);
  });

  it("播放中聚焦另一段文本框：旧行为——暂停旧段、选中并定位新段段首", () => {
    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={WB_SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "播放" }));
    audioEl().currentTime = 15;

    fireEvent.focus(within(row("seg-b")).getByRole("textbox"));
    expect(audioEl().paused).toBe(true);
    expect(audioEl().currentTime).toBeCloseTo(30, 5); // 定位 B 段首
    // 旧段打断位置不得污染：再次播放 B 从 B 段首（已在段首，起播不回退到别处）。
    fireEvent.click(within(row("seg-b")).getByRole("button", { name: "播放" }));
    expect(audioEl().paused).toBe(false);
    expect(audioEl().currentTime).toBeCloseTo(30, 5);
  });

  it("语义分离（AC-041 保持）：播放中点击行空白区仍精确定位段首，不受编辑打断特例影响", () => {
    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={WB_SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    // 起播当前选中段 A 并推进到 15s。
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "播放" }));
    audioEl().currentTime = 15;

    // 点击同一行（A）的空白区（非按钮/文本框/时间码）：仍是“精确定位段首”。
    fireEvent.pointerDown(row("seg-a").querySelector(".seg-original")!);
    expect(audioEl().paused).toBe(true);
    expect(audioEl().currentTime).toBeCloseTo(10, 5); // 定位 A 段首，而非停在 15s
    // 再次播放 A：从段首开始（无打断标记），常规规则。
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "播放" }));
    expect(audioEl().paused).toBe(false);
    expect(audioEl().currentTime).toBeCloseTo(10, 5);
  });
});
