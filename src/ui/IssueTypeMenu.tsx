/**
 * 行内疑点类型选择层：position:fixed + portal 到 body。
 * - 碰撞感知定位（menuPlacement.ts）：默认向下，底部空间不足向上，钳制进 .wb-list 可视区；
 * - fixed + portal 保证菜单完全不参与列表滚动几何：不改变 scrollHeight/scrollTop；
 * - 滚动列表或调整窗口尺寸时关闭（与原生下拉一致），避免菜单脱离触发按钮；
 * - Esc / 点击外部 / 再次点击按钮：仅关闭，不创建。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeMenuPosition, type MenuPlacement } from "../core/menuPlacement.js";
import { ISSUE_TYPE_LABEL, type IssueType } from "../store/types.js";

const ALL_ISSUE_TYPES = Object.keys(ISSUE_TYPE_LABEL) as IssueType[];

export function IssueTypeMenu({
  segmentId,
  triggerEl,
  onPick,
  onClose,
}: {
  segmentId: string;
  /** 触发按钮元素（用于定位与滚动容器探测）。 */
  triggerEl: HTMLElement | null;
  onPick: (type: IssueType) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!triggerEl || !menu) return;
    const container = triggerEl.closest(".wb-list");
    const triggerRect = triggerEl.getBoundingClientRect();
    const menuRect = { width: menu.offsetWidth, height: menu.offsetHeight };
    const containerRect = container
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    const pos = computeMenuPosition({
      trigger: {
        top: triggerRect.top,
        bottom: triggerRect.bottom,
        left: triggerRect.left,
        right: triggerRect.right,
      },
      menu: menuRect,
      container: {
        top: containerRect.top,
        bottom: containerRect.bottom,
        left: containerRect.left,
        right: containerRect.right,
      },
      viewport: { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth },
    });
    setPlacement(pos);
  }, [triggerEl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // 捕获阶段：点击菜单/触发器以外区域仅关闭、绝不创建。
    const onPointer = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest(".type-menu") || t.closest(`[data-issue-trigger="${segmentId}"]`))) return;
      onClose();
    };
    // 滚动列表 / 调整窗口：关闭菜单（fixed 菜单会脱离按钮位置）。
    const scroller = triggerEl?.closest(".wb-list");
    const onScroll = () => onClose();
    const onResize = () => onClose();
    scroller?.addEventListener("scroll", onScroll);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [segmentId, triggerEl, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="type-menu"
      role="menu"
      aria-label="选择疑点类型"
      data-type-menu={segmentId}
      data-placement={placement?.placement ?? ""}
      style={
        placement
          ? { left: placement.left, top: placement.top, position: "fixed" }
          : { position: "fixed", visibility: "hidden", left: 0, top: 0 }
      }
    >
      <div className="type-menu-title">选择疑点类型</div>
      {ALL_ISSUE_TYPES.map((type) => (
        <button key={type} role="menuitem" className="type-menu-item" onClick={() => onPick(type)}>
          {ISSUE_TYPE_LABEL[type]}
        </button>
      ))}
    </div>,
    document.body,
  );
}
