/**
 * 周期性持久化（审计 P0-3）。
 *
 * 关键约束：interval 只创建一次（依赖仅 intervalMs），
 * shouldRun/run 经 ref 读取最新值——任何无关 UI render（如播放进入新字幕段
 * 触发选中变化）都不会重置计时；连续播放满 intervalMs 必定触发持久化。
 */

import { useEffect, useRef } from "react";

export function usePeriodicPersist(
  shouldRun: () => boolean,
  run: () => void,
  intervalMs: number,
): void {
  const shouldRunRef = useRef(shouldRun);
  shouldRunRef.current = shouldRun;
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const t = setInterval(() => {
      if (shouldRunRef.current()) runRef.current();
    }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}
