// @vitest-environment jsdom
/**
 * 行内 ±2 秒复听集成测试（PRD V1.0.7 AC-051）：
 * - 暂停时点击 ⏪/⏩：只 seek 不自动播放（play 不被调用）；
 * - 播放中点击目标行 ⏪/⏩：保持播放、段内 seek，不重新 play；
 * - 点击目标行先选中该段并切换活动范围（换段暂停旧段、定位段首后再偏移）；
 * - 距边界不足 2 秒时钳制到段首/段尾，不跨段；
 * - 底部工具栏无独立 ±2s 控件。
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Workbench } from "../src/ui/Workbench.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "../src/store/types.js";

const { TimelineSpy } = vi.hoisted(() => ({
  TimelineSpy: vi.fn((_props: { segments: unknown }) => <div data-testid="timeline" />),
}));
vi.mock("../src/ui/Timeline.js", async () => {
  const { memo } = await import("react");
  return { Timeline: memo(TimelineSpy) };
});

afterEach(() => cleanup());

beforeAll(() => {
  // jsdom 媒体桩：play/pause 维护 paused 状态并派发事件（usePlayer 靠事件驱动 playing state）。
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
  globalThis.requestAnimationFrame = vi.fn(() => 1 as unknown as number);
  globalThis.cancelAnimationFrame = vi.fn();
});

function makeSeg(id: string, startMs: number, endMs: number): SegmentRecord {
  return {
    segmentId: id,
    projectId: "tp-skip",
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
    projectId: "tp-skip",
    name: "复听测试",
    normalizedStem: "复听测试",
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

/** A=9s、B=9s、C=1s（不足 2 秒，验证段首/段尾钳制）。 */
const SEGMENTS = [
  makeSeg("seg-a", 1000, 10_000),
  makeSeg("seg-b", 11_000, 20_000),
  makeSeg("seg-c", 21_000, 22_000),
];

function audioEl(): HTMLAudioElement {
  return document.querySelector("audio")!;
}

function renderWorkbench(segments: SegmentRecord[] = SEGMENTS, issues: IssueRecord[] = []) {
  const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
  playSpy.mockClear(); // beforeAll 的原型 spy 跨用例共享：每次渲染重置计数
  const utils = render(
    <Workbench
      meta={makeMeta()}
      audioFile={null}
      audioNotice={null}
      initialSegments={segments}
      initialIssues={issues}
      onBack={vi.fn()}
      onRelocated={vi.fn()}
    />,
  );
  const row = (id: string) =>
    utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
  const skipBack = (id: string) => within(row(id)).getByRole("button", { name: "后退 2 秒" });
  const skipForward = (id: string) => within(row(id)).getByRole("button", { name: "前进 2 秒" });
  const playButton = (id: string) => within(row(id)).getByRole("button", { name: "播放" });
  const expectActive = (id: string) => {
    for (const r of document.querySelectorAll<HTMLElement>(".seg-row")) {
      expect(r.classList.contains("active")).toBe(r.getAttribute("data-segment-id") === id);
    }
  };
  return { ...utils, row, skipBack, skipForward, playButton, expectActive, playSpy };
}

