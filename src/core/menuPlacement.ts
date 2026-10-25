/**
 * 行内疑点类型选择层的碰撞感知定位（第 9 轮审计，纯函数）。
 *
 * 规则：
 * - 默认向下展开；下方空间不足且上方更合适时向上展开；
 * - 两侧都不足时选择剩余空间更大的一侧，并把菜单元钳制进
 *   「容器可视区 ∩ 视口」内（菜单以 position:fixed 渲染，不改变列表 scrollHeight/scrollTop）；
 * - 水平方向贴近触发按钮左缘，右缘钳制进容器/视口。
 */

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  placement: "down" | "up";
}

export interface MenuPlacementInput {
  trigger: RectLike;
  menu: { width: number; height: number };
  /** 滚动容器（.wb-list）的可视区。 */
  container: RectLike;
  /** 浏览器视口。 */
  viewport: { top: number; bottom: number; left: number; right: number };
  /** 菜单与触发按钮的间距。 */
  gap?: number;
}

export const MENU_GAP = 4;
const EDGE_MARGIN = 2;

export function computeMenuPosition(input: MenuPlacementInput): MenuPlacement {
  const gap = input.gap ?? MENU_GAP;
  const { trigger, menu, container, viewport } = input;

  const boundsTop = Math.max(container.top, viewport.top) + EDGE_MARGIN;
  const boundsBottom = Math.min(container.bottom, viewport.bottom) - EDGE_MARGIN;
  const boundsRight = Math.min(container.right, viewport.right) - EDGE_MARGIN;

  const downTop = trigger.bottom + gap;
  const fitsDown = downTop + menu.height <= boundsBottom;
  const upTop = trigger.top - gap - menu.height;
  const fitsUp = upTop >= boundsTop;

  let placement: "down" | "up";
  if (fitsDown || (!fitsDown && !fitsUp && container.bottom - trigger.bottom >= trigger.top - container.top)) {
    placement = "down";
  } else {
    placement = "up";
  }

  let top = placement === "down" ? downTop : upTop;
  // 钳制进容器可视区（两侧都不足时强制收进边界内）。
  const maxTop = Math.max(boundsTop, boundsBottom - menu.height);
  top = Math.min(Math.max(top, boundsTop), maxTop);

  const left = Math.min(trigger.left, Math.max(boundsTop >= 0 ? container.left : 0, boundsRight - menu.width));

  return { left, top, placement };
}
