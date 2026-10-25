/**
 * 播放位置 → 选中段的订阅（审计 P0-2）。
 *
 * 关键约束：订阅只依赖稳定的 subscribeCurrentMs（usePlayer 内为 useCallback），
 * 纯 selectedId/文本变更引发的 render 不会重订阅——重订阅会在回调里立即用旧播放位置
 * 覆盖用户显式选择的段（如暂停时聚焦第二行被切回第一行）。
 * 播放真正进入某个字幕段时间范围时才接管选中（间隙保持选中，见 selection.ts 策略）。
 */

import { useEffect, useRef } from "react";
import { computePlaybackSegmentId, type SegmentLike } from "../core/selection.js";

export function usePlaybackSelection(
  subscribeCurrentMs: (cb: (ms: number) => void) => () => void,
  getSorted: () => SegmentLike[],
  updateSelected: (id: string) => void,
): void {
  const getSortedRef = useRef(getSorted);
  getSortedRef.current = getSorted;
  const updateRef = useRef(updateSelected);
  updateRef.current = updateSelected;

  useEffect(() => {
    return subscribeCurrentMs((ms) => {
      const found = computePlaybackSegmentId(getSortedRef.current(), ms);
      if (found) updateRef.current(found);
    });
  }, [subscribeCurrentMs]);
}
