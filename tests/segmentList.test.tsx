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
  segments?: SegmentRecord[];
  selectedId?: string | null;
  onLocate?: ReturnType<typeof vi.fn>;
  onTogglePlay?: ReturnType<typeof vi.fn>;
  onConfirmRow?: ReturnType<typeof vi.fn>;
  onUnconfirmRow?: ReturnType<typeof vi.fn>;
  onCreateIssueWithType?: ReturnType<typeof vi.fn>;
} = {}) {
  const onLocate = over.onLocate ?? vi.fn();
  const onTogglePlay = over.onTogglePlay ?? vi.fn();
  const onConfirmRow = over.onConfirmRow ?? vi.fn();
  const onUnconfirmRow = over.onUnconfirmRow ?? vi.fn();
  const onCreateIssueWithType = over.onCreateIssueWithType ?? vi.fn();
  const utils = render(
    <div className="wb-list" data-testid="wblist">
    <SegmentList
      segments={over.segments ?? [makeSeg()]}
      selectedId={over.selectedId ?? null}
      playingSegmentId={over.playingSegmentId ?? null}
      unresolvedBySegment={new Map()}
      loopSegmentId={null}
      onEdit={vi.fn()}
      onCompositionEnd={vi.fn()}
      onConfirmRow={onConfirmRow}
      onUnconfirmRow={onUnconfirmRow}
      onLocate={onLocate}
      onTogglePlay={onTogglePlay}
      onLoop={vi.fn()}
      onCreateIssueWithType={onCreateIssueWithType}
    />
    </div>,
  );
  const row = utils.container.querySelector<HTMLElement>("[data-segment-id='seg-1']")!;
  return { ...utils, row, onLocate, onTogglePlay, onConfirmRow, onUnconfirmRow, onCreateIssueWithType };
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

  it("正常位置菜单向下展开（data-placement=down）且定位贴近触发按钮", () => {
    const { container, getByRole } = renderList();
    const list = container.querySelector<HTMLElement>(".wb-list")!;
    list.getBoundingClientRect = () =>
      ({ top: 92, bottom: 613, left: 0, right: 800, width: 800, height: 521 }) as DOMRect;
    const trigger = getByRole("button", { name: "⚑ 疑点" });
    trigger.getBoundingClientRect = () =>
      ({ top: 200, bottom: 230, left: 300, right: 360, width: 60, height: 30 }) as DOMRect;
    fireEvent.click(trigger);
    const menu = document.body.querySelector<HTMLElement>(".type-menu")!;
    expect(menu.getAttribute("data-placement")).toBe("down");
    expect(menu.style.position).toBe("fixed"); // portal+fixed：不参与列表滚动几何
  });

  it("靠近底部时菜单向上展开（data-placement=up，可控几何）", () => {
    const { container, getByRole } = renderList();
    const list = container.querySelector<HTMLElement>(".wb-list")!;
    list.getBoundingClientRect = () =>
      ({ top: 92, bottom: 613, left: 0, right: 800, width: 800, height: 521 }) as DOMRect;
    const trigger = getByRole("button", { name: "⚑ 疑点" });
    trigger.getBoundingClientRect = () =>
      ({ top: 560, bottom: 590, left: 300, right: 360, width: 60, height: 30 }) as DOMRect;
    // jsdom offsetHeight=0 会让 274px 高度假设失效：给菜单元素手动几何。
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === "div") {
        Object.defineProperty(el, "offsetHeight", { value: 274, configurable: true });
        Object.defineProperty(el, "offsetWidth", { value: 176, configurable: true });
      }
      return el;
    }) as typeof document.createElement);
    fireEvent.click(trigger);
    const menu = document.body.querySelector<HTMLElement>(".type-menu")!;
    expect(menu.getAttribute("data-placement")).toBe("up");
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
        onUnconfirmRow={vi.fn()}
        onLocate={vi.fn()}
        onTogglePlay={vi.fn()}
        onLoop={vi.fn()}
        onCreateIssueWithType={vi.fn()}
      />,
    );
    expect(screen.getByText("⭯ 循环中")).toBeTruthy();
  });
});


