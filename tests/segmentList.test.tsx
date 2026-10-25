// @vitest-environment jsdom
/**
 * SegmentList 组件测试（PRD V1.0.2 §3.3.5 / AC-041 / AC-042）：
 * - 点击行非操作区域 / 聚焦 textarea → 只触发 onLocate（不触发播放）；
 * - 行内按钮文案与可访问名称动态切换（▶ 播放 / ⏸ 暂停）；
 * - 点击按钮只触发 onTogglePlay（不冒泡成行定位）；
 * - 双击时间码等价于播放/暂停开关。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentList } from "../src/ui/SegmentList.js";
import type { SegmentRecord } from "../src/store/types.js";

afterEach(() => cleanup());

function makeSeg(over: Partial<SegmentRecord> = {}): SegmentRecord {
  return {
    segmentId: "seg-1",
    projectId: "p",
    cueNo: 1,
    startMs: 1000,
    endMs: 5000,
    originalText: "原文",
    correctedText: "校对稿",
    status: "unreviewed",
    revisionNo: 1,
    updatedAt: 0,
    ...over,
  };
}

function renderList(over: {
  playingSegmentId?: string | null;
  onLocate?: ReturnType<typeof vi.fn>;
  onTogglePlay?: ReturnType<typeof vi.fn>;
} = {}) {
  const onLocate = over.onLocate ?? vi.fn();
  const onTogglePlay = over.onTogglePlay ?? vi.fn();
  const utils = render(
    <SegmentList
      segments={[makeSeg()]}
      selectedId={null}
      playingSegmentId={over.playingSegmentId ?? null}
      unresolvedBySegment={new Map()}
      loopSegmentId={null}
      onEdit={vi.fn()}
      onCompositionEnd={vi.fn()}
      onConfirmRow={vi.fn()}
      onLocate={onLocate}
      onTogglePlay={onTogglePlay}
      onLoop={vi.fn()}
      onCreateIssue={vi.fn()}
    />,
  );
  const row = utils.container.querySelector<HTMLElement>("[data-segment-id='seg-1']")!;
  return { ...utils, row, onLocate, onTogglePlay };
}

describe("SegmentList 行内交互（AC-041 / AC-042）", () => {
  it("点击行非操作区域：只触发 onLocate，不触发播放", () => {
    const { row, onLocate, onTogglePlay } = renderList();
    fireEvent.pointerDown(row);
    expect(onLocate).toHaveBeenCalledWith("seg-1");
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("聚焦校对文本框：只触发 onLocate，不触发播放", () => {
    const { onLocate, onTogglePlay } = renderList();
    fireEvent.focusIn(screen.getByRole("textbox"));
    expect(onLocate).toHaveBeenCalledWith("seg-1");
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("未播放时按钮文案与可访问名称为“播放”，点击只触发 onTogglePlay（不冒泡成定位）", () => {
    const { onLocate, onTogglePlay } = renderList();
    const btn = screen.getByRole("button", { name: "播放" });
    expect(btn.textContent).toContain("▶ 播放");
    fireEvent.click(btn);
    expect(onTogglePlay).toHaveBeenCalledWith("seg-1");
    expect(onLocate).not.toHaveBeenCalled();
  });

  it("播放中按钮变为“⏸ 暂停”，可访问名称同步为“暂停”", () => {
    renderList({ playingSegmentId: "seg-1" });
    const btn = screen.getByRole("button", { name: "暂停" });
    expect(btn.textContent).toContain("⏸ 暂停");
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();
  });

  it("双击时间码：等价于该行播放/暂停开关", () => {
    const { onTogglePlay, onLocate } = renderList();
    fireEvent.doubleClick(screen.getByTitle("双击 = 该段播放/暂停开关"));
    expect(onTogglePlay).toHaveBeenCalledWith("seg-1");
    expect(onLocate).not.toHaveBeenCalled();
  });

  it("真实双击事件序列（两轮 pointerdown/click + dblclick）：不触发行定位，toggle 只执行一次（审计项 2）", () => {
    const { onTogglePlay, onLocate } = renderList();
    const time = screen.getByTitle("双击 = 该段播放/暂停开关");
    // 浏览器真实双击序列：pointerdown → click → pointerdown → click → dblclick。
    fireEvent.pointerDown(time);
    fireEvent.click(time);
    fireEvent.pointerDown(time);
    fireEvent.click(time);
    fireEvent.doubleClick(time);
    expect(onLocate).not.toHaveBeenCalled(); // 时间码是操作区：前置事件不得触发行定位
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("循环标记按真实 loop range 显示（loopSegmentId 反查）", () => {
    render(
      <SegmentList
        segments={[makeSeg()]}
        selectedId={null}
        playingSegmentId={null}
        unresolvedBySegment={new Map()}
        loopSegmentId="seg-1"
        onEdit={vi.fn()}
        onCompositionEnd={vi.fn()}
        onConfirmRow={vi.fn()}
        onLocate={vi.fn()}
        onTogglePlay={vi.fn()}
        onLoop={vi.fn()}
        onCreateIssue={vi.fn()}
      />,
    );
    expect(screen.getByText("⭯ 循环中")).toBeTruthy();
  });
});
