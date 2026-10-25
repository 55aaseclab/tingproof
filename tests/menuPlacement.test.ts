/**
 * 行内疑点菜单碰撞感知定位（第 9 轮审计，纯函数）。
 * 靠近底部 → 向上；正常位置 → 向下；两侧都不足 → 钳制进容器∩视口；水平钳制。
 */
import { describe, expect, it } from "vitest";
import { computeMenuPosition } from "../src/core/menuPlacement.js";

const CONTAINER = { top: 92, bottom: 613, left: 0, right: 800 };
const VIEWPORT = { top: 0, bottom: 880, left: 0, right: 1400 };
const MENU = { width: 176, height: 274 };

function base(trigger: { top: number; bottom: number; left: number; right: number }) {
  return { trigger, menu: MENU, container: CONTAINER, viewport: VIEWPORT };
}

describe("computeMenuPosition（审计：底部碰撞）", () => {
  it("正常位置：向下展开，顶部 = trigger.bottom + gap", () => {
    const r = computeMenuPosition(base({ top: 200, bottom: 230, left: 300, right: 360 }));
    expect(r.placement).toBe("down");
    expect(r.top).toBe(234);
    expect(r.left).toBe(300);
  });

  it("靠近底部（下方空间不足、上方充足）：向上展开且完整落在容器可视区内", () => {
    const r = computeMenuPosition(base({ top: 560, bottom: 590, left: 300, right: 360 }));
    expect(r.placement).toBe("up");
    expect(r.top).toBe(560 - 4 - MENU.height); // trigger.top - gap - menu.height
    expect(r.top).toBeGreaterThanOrEqual(CONTAINER.top);
    expect(r.top + MENU.height).toBeLessThanOrEqual(CONTAINER.bottom);
  });

  it("贴近容器底边（两侧都不足）：钳制进容器可视区，不再向下溢出", () => {
    // trigger 底边几乎贴着容器 bottom=613：向下 613+4+274 远超容器；向上也只有 4px。
    const r = computeMenuPosition(base({ top: 608, bottom: 612, left: 300, right: 360 }));
    expect(r.placement).toBe("up"); // 上方空间更大时选上
    expect(r.top + MENU.height).toBeLessThanOrEqual(CONTAINER.bottom); // 完整落在可视区内
    expect(r.top).toBeGreaterThanOrEqual(CONTAINER.top);
  });

  it("水平方向：右缘钳制进容器/视口", () => {
    const r = computeMenuPosition(base({ top: 200, bottom: 230, left: 780, right: 830 }));
    expect(r.left + MENU.width).toBeLessThanOrEqual(CONTAINER.right);
  });
});