describe("行内疑点类型选择层（PRD V1.0.4 AC-044）", () => {
  it("点击 ⚑ 只展开选择层：8 类菜单项、无预选、不创建记录、aria-expanded 同步", () => {
    const { onCreateIssueWithType } = renderList();
    const trigger = screen.getByRole("button", { name: "⚑ 疑点" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(8); // 全部 8 种类型
    expect(screen.queryByRole("menuitem", { name: "听不清", selected: undefined })).toBeTruthy();
    expect(onCreateIssueWithType).not.toHaveBeenCalled(); // 未选择前绝不创建
  });

  it("点击类型后才创建且仅创建一条：所选类型 + blocking，随后关闭", () => {
    const { onCreateIssueWithType } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "⚑ 疑点" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "专名" }));
    expect(onCreateIssueWithType).toHaveBeenCalledTimes(1);
    expect(onCreateIssueWithType).toHaveBeenCalledWith("seg-1", "proper_noun");
    expect(screen.queryByRole("menu")).toBeNull(); // 已关闭
  });

  it("再次点击同一 ⚑ 按钮：只关闭，不创建", () => {
    const { onCreateIssueWithType } = renderList();
    const trigger = screen.getByRole("button", { name: "⚑ 疑点" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCreateIssueWithType).not.toHaveBeenCalled();
  });

  it("Esc 关闭且不创建", () => {
    const { onCreateIssueWithType } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "⚑ 疑点" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCreateIssueWithType).not.toHaveBeenCalled();
  });

  it("点击外部关闭且不创建", () => {
    const { onCreateIssueWithType } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "⚑ 疑点" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCreateIssueWithType).not.toHaveBeenCalled();
  });

  it("同一时间最多一个选择层：打开第二行时第一行关闭", () => {
    const segments = [makeSeg(), makeSeg({ segmentId: "seg-2", startMs: 6000, endMs: 9000 })];
    render(
      <SegmentList
        segments={segments}
        selectedId={null}
        playingSegmentId={null}
        unresolvedBySegment={new Map()}
        loopSegmentId={null}
        onEdit={vi.fn()}
        onCompositionEnd={vi.fn()}
        onConfirmRow={vi.fn()}
        onUnconfirmRow={vi.fn()}
        onLocate={vi.fn()}
        onTogglePlay={vi.fn()}
        onLoop={vi.fn()}
        onCreateIssueWithType={vi.fn()}
      />,
    );
    const triggers = screen.getAllByRole("button", { name: "⚑ 疑点" });
    fireEvent.click(triggers[0]);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.click(triggers[1]);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    const menus = document.body.querySelectorAll(".type-menu"); // 菜单经 portal 渲染在 body
    expect(menus).toHaveLength(1);
    expect(menus[0].getAttribute("data-type-menu")).toBe("seg-2");
  });

  it("菜单经 portal 渲染在 .wb-list 之外：开关不改变容器 scrollHeight/scrollTop（第 9 轮审计）", () => {
    const { container, getByRole } = renderList();
    const list = container.querySelector(".wb-list");
    expect(list).toBeTruthy();
    const before = { sh: (list as HTMLElement).scrollHeight, st: (list as HTMLElement).scrollTop };
    fireEvent.click(getByRole("button", { name: "⚑ 疑点" }));
    const menu = document.body.querySelector(".type-menu")!;
    expect(menu).toBeTruthy();
    expect((menu as HTMLElement).parentElement).toBe(document.body); // 不在 .wb-list 内
    expect((list as HTMLElement).scrollHeight).toBe(before.sh);
    expect((list as HTMLElement).scrollTop).toBe(before.st);
    fireEvent.click(getByRole("button", { name: "⚑ 疑点" })); // 再点关闭
    expect(document.body.querySelector(".type-menu")).toBeNull();
    expect((list as HTMLElement).scrollHeight).toBe(before.sh);
  });

  it("⚑ 按钮与类型菜单不冒泡成行定位，不触发播放", () => {
    const { onLocate, onTogglePlay } = renderList();
    const trigger = screen.getByRole("button", { name: "⚑ 疑点" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "断句" }));
    expect(onLocate).not.toHaveBeenCalled();
    expect(onTogglePlay).not.toHaveBeenCalled();
  });
});

describe("行内确认/撤销确认（PRD V1.0.4 AC-045）", () => {
  it("未确认段：按钮为「✓ 确认本段」，点击调用 onConfirmRow", () => {
    const { onConfirmRow, onUnconfirmRow } = renderList();
    const btn = screen.getByRole("button", { name: "确认本段" });
    expect(btn.textContent).toContain("✓ 确认本段");
    fireEvent.click(btn);
    expect(onConfirmRow).toHaveBeenCalledWith("seg-1");
    expect(onUnconfirmRow).not.toHaveBeenCalled();
  });

  it("已确认段：按钮变为「↶ 取消确认」（可达名称同步），点击调用 onUnconfirmRow", () => {
    const { onConfirmRow, onUnconfirmRow } = renderList({
      segments: [makeSeg({ status: "confirmed" })],
      selectedId: "seg-1",
    });
    const btn = screen.getByRole("button", { name: "取消确认" });
    expect(btn.textContent).toContain("↶ 取消确认");
    fireEvent.click(btn);
    expect(onUnconfirmRow).toHaveBeenCalledWith("seg-1");
    expect(onConfirmRow).not.toHaveBeenCalled();
  });
});
