// @vitest-environment jsdom
/**
 * 人工滚动接管测试（PRD V1.0.4 AC-046 + 第 8 轮审计）：
 * - wheel/touchmove/滚动键/滚动条 pointerdown：第一个事件立即接管并清除程序标记；
 * - 程序滚动“消费一次”：第一个 scroll 归程序，其后任何 scroll 都是用户滚动；
 * - 程序滚动刚发生后，立即的滚动条拖动 / 键盘滚动 / wheel / touchmove 都必须接管；
 * - 滚动条拖动全过程禁止后续 scrollIntoView（beginProgrammatic no-op）；
 * - 列表内容普通点击不误判为滚动接管；
 * - 竖向滚动条区命中为纯函数可测（含零宽/越界边界）。
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import {
  isInVerticalScrollbarZone,
  useManualScrollTakeover,
} from "../src/ui/useManualScroll.js";

afterEach(() => {
  document.body.innerHTML = "";
});
beforeEach(() => {
  vi.restoreAllMocks();
});

function Harness({
  enabled = true,
  onTakeover,
  onProgrammatic = vi.fn(),
}: {
  enabled?: boolean;
  onTakeover: () => void;
  onProgrammatic?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { beginProgrammatic } = useManualScrollTakeover(ref, {
    enabled: () => enabled,
    onTakeover,
  });
  return (
    <div ref={ref} data-testid="list" style={{ width: 100, height: 100, overflowY: "scroll" }}>
      <button data-testid="prog" onClick={() => beginProgrammatic(onProgrammatic)}>
        programmatic
      </button>
      <div data-testid="child">内容</div>
      <textarea data-testid="editor" aria-label="编辑器" />
    </div>
  );
}

/** 把容器装扮成带竖向滚动条的真实元素（jsdom 无布局，手动给出几何量）。 */
function dressScrollbar(el: HTMLElement, clientX = 0) {
  Object.defineProperty(el, "offsetWidth", { value: 900, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 883, configurable: true });
  el.getBoundingClientRect = () =>
    ({ left: clientX, width: 900, top: 0, height: 500 }) as DOMRect;
  return el;
}

function firePointerDown(target: EventTarget, clientX: number) {
  // jsdom 无 PointerEvent：用携带坐标的 MouseEvent 派发 pointerdown。
  const e = new MouseEvent("pointerdown", { bubbles: true, clientX });
  (e as unknown as { pointerType: string }).pointerType = "mouse";
  target.dispatchEvent(e);
}

describe("isInVerticalScrollbarZone（纯函数）", () => {
  it("右侧滚动条区命中；内容区与零宽不命中", () => {
    // 900 宽、17px 滚动条：条带 = [883-1, 900]
    expect(isInVerticalScrollbarZone(890, 0, 900, 17)).toBe(true);
    expect(isInVerticalScrollbarZone(500, 0, 900, 17)).toBe(false); // 内容普通点击
    expect(isInVerticalScrollbarZone(890, 0, 900, 0)).toBe(false); // 无滚动条
  });
});

