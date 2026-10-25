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

describe("新建疑点表单：类型复位（PRD V1.0.3）", () => {
  function renderPanel(onCreate = vi.fn()) {
    render(
      <IssuePanel
        issues={[issue]}
        segments={[seg]}
        activeId="seg-9"
        onJumpPlay={vi.fn()}
        onResolve={vi.fn()}
        onDelete={vi.fn()}
        onCreate={onCreate}
      />,
    );
    const openBtn = () => screen.getByRole("button", { name: "为当前段新建疑点（表单）" });
    const typeSelect = () => screen.getByLabelText("疑点类型") as HTMLSelectElement;
    return { openBtn, typeSelect, onCreate };
  }

  it("改选其他类型后取消，再次新建恢复为听不清", () => {
    const { openBtn, typeSelect } = renderPanel();
    fireEvent.click(openBtn());
    expect(typeSelect().value).toBe("unclear"); // 初始默认
    fireEvent.change(typeSelect(), { target: { value: "proper_noun" } }); // 改选专名
    expect(typeSelect().value).toBe("proper_noun");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(openBtn()); // 再次新建
    expect(typeSelect().value).toBe("unclear"); // 必须复位，不得沿用专名
  });

  it("改选其他类型并保存，再次新建恢复为听不清", () => {
    const onCreate = vi.fn();
    const { openBtn, typeSelect } = renderPanel(onCreate);
    fireEvent.click(openBtn());
    fireEvent.change(typeSelect(), { target: { value: "number" } }); // 改选数字
    fireEvent.click(screen.getByRole("button", { name: "保存疑点" }));
    expect(onCreate).toHaveBeenCalledWith("seg-9", "number", "blocking", "");
    expect(screen.queryByLabelText("疑点类型")).toBeNull(); // 表单已关闭
    fireEvent.click(openBtn()); // 再次新建
    expect(typeSelect().value).toBe("unclear"); // 必须复位，不得沿用数字
  });
});
