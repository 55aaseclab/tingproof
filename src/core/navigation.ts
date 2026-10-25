/**
 * 导航/重定位前的保存护栏（审计 P0-2）：
 * 离开工作台或重新挂载之前必须先落盘；失败时必须留在工作台并明确提示。
 * 纯逻辑，便于自动测试（注入 SaveCoordinator 或任何等价对象）。
 */

import type { SaveState } from "../store/saveCoordinator.js";

export interface FlushableSaver {
  pendingCount: number;
  flush(): Promise<unknown>;
  state: SaveState;
}

export type NavigateGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string; failedCount: number };

export async function safeNavigate(save: FlushableSaver): Promise<NavigateGuardResult> {
  if (save.pendingCount > 0) {
    try {
      await save.flush();
    } catch {
      // flush 自身抛错（正常实现不会）：与失败状态同等对待，不放行。
      return {
        allowed: false,
        reason:
          "保存过程出现异常，未能确认全部修改已落盘。请先重试保存成功，再离开当前页面（以免丢失校对内容）。",
        failedCount: save.pendingCount,
      };
    }
  }
  if (save.state.state === "failed") {
    return {
      allowed: false,
      reason: `存在 ${save.state.state === "failed" ? save.state.failedCount : 0} 项未保存的修改：${
        save.state.state === "failed" ? save.state.message : "保存失败"
      }。请先重试保存成功，再离开当前页面（以免丢失校对内容）。`,
      failedCount: save.state.state === "failed" ? save.state.failedCount : 0,
    };
  }
  return { allowed: true };
}
