/**
 * 播放位置 → 选中段的订阅（审计 P0-2）。
 *
 * 关键约束：订阅只依赖稳定的 subscribeCurrentMs（usePlayer 内为 useCallback），
 * 纯 selectedId/文本变更引发的 render 不会重订阅——重订阅会在回调里立即用旧播放位置
 * 覆盖用户显式选择的段（如暂停时聚焦第二行被切回第一行）。
 * 播放真正进入某个字幕段时间范围时才接管选中（间隙保持选中，见 selection.ts 策略）。
 * 同一段的重复位置通知只上报一次（避免每帧触发上游 setRange/状态 churn）。
 */

import { useEffect, useRef } from "react";
import { computePlaybackSegmentId, type SegmentLike } from "../core/selection.js";

export function usePlaybackSelection(
  subscribeCurrentMs: (cb: (ms: number) => void) => () => void,
  getSorted: () => SegmentLike[],
  onTakeover: (segmentId: string) => void,
): void {
  const getSortedRef = useRef(getSorted);
  getSortedRef.current = getSorted;
  const onTakeoverRef = useRef(onTakeover);
  onTakeoverRef.current = onTakeover;
  /** 最近一次上报的段：同段重复通知（rAF 每帧）不去打扰上游。 */
  const lastReportedRef = useRef<string | null>(null);

  useEffect(() => {
    lastReportedRef.current = null; // 重订阅后重新上报一次，保证状态一致
    return subscribeCurrentMs((ms) => {
      const found = computePlaybackSegmentId(getSortedRef.current(), ms);
      if (found && found !== lastReportedRef.current) {
        lastReportedRef.current = found;
        onTakeoverRef.current(found);
      }
    });
  }, [subscribeCurrentMs]);
}
