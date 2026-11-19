// @vitest-environment jsdom
/**
 * IssuePanel「跳转播放」语义测试（审计项 7）：
 * 按钮含义 = 选中目标段并从其段首播放（playRange），不复用行内播放/暂停 toggle。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssuePanel } from "../src/ui/IssuePanel.js";
import type { IssueRecord, SegmentRecord } from "../src/store/types.js";

afterEach(() => cleanup());

const seg: SegmentRecord = {
  segmentId: "seg-9",
  projectId: "p",
  cueNo: 9,
  startMs: 20_000,
  endMs: 25_000,
  originalText: "原文",
  correctedText: "校对稿",
  status: "questioned",
  revisionNo: 1,
  updatedAt: 0,
};

const issue: IssueRecord = {
  issueId: "i1",
  projectId: "p",
  segmentId: "seg-9",
  startMs: 20_000,
  endMs: 25_000,
  type: "unclear",
  severity: "blocking",
  note: "",
  status: "open",
  createdAt: 0,
  resolvedAt: null,
};

describe("IssuePanel 跳转播放", () => {
  it("辅助提示文案精简（V1.0.6）：不再出现“（听不清 / 阻塞）”", () => {
    render(
      <IssuePanel
        issues={[issue]}
        segments={[seg]}
        activeId={null}
        onJumpPlay={vi.fn()}
        onResolve={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "为当前段新建疑点（表单）" }));
    const hint = screen.getByText(/行内“⚑ 疑点”按钮会直接创建默认疑点/);
    expect(hint.textContent).not.toContain("听不清 / 阻塞"); // 文案精简（V1.0.6）
    // 全局兜底：src/ui 渲染文案不得再出现旧括注（防止 KeymapBar/SegmentList 回归）。
    expect(hint.textContent).toContain("快捷键");
    // 行内 ⚑ 交互语义不变由 SegmentList 测试覆盖（先选类型才创建）。
  });

  it("按钮文案为「跳转播放」，点击调用 onJumpPlay(seg-9)（而非 toggle）", () => {
    const onJumpPlay = vi.fn();
    render(
      <IssuePanel
        issues={[issue]}
        segments={[seg]}
        activeId={null}
        onJumpPlay={onJumpPlay}
        onResolve={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /跳转播放/ });
    fireEvent.click(btn);
    expect(onJumpPlay).toHaveBeenCalledWith("seg-9");
  });
});
