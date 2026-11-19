/**
 * 列表人工滚动接管（PRD V1.0.4 列表人工滚动优先规则 + 第 8 轮审计修正）。
 *
 * 优先级模型：
 * 1. 任何明确人工输入（wheel / touchmove / 滚动键 / 原生滚动条 pointerdown）最高优先级：
 *    第一个事件立即清除程序滚动标记并触发接管（onTakeover → setFollow(false)）；
 * 2. 原生垂直滚动条/轨道的 pointerdown 可靠识别（仅容器自身命中、鼠标指针位于
 *    offsetWidth-clientWidth 的竖向滚动条区），按下即接管并进入拖动模式：
 *    拖动全过程禁止后续 scrollIntoView，滑块从按下起持续跟鼠标、不回跳；
 * 3. ArrowUp/Down、PageUp/Down、Home/End：容器或其后代聚焦且非文本编辑目标时触发接管
 *    （Ctrl/Alt/Meta 组合是段导航等业务快捷键，不触发）；
 * 4. 程序 scrollIntoView 采用“消费一次”标记：紧随其后的第一个 scroll 事件视为程序滚动，
 *    不误触接管；此后任何 scroll 都视为用户滚动——不存在会吞掉随后真实输入的时间窗；
 * 5. 正确性优先：拖动滚动条期间 beginProgrammatic 直接忽略（不再生成程序滚动）。
 */

import { useCallback, useEffect, useRef } from "react";

export interface ManualScrollOptions {
  /** 只有跟随开启时，用户滚动才需要触发接管回调（回调需幂等）。 */
  enabled: () => boolean;
  /** 首个人工滚动事件。 */
  onTakeover: () => void;
}

const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null | undefined;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || el.isContentEditable === true;
}

/** 纯函数：鼠标横坐标是否落在容器竖向滚动条区（右侧 offsetWidth-clientWidth 条带）。 */
export function isInVerticalScrollbarZone(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  scrollbarWidth: number,
): boolean {
  if (scrollbarWidth <= 0) return false;
  return clientX - rectLeft >= rectWidth - scrollbarWidth - 1;
}

export function useManualScrollTakeover(
  containerRef: React.RefObject<HTMLElement | null>,
  opts: ManualScrollOptions,
): { beginProgrammatic: (scroll: () => void) => void } {
  const enabledRef = useRef(opts.enabled);
  enabledRef.current = opts.enabled;
  const onTakeoverRef = useRef(opts.onTakeover);
  onTakeoverRef.current = opts.onTakeover;
  /** 消费一次标记：scrollIntoView 后的第一个 scroll 事件归属程序滚动。 */
  const programmaticPendingRef = useRef(false);
  /** 正在拖动原生滚动条：期间禁止一切程序滚动。 */
  const draggingScrollbarRef = useRef(false);

  const clearProgrammatic = useCallback(() => {
    programmaticPendingRef.current = false;
  }, []);

  /** 包裹程序滚动：拖动滚动条期间直接忽略；否则登记消费一次标记后执行。 */
  const beginProgrammatic = useCallback(
    (scroll: () => void) => {
      if (draggingScrollbarRef.current) return; // 拖动全过程禁止后续 scrollIntoView
      programmaticPendingRef.current = true;
      scroll();
    },
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const takeover = () => {
      if (enabledRef.current()) onTakeoverRef.current();
    };
    // 1/3/4：wheel、touchmove、滚动键 → 清除程序标记 + 接管。
    const onWheel = () => {
      clearProgrammatic();
      takeover();
    };
    const onTouchMove = () => {
      clearProgrammatic();
      takeover();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!SCROLL_KEYS.includes(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+←/→ 等为业务快捷键
      const t = e.target as HTMLElement | null;
      if (!t || !el.contains(t)) return; // 仅容器或其后代
      if (isEditableTarget(t)) return; // 文本编辑目标：箭头是光标移动，不是滚动
      clearProgrammatic();
      takeover();
    };
    // 2：原生滚动条/轨道 pointerdown（仅容器自身 + 竖向滚动条区 + 鼠标）。
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t === el || el.contains(t)) {
        // 任何列表内 pointerdown 都先清除程序标记：随后真实滚动不被吞。
        clearProgrammatic();
      }
      if (t !== el) return; // 滚动条命中只发生在容器自身（子元素是内容点击）
      const pointerType = (e as PointerEvent).pointerType;
      if (pointerType && pointerType !== "mouse") return;
      const rect = el.getBoundingClientRect();
      const scrollbarWidth = el.offsetWidth - el.clientWidth;
      if (!isInVerticalScrollbarZone(e.clientX, rect.left, rect.width, scrollbarWidth)) return;
      draggingScrollbarRef.current = true;
      takeover();
    };
    // pointerup 与 pointercancel 同样清理：防止取消手势后永久抑制程序滚动。
    const endDrag = () => {
      draggingScrollbarRef.current = false;
    };
    const onPointerUp = endDrag;
    const onPointerCancel = endDrag;
    const onScroll = () => {
      if (draggingScrollbarRef.current) {
        takeover(); // 拖动中的连续滚动：保持接管（幂等）
        return;
      }
      if (programmaticPendingRef.current) {
        programmaticPendingRef.current = false; // 消费一次：程序滚动自身的 scroll 事件
        return;
      }
      takeover(); // 其余 scroll 一律视为用户滚动
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("scroll", onScroll);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [containerRef, clearProgrammatic]);

  return { beginProgrammatic };
}