describe("行内 ±2 秒复听（PRD V1.0.7 AC-051）", () => {
  it("暂停时：⏪/⏩ 只在当前段内 seek，不自动播放（play 零调用）", () => {
    const { skipBack, skipForward, playSpy } = renderWorkbench();
    expect(audioEl().paused).toBe(true);
    audioEl().currentTime = 5; // 段 A 内 5000ms
    fireEvent.click(skipBack("seg-a"));
    expect(audioEl().currentTime).toBe(3); // 5000 - 2000
    expect(audioEl().paused).toBe(true);
    fireEvent.click(skipForward("seg-a"));
    expect(audioEl().currentTime).toBe(5); // 3000 + 2000（从上一 seek 位置继续）
    expect(audioEl().paused).toBe(true);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("边界钳制：不足 2 秒停在该段起点/终点，不跨段", () => {
    const { skipBack, skipForward } = renderWorkbench();
    // 段首：1500ms 后退 2 秒 → 钳到段首 1000ms。
    audioEl().currentTime = 1.5;
    fireEvent.click(skipBack("seg-a"));
    expect(audioEl().currentTime).toBe(1);
    // 段尾：9500ms 前进 2 秒 → 钳到段尾 10000ms（不进入 B 段 11000）。
    audioEl().currentTime = 9.5;
    fireEvent.click(skipForward("seg-a"));
    expect(audioEl().currentTime).toBe(10);
    // 不足 2 秒的段 C（21s–22s）：先点击行选中，再验证两端钳制。
    fireEvent.pointerDown(screen.getByText("原文seg-c"));
    expect(audioEl().currentTime).toBe(21); // 定位 C 段首
    fireEvent.click(skipForward("seg-c"));
    expect(audioEl().currentTime).toBe(22); // 钳到 C 段尾，不越界
    fireEvent.click(skipBack("seg-c"));
    expect(audioEl().currentTime).toBe(21); // 钳回 C 段首，不越界
    expect(audioEl().paused).toBe(true);
  });

  it("播放中点击目标行 ⏪：保持播放、段内 seek，不重新触发 play", () => {
    const { row, skipBack, playButton, playSpy } = renderWorkbench();
    fireEvent.click(playButton("seg-a")); // 从段首播放 A
    expect(audioEl().paused).toBe(false);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(within(row("seg-a")).getByRole("button", { name: "暂停" })).toBeTruthy();
    audioEl().currentTime = 5;
    fireEvent.click(skipBack("seg-a"));
    expect(audioEl().currentTime).toBe(3); // 段内 seek
    expect(audioEl().paused).toBe(false); // 保持播放
    expect(playSpy).toHaveBeenCalledTimes(1); // 未重新 play
    expect(within(row("seg-a")).getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("播放 A 时点击 B 行 ⏩：暂停旧段、选中 B、定位 B 段首后再偏移，不自动播放", () => {
    const { row, skipForward, playButton, expectActive, playSpy } = renderWorkbench();
    fireEvent.click(playButton("seg-a"));
    audioEl().currentTime = 5;
    fireEvent.click(skipForward("seg-b"));
    expectActive("seg-b"); // 按钮所在段成为当前选中段
    expect(audioEl().paused).toBe(true); // 换段暂停旧段，不自动播放
    expect(audioEl().currentTime).toBe(13); // B 段首 11000 + 2000
    expect(playSpy).toHaveBeenCalledTimes(1); // 只有一次初始 play
    expect(within(row("seg-b")).getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("暂停时点击另一行 ⏪：先选中并定位目标段段首，再执行偏移（后退钳到段首）", () => {
    const { skipBack, expectActive, playSpy } = renderWorkbench();
    audioEl().currentTime = 5;
    fireEvent.click(skipBack("seg-b"));
    expectActive("seg-b");
    expect(audioEl().paused).toBe(true);
    expect(audioEl().currentTime).toBe(11); // 定位 B 段首后退 2 秒 → 钳到段首
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("重复时间范围行：播放中点击另一行 ⏪ 仍切换选中到目标行，保持播放且不重复 play", () => {
    // 两行时间范围完全相同（D1/D2 均为 30s–40s）：范围匹配不能替代行选中。
    const dup = [
      ...SEGMENTS,
      makeSeg("seg-d1", 30_000, 40_000),
      makeSeg("seg-d2", 30_000, 40_000),
    ];
    const { row, skipBack, playButton, expectActive, playSpy } = renderWorkbench(dup);
    fireEvent.click(playButton("seg-d1"));
    audioEl().currentTime = 35;
    fireEvent.click(skipBack("seg-d2"));
    expectActive("seg-d2"); // 点击目标行始终成为当前选中段
    expect(audioEl().paused).toBe(false); // 播放的就是目标范围：保持播放
    expect(audioEl().currentTime).toBe(33); // 段内 seek：35000 - 2000
    expect(playSpy).toHaveBeenCalledTimes(1); // 不重新 play
    expect(within(row("seg-d2")).getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("重复时间范围行：暂停时点击另一行 ⏪ 切换选中并定位段首后再偏移", () => {
    const dup = [
      ...SEGMENTS,
      makeSeg("seg-d1", 30_000, 40_000),
      makeSeg("seg-d2", 30_000, 40_000),
    ];
    const { skipBack, expectActive, playSpy } = renderWorkbench(dup);
    audioEl().currentTime = 35;
    fireEvent.click(skipBack("seg-d2"));
    expectActive("seg-d2");
    expect(audioEl().paused).toBe(true);
    expect(audioEl().currentTime).toBe(30); // 定位目标段段首后退 2 秒 → 钳到段首
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("底部工具栏无独立播放/暂停与 ±2s 控件（AC-050）", () => {
    renderWorkbench();
    const playerBar = document.querySelector(".player-bar")!;
    expect(within(playerBar as HTMLElement).queryByRole("button", { name: "播放" })).toBeNull();
    expect(within(playerBar as HTMLElement).queryByText("⏪ 2s")).toBeNull();
    expect(within(playerBar as HTMLElement).queryByText("⏩ 2s")).toBeNull();
  });
});