describe("useManualScrollTakeover（AC-046 + 第 8 轮审计）", () => {
  it("wheel / touchmove / scroll 首个事件立即接管", () => {
    const onTakeover = vi.fn();
    const { getByTestId } = render(<Harness enabled onTakeover={onTakeover} />);
    const list = getByTestId("list");
    fireEvent.wheel(list);
    expect(onTakeover).toHaveBeenCalledTimes(1);
    fireEvent.touchMove(list);
    expect(onTakeover).toHaveBeenCalledTimes(2);
    fireEvent.scroll(list);
    expect(onTakeover).toHaveBeenCalledTimes(3);
  });

  it("程序滚动消费一次：第一个 scroll 归程序，第二个 scroll 视为用户滚动", () => {
    const onTakeover = vi.fn();
    const onProgrammatic = vi.fn();
    const { getByTestId } = render(
      <Harness enabled onTakeover={onTakeover} onProgrammatic={onProgrammatic} />,
    );
    fireEvent.click(getByTestId("prog")); // beginProgrammatic
    expect(onProgrammatic).toHaveBeenCalledTimes(1);
    fireEvent.scroll(getByTestId("list"));
    expect(onTakeover).not.toHaveBeenCalled(); // 程序滚动自身的 scroll 事件
    fireEvent.scroll(getByTestId("list"));
    expect(onTakeover).toHaveBeenCalledTimes(1); // 其后任何 scroll 都是用户滚动
  });

  it("程序滚动刚发生后，立即 wheel 接管：随后的 scroll 不会被吞", () => {
    const onTakeover = vi.fn();
    const { getByTestId } = render(<Harness enabled onTakeover={onTakeover} />);
    fireEvent.click(getByTestId("prog"));
    fireEvent.wheel(getByTestId("list")); // 明确人工输入：清除程序标记并接管
    expect(onTakeover).toHaveBeenCalledTimes(1);
    fireEvent.scroll(getByTestId("list"));
    expect(onTakeover).toHaveBeenCalledTimes(2); // 不被时间窗吞掉
  });

  it("程序滚动刚发生后，立即 touchmove 接管", () => {
    const onTakeover = vi.fn();
    const { getByTestId } = render(<Harness enabled onTakeover={onTakeover} />);
    fireEvent.click(getByTestId("prog"));
    fireEvent.touchMove(getByTestId("list"));
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("程序滚动刚发生后，立即滚动条 pointerdown + scroll：接管且拖动期间禁止 scrollIntoView", () => {
    const onTakeover = vi.fn();
    const onProgrammatic = vi.fn();
    const { getByTestId } = render(
      <Harness enabled onTakeover={onTakeover} onProgrammatic={onProgrammatic} />,
    );
    const list = getByTestId("list");
    dressScrollbar(list);
    fireEvent.click(getByTestId("prog")); // 程序滚动刚发生
    firePointerDown(list, 890); // 用户立即按下竖向滚动条（条带区）
    expect(onTakeover).toHaveBeenCalledTimes(1);
    // 拖动过程：连续 scroll 全部接管；beginProgrammatic 被忽略（不再生成程序滚动）。
    const before = onProgrammatic.mock.calls.length;
    fireEvent.click(getByTestId("prog"));
    expect(onProgrammatic.mock.calls.length).toBe(before); // 拖动期间禁止 scrollIntoView
    firePointerDown(document.body, 0); // pointerup 前用外部事件不会结束拖动（pointerup 才结束）
    const up = new MouseEvent("pointerup", { bubbles: true });
    window.dispatchEvent(up);
  });

  it("滚动条拖动结束（pointerup）后恢复常规规则", () => {
    const onTakeover = vi.fn();
    const onProgrammatic = vi.fn();
    const { getByTestId } = render(
      <Harness enabled onTakeover={onTakeover} onProgrammatic={onProgrammatic} />,
    );
    const list = getByTestId("list");
    dressScrollbar(list);
    firePointerDown(list, 890);
    expect(onTakeover).toHaveBeenCalledTimes(1); // 按下滚动条即接管
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); // 拖动结束
    fireEvent.click(getByTestId("prog")); // 结束后程序滚动恢复正常（消费一次）
    expect(onProgrammatic).toHaveBeenCalledTimes(1);
    fireEvent.scroll(list);
    expect(onTakeover).toHaveBeenCalledTimes(1); // 程序滚动自身不额外接管
    fireEvent.scroll(list);
    expect(onTakeover).toHaveBeenCalledTimes(2); // 其后 scroll 属用户
  });

  it("pointercancel 与 pointerup 相同清理：取消手势后不再抑制程序滚动（第 9 轮审计）", () => {
    const onTakeover = vi.fn();
    const onProgrammatic = vi.fn();
    const { getByTestId } = render(
      <Harness enabled onTakeover={onTakeover} onProgrammatic={onProgrammatic} />,
    );
    const list = getByTestId("list");
    dressScrollbar(list);
    firePointerDown(list, 890); // 拖动开始
    fireEvent.click(getByTestId("prog"));
    expect(onProgrammatic).not.toHaveBeenCalled(); // 拖动中禁止 scrollIntoView
    window.dispatchEvent(new Event("pointercancel")); // 取消手势
    fireEvent.click(getByTestId("prog"));
    expect(onProgrammatic).toHaveBeenCalledTimes(1); // 清理后程序滚动恢复
  });

  it("列表内容普通点击不误判为滚动接管（但清除程序标记，随后 scroll 接管）", () => {
    const onTakeover = vi.fn();
    const { getByTestId } = render(<Harness enabled onTakeover={onTakeover} />);
    const list = getByTestId("list");
    fireEvent.click(getByTestId("prog"));
    firePointerDown(getByTestId("child"), 100); // 内容点击：非滚动条
    expect(onTakeover).not.toHaveBeenCalled();
    fireEvent.scroll(list); // 标记已被内容 pointerdown 清除 → 该 scroll 属用户
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("滚动键：焦点在容器后代（非编辑目标）时接管；textarea 内不接管（审计项 3）", () => {
    const onTakeover = vi.fn();
    const { getByTestId } = render(<Harness enabled onTakeover={onTakeover} />);
    const list = getByTestId("list");
    const child = getByTestId("child");
    const editor = getByTestId("editor");
    // 聚焦后代并用带 target 的事件冒泡到 window。
    const press = (target: Element, key: string, mods: Record<string, boolean> = {}) => {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, ...mods });
      Object.defineProperty(e, "target", { value: target });
      window.dispatchEvent(e);
    };
    press(child, "ArrowDown");
    expect(onTakeover).toHaveBeenCalledTimes(1);
    press(child, "PageUp");
    expect(onTakeover).toHaveBeenCalledTimes(2);
    press(editor, "ArrowDown"); // textarea 内：光标移动，不接管
    expect(onTakeover).toHaveBeenCalledTimes(2);
    press(child, "ArrowDown", { ctrlKey: true }); // 业务快捷键，不接管
    expect(onTakeover).toHaveBeenCalledTimes(2);
    press(document.body, "ArrowDown"); // 焦点在容器外：不接管
    expect(onTakeover).toHaveBeenCalledTimes(2);
    void list;
  });
});
