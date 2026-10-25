// @vitest-environment jsdom
/**
 * Workbench 集成回归（第 10 轮审计）：
 * - 行内「✓ 确认本段」：确认被点击段 + 选中/活动段切换为「按钮所在行」，
 *   绝不选 plan.nextId，不自动播放，不跳到下一段；
 * - 行内「↶ 取消确认」：操作对象 = 按钮所在行，选中目标一致，不跳下一段；
 * - Ctrl+Enter：确认当前选中段并选择/定位/聚焦下一未校对段（语义保持）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Workbench } from "../src/ui/Workbench.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "../src/store/types.js";

vi.mock("../src/ui/Timeline.js", () => ({ Timeline: () => <div data-testid="timeline" /> }));

afterEach(() => cleanup());

beforeAll(() => {
  // jsdom 媒体/滚动桩。
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    void this; // 保持当前位置（jsdom 无真实播放）
  });
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.requestAnimationFrame = vi.fn(() => 1 as unknown as number);
  globalThis.cancelAnimationFrame = vi.fn();
});

function makeSeg(id: string, startMs: number, endMs: number, status: SegmentRecord["status"] = "unreviewed"): SegmentRecord {
  return {
    segmentId: id,
    projectId: "tp-t",
    cueNo: null,
    startMs,
    endMs,
    originalText: `原文${id}`,
    correctedText: `校对${id}`,
    status,
    revisionNo: 1,
    updatedAt: 0,
  };
}

function makeMeta(): ProjectMeta {
  return {
    projectId: "tp-t",
    name: "测试项目",
    normalizedStem: "测试项目",
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

const SEGMENTS = [makeSeg("seg-a", 1000, 2000), makeSeg("seg-b", 2000, 3000), makeSeg("seg-c", 3000, 4000)];

function renderWorkbench(segments: SegmentRecord[] = SEGMENTS, issues: IssueRecord[] = []) {
  const audioRefMonitor = { get currentTime() { return 0; } };
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
  const confirmBtn = (id: string) => within(row(id)).getByRole("button", { name: "确认本段" });
  const unconfirmBtn = (id: string) => within(row(id)).getByRole("button", { name: "取消确认" });
  return { ...utils, row, confirmBtn, unconfirmBtn, audioRefMonitor };
}

function audioEl(): HTMLMediaElement {
  return document.querySelector("audio")!;
}

function expectActive(id: string) {
  const rows = document.querySelectorAll<HTMLElement>(".seg-row");
  for (const r of rows) {
    expect(r.classList.contains("active")).toBe(r.getAttribute("data-segment-id") === id);
  }
}

describe("Workbench 行内确认 / Ctrl+Enter（第 10 轮审计）", () => {
  it("点击非当前行 B 的确认：B 被确认且 active=B；A 保持未校对；不自动播放、播放头在 B 段首", () => {
    const { row, confirmBtn } = renderWorkbench();
    expectActive("seg-a"); // 初始选中第一段
    fireEvent.click(confirmBtn("seg-b"));
    // B 被确认，按钮切换为「取消确认」。
    expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();
    // active 切换为按钮所在行 B，而不是 A、也不是下一行 C。
    expectActive("seg-b");
    // 不自动播放；播放头保持原位（PRD 90a17ac：确认按钮不是定位按钮，不 seek 到 B.startMs）。
    expect(audioEl().paused).toBe(true);
    expect(audioEl().currentTime).toBe(0); // 保持原位，不跳 B.startMs，更不跳 C
    // A 未被确认。
    expect(within(row("seg-a")).getByRole("button", { name: "确认本段" })).toBeTruthy();
  });

  it("行内取消确认：操作对象 = 按钮所在行，选中目标一致，不跳下一段", () => {
    const { row, confirmBtn, unconfirmBtn } = renderWorkbench([
      makeSeg("seg-a", 1000, 2000),
      makeSeg("seg-b", 2000, 3000, "confirmed"),
      makeSeg("seg-c", 3000, 4000),
    ]);
    fireEvent.click(unconfirmBtn("seg-b")); // 撤销 B
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy(); // 回到未确认
    expectActive("seg-b"); // 选中仍是按钮所在行
    expect(audioEl().currentTime).toBe(0); // 播放头保持原位；未跳 C
    expect(within(row("seg-c")).queryByRole("button", { name: "取消确认" })).toBeNull();
    void confirmBtn;
  });

  it("Ctrl+Enter：确认当前选中段并选择/定位/聚焦下一未校对段（语义保持）", async () => {
    const { row, confirmBtn } = renderWorkbench();
    // 先用行内确认选中 B（B 确认后取消，制造「选中 B、未确认」的状态）。
    fireEvent.click(confirmBtn("seg-b"));
    fireEvent.click(within(row("seg-b")).getByRole("button", { name: "取消确认" }));
    // Ctrl+Enter：确认 B（当前选中段）并前进到 C。
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => {
      expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy(); // B 被确认
    });
    expectActive("seg-c"); // 选择下一未校对段 C
    expect(audioEl().currentTime).toBe(3); // 定位 C 段首
    await waitFor(() => {
      // 聚焦下一未校对段编辑框（以「焦点在 C 行内」判定，避免多实例 DOM 混淆）。
      expect(row("seg-c").contains(document.activeElement)).toBe(true);
    });
    expect(screen.getAllByRole("button", { name: "取消确认" })).toHaveLength(1); // 仅 B 被确认
  });
});
