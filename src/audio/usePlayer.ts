/**
 * 播放引擎：包装 HTMLAudioElement（PRD docs/听校_PRD_V1.0.0.md V1.0.2 §3.2.5）。
 *
 * - 活动播放范围（range）= 当前选中段 [start_ms, end_ms)：普通播放只允许当前段；
 * - 到 end_ms 立即暂停并把位置稳定在段尾，绝不串入下一段（rAF 主检测 + timeupdate 兜底；
 *   段尾分支暂停后不再继续排帧）；
 * - 循环（loop region）是唯一「段尾回段首继续」的模式，且仅当 region 与当前段一致时生效；
 *   换段时旧 loop 自动安全解除；
 * - 行内按钮/F8 共用 toggleRange：播放中点击 → 暂停在当前位置（不回段首）；
 *   同段段内恢复 → 自动回退且不早于段首；换段、段尾或段外 → 从段首开始；
 * - F7/F9（skip）与播放中 seek 钳制/受限于当前段；
 * - 快捷键本身（F7/F8/F9）沿用 V1.0.0，本引擎只改变这些命令作用的范围；
 * - 变速不变调；播放位置经订阅分发（rAF 驱动）。
 *
 * 所有增强只作用于播放，不修改源音频（浏览器仅读取本地文件）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { clampMs } from "../core/time.js";
import { applyPlaybackPreferences } from "../core/audioPrefs.js";
import {
  clampSkipToScope,
  normalizeRange,
  resolvePlayTarget,
  sameRange,
  tickAction,
  type PlaybackRange,
} from "../core/segmentPlayback.js";

export interface LoopRegion {
  startMs: number;
  endMs: number;
}

export interface PlayerApi {
  playing: boolean;
  durationMs: number;
  speed: number;
  autoRewindMs: number;
  /** 当前活动播放范围（= 当前选中段）。 */
  range: PlaybackRange | null;
  /** 循环 region；仅当与 range 一致时在段尾回段首继续。 */
  loop: LoopRegion | null;
  setSpeed: (rate: number) => void;
  setAutoRewindMs: (ms: number) => void;
  /** 设置活动播放范围；换段时解除不匹配的旧 loop，并暂停越界中的旧段播放。 */
  setRange: (range: PlaybackRange | null) => void;
  /** 针对给定段开/关循环 region。 */
  loopSegment: (startMs: number, endMs: number) => void;
  /**
   * 范围感知播放/暂停开关（行内按钮、F8 共用）：
   * 正在播放该范围 → 暂停在当前位置（不回段首）；
   * 否则 → 设为活动范围并按段内恢复/段尾/段外规则起播。
   */
  toggleRange: (range: PlaybackRange) => void;
  /** 显式“从目标段段首播放”（如疑点面板「跳转播放」）：无论此前状态如何都定位 start_ms 并播放。 */
  playRange: (range: PlaybackRange) => void;
  /** 暂停并记录恢复点。 */
  pause: () => void;
  /**
   * V1.1.4 编辑打断精确续播（AC-067）：当前段正在播放时聚焦其校对文本框调用——
   * 在精确打断位置暂停（不 seek、不回段首），并记录一次性续播点；
   * 下一次对同一段播放从该位置继续且本次不应用自动回退，成功起播即消费。
   * seek / ±2s / 换段 / 段尾 / 循环开关 / 主动暂停等动作都会清除该标记。
   */
  pauseForEdit: () => void;
  /** 显式清除编辑打断续播点（如段落数据被外部更新）。 */
  clearEditResume: () => void;
  seek: (ms: number) => void;
  skip: (deltaMs: number) => void;
  getCurrentMs: () => number;
  subscribeCurrentMs: (cb: (ms: number) => void) => () => void;
}

interface PausedPoint {
  ms: number;
  range: PlaybackRange | null;
}

export function usePlayer(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  opts: {
    initialPositionMs?: number;
    initialSpeed?: number;
    initialAutoRewindMs?: number;
    onDuration?: (durationMs: number) => void;
    onPauseChange?: (playing: boolean, positionMs: number) => void;
  } = {},
): PlayerApi {
  const [playing, setPlaying] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeedState] = useState(opts.initialSpeed ?? 1);
  const [autoRewindMs, setAutoRewindMsState] = useState(opts.initialAutoRewindMs ?? 1500);
  const [range, setRangeState] = useState<PlaybackRange | null>(null);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);

  /** 暂停点：位置 + 所属范围（换段后旧暂停点失效）。 */
  const pausedRef = useRef<PausedPoint | null>(null);
  const seekedSincePauseRef = useRef(false);
  /** V1.1.4 编辑打断续播点：一次性消费；范围不匹配（含时间轴变化）自动失效。 */
  const interruptResumeRef = useRef<{ ms: number; range: PlaybackRange } | null>(null);
  const rangeRef = useRef<PlaybackRange | null>(null);
  const loopRef = useRef<LoopRegion | null>(null);
  const listenersRef = useRef(new Set<(ms: number) => void>());
  const rafRef = useRef<number | null>(null);
  const autoRewindRef = useRef(autoRewindMs);
  const onDurationRef = useRef(opts.onDuration);
  const onPauseChangeRef = useRef(opts.onPauseChange);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  autoRewindRef.current = autoRewindMs;
  onDurationRef.current = opts.onDuration;
  onPauseChangeRef.current = opts.onPauseChange;

  const notify = useCallback((ms: number) => {
    for (const cb of listenersRef.current) cb(ms);
  }, []);

  /**
   * 段尾强制：到/越过 end_ms 时按模式处理。
   * 返回 "pause"（已暂停，调用方不得继续排帧）或 "restart"（已回段首，必须继续排帧）
   * 或 "none"（未到段尾）。
   */
  const enforceRangeEnd = useCallback((): "pause" | "restart" | "none" => {
    const a = audioRef.current;
    if (!a || a.paused) return "none";
    const t = clampMs(a.currentTime * 1000);
    const r = rangeRef.current;
    const action = tickAction(t, r, loopRef.current);
    if (action.kind === "pauseAtEnd" && r) {
      a.currentTime = r.endMs / 1000; // 稳定停在段尾
      pausedRef.current = { ms: r.endMs, range: r };
      interruptResumeRef.current = null; // 到达段尾：编辑打断续播点失效（AC-067）
      a.pause();
      notify(r.endMs);
      stopRafRef.current();
      return "pause";
    }
    if (action.kind === "restart" && r) {
      a.currentTime = r.startMs / 1000;
      notify(clampMs(r.startMs));
      return "restart";
    }
    return "none";
  }, [audioRef, notify]);

  // stopRaf 需要被 enforceRangeEnd 引用；用 ref 打破声明顺序。
  const stopRafRef = useRef<() => void>(() => undefined);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const outcome = enforceRangeEnd();
    if (outcome === "pause") return; // 段尾暂停：不再排帧（play 事件会重新启动 rAF）
    if (outcome === "none") notify(clampMs(a.currentTime * 1000));
    // "restart"（循环回绕）与 "none" 都必须继续安排下一帧，否则循环第一次回绕后断掉。
    rafRef.current = requestAnimationFrame(tick);
  }, [audioRef, enforceRangeEnd, notify]);

  const startRaf = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);
  stopRafRef.current = stopRaf;

  // 挂载音频事件。
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    // 恢复保存的播放速度：挂载即应用（不等用户手动操作）。
    applyPlaybackPreferences(a, { speed: speedRef.current });
    const onMeta = () => {
      // 某些浏览器在换源/元数据就绪时会重置 playbackRate，这里再次应用。
      applyPlaybackPreferences(a, { speed: speedRef.current });
      const d = Number.isFinite(a.duration) ? clampMs(a.duration * 1000) : 0;
      setDurationMs(d);
      onDurationRef.current?.(d);
    };
    const onPlay = () => {
      seekedSincePauseRef.current = false;
      setPlaying(true);
      startRaf();
    };
    const onPause = () => {
      if (!pausedRef.current) {
        pausedRef.current = { ms: clampMs(a.currentTime * 1000), range: rangeRef.current };
      }
      setPlaying(false);
      stopRaf();
      notify(clampMs(a.currentTime * 1000));
      onPauseChangeRef.current?.(false, clampMs(a.currentTime * 1000));
    };
    const onSeeked = () => notify(clampMs(a.currentTime * 1000));
    // timeupdate 兜底：rAF 被节流（如后台标签页）时也能检测段尾。
    const onTimeUpdate = () => {
      enforceRangeEnd();
    };
    const onEnded = () => {
      const r = rangeRef.current;
      pausedRef.current = { ms: r ? r.endMs : clampMs(a.currentTime * 1000), range: r };
      interruptResumeRef.current = null; // 原生 ended：编辑打断续播点失效（AC-067）
      setPlaying(false);
      stopRaf();
      notify(clampMs(a.currentTime * 1000));
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("seeked", onSeeked);
    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("ended", onEnded);
    if (!a.paused) startRaf();
    return () => {
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("seeked", onSeeked);
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("ended", onEnded);
      stopRaf();
    };
  }, [audioRef, notify, startRaf, stopRaf, enforceRangeEnd]);

  const setRange = useCallback(
    (next: PlaybackRange | null) => {
      // 标准化并拒绝无效范围（null 表示清除）。
      const norm = next ? normalizeRange(next.startMs, next.endMs) : null;
      if (next && !norm) return;
      // 幂等：同一数值范围重复设置是 no-op（避免播放期每帧通知引发状态 churn）。
      if (norm && sameRange(rangeRef.current, norm)) return;
      const previousRange = rangeRef.current; // 先留旧值，暂停点必须归属旧范围
      rangeRef.current = norm;
      setRangeState(norm);
      // 换段（含同段时间轴变化导致的范围不同）：编辑打断续播点失效（AC-067）。
      if (!sameRange(previousRange, norm)) interruptResumeRef.current = null;
      // 旧 loop 安全解除：不对应新范围即清除，避免换段后跳回旧段。
      const lp = loopRef.current;
      if (lp && !sameRange(lp, norm)) {
        loopRef.current = null;
        setLoopState(null);
      }
      const a = audioRef.current;
      // 换段即暂停旧段播放（点击定位/切换选中段时不允许旧段继续出声）。
      if (a && !a.paused && norm) {
        const cur = clampMs(a.currentTime * 1000);
        if (cur < norm.startMs || cur >= norm.endMs) {
          pausedRef.current = { ms: cur, range: previousRange };
          a.pause();
        }
      }
    },
    [audioRef],
  );

  const loopSegment = useCallback((startMs: number, endMs: number) => {
    const norm = normalizeRange(startMs, endMs);
    if (!norm) return; // 明确拒绝无效范围
    interruptResumeRef.current = null; // 开关循环：编辑打断续播点失效（AC-067）
    const lp = loopRef.current;
    if (lp && lp.startMs === norm.startMs && lp.endMs === norm.endMs) {
      loopRef.current = null;
      setLoopState(null);
    } else {
      loopRef.current = norm;
      setLoopState(norm);
    }
  }, []);

  const toggleRange = useCallback(
    (target: PlaybackRange) => {
      const a = audioRef.current;
      if (!a) return;
      const norm = normalizeRange(target.startMs, target.endMs);
      if (!norm) return; // 拒绝无效范围
      const previousRange = rangeRef.current;
      const cur = clampMs(a.currentTime * 1000);
      // 正在播放该范围 → 暂停在当前位置（不定位、不回段首）。
      if (!a.paused && sameRange(previousRange, norm)) {
        // P1-1（第 2 轮）：用户显式暂停 → 清除编辑打断续播点。
        // 场景：用旧编辑点发起 play（promise 未决）→ 立即再点按钮暂停 →
        // 旧标记若不清除，下一次播放会错误地再次无回退使用旧点，而应走常规 auto-rewind。
        // 注意：旧 play promise 的 .then 不会清除（P1-4 已守卫：只消费本次使用的对象）。
        interruptResumeRef.current = null;
        pausedRef.current = { ms: cur, range: previousRange };
        a.pause();
        return;
      }
      setRange(norm);
      // 换段（即使时间范围重叠）必须从新段 start_ms 开始（PRD V1.0.2 §3.2.5）。
      let seekTarget: number | null;
      let usedInterrupt: { ms: number; range: PlaybackRange } | null = null;
      if (!sameRange(previousRange, norm)) {
        seekTarget = norm.startMs;
      } else {
        const paused = pausedRef.current;
        const interrupt = interruptResumeRef.current;
        if (interrupt && sameRange(interrupt.range, norm)) {
          // V1.1.4 编辑打断精确续播（AC-067）：从精确打断点继续，本次不应用自动回退；
          // 标记在成功起播后消费（play reject 时保留，重试仍从精确打断点）。
          usedInterrupt = interrupt;
          seekTarget = clampMs(interrupt.ms, norm.startMs, Math.max(norm.startMs, norm.endMs - 1));
        } else {
          seekTarget = resolvePlayTarget({
            currentTimeMs: cur,
            pausedAtMs: paused ? paused.ms : null,
            pausedAtInRange: sameRange(paused ? paused.range : null, norm),
            seekedSincePause: seekedSincePauseRef.current,
            autoRewindMs: autoRewindRef.current,
            range: norm,
          });
        }
      }
      if (seekTarget !== null) {
        a.currentTime = seekTarget / 1000;
        notify(seekTarget);
      }
      pausedRef.current = null;
      seekedSincePauseRef.current = false;
      void a
        .play()
        .then(() => {
          // 成功起播后消费（AC-067）——只消费本次实际使用的标记对象：
          // 若 play 未决期间用户再次编辑暂停生成了新打断点（不同对象），旧 promise 不得清除它。
          if (usedInterrupt && interruptResumeRef.current === usedInterrupt) {
            interruptResumeRef.current = null;
          }
        })
        .catch(() => {
          // 自动播放策略或解码失败：保持暂停状态，不崩溃；
          // 编辑打断续播点保留——下一次重试仍从精确打断点无回退续播。
        });
    },
    [audioRef, notify, setRange],
  );

  /** 显式从目标段段首播放（疑点面板「跳转播放」等）。 */
  const playRange = useCallback(
    (target: PlaybackRange) => {
      const a = audioRef.current;
      if (!a) return;
      const norm = normalizeRange(target.startMs, target.endMs);
      if (!norm) return;
      interruptResumeRef.current = null; // 显式从段首播放：编辑打断续播点失效
      setRange(norm);
      a.currentTime = norm.startMs / 1000;
      notify(norm.startMs);
      pausedRef.current = null;
      seekedSincePauseRef.current = false;
      void a.play().catch(() => {
        // 自动播放策略或解码失败：保持暂停状态，不崩溃。
      });
    },
    [audioRef, notify, setRange],
  );

  const pause = useCallback(() => {
    const a = audioRef.current;
    if (!a || a.paused) return;
    interruptResumeRef.current = null; // 用户主动暂停：编辑打断续播点失效，恢复常规自动回退
    pausedRef.current = { ms: clampMs(a.currentTime * 1000), range: rangeRef.current };
    a.pause();
  }, [audioRef]);

  /**
   * V1.1.4 编辑打断精确续播（AC-067）：当前段播放中聚焦其校对文本框——
   * 在精确位置暂停（不 seek、不定位段首），记录一次性续播点。
   */
  const pauseForEdit = useCallback(() => {
    const a = audioRef.current;
    if (!a || a.paused) return;
    const cur = clampMs(a.currentTime * 1000);
    const r = rangeRef.current;
    interruptResumeRef.current = r ? { ms: cur, range: r } : null;
    pausedRef.current = { ms: cur, range: r };
    a.pause();
  }, [audioRef]);

  /** 显式清除编辑打断续播点（段落数据外部更新等）。 */
  const clearEditResume = useCallback(() => {
    interruptResumeRef.current = null;
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const a = audioRef.current;
      if (!a) return;
      interruptResumeRef.current = null; // 用户主动 seek（含 ±2s）：续播点失效
      const max = Number.isFinite(a.duration) ? clampMs(a.duration * 1000) : Number.MAX_SAFE_INTEGER;
      const target = clampMs(ms, 0, max);
      a.currentTime = target / 1000;
      if (a.paused) {
        seekedSincePauseRef.current = true;
      } else {
        // 播放中 seek 受当前段约束：越界即暂停（普通播放只允许当前选中段）。
        const r = rangeRef.current;
        if (r && (target < r.startMs || target >= r.endMs)) {
          pausedRef.current = { ms: target, range: r };
          a.pause();
        }
      }
      notify(target);
    },
    [audioRef, notify],
  );

  const skip = useCallback(
    (deltaMs: number) => {
      const a = audioRef.current;
      if (!a) return;
      // F7/F9 钳制在当前段内。
      const target = clampSkipToScope(clampMs(a.currentTime * 1000), deltaMs, rangeRef.current);
      seek(target);
    },
    [seek, audioRef],
  );

  const setSpeed = useCallback(
    (rate: number) => {
      const r = Math.min(2, Math.max(0.5, rate));
      setSpeedState(r);
      const a = audioRef.current;
      if (a) {
        a.playbackRate = r;
        a.preservesPitch = true;
      }
    },
    [audioRef],
  );

  const setAutoRewindMs = useCallback((ms: number) => {
    setAutoRewindMsState(Math.min(5000, Math.max(0, Math.round(ms))));
  }, []);

  const getCurrentMs = useCallback(() => {
    const a = audioRef.current;
    return a ? clampMs(a.currentTime * 1000) : 0;
  }, [audioRef]);

  const subscribeCurrentMs = useCallback(
    (cb: (ms: number) => void) => {
      listenersRef.current.add(cb);
      cb(getCurrentMs());
      return () => {
        listenersRef.current.delete(cb);
      };
    },
    [getCurrentMs],
  );

  return {
    playing,
    durationMs,
    speed,
    autoRewindMs,
    range,
    loop,
    setSpeed,
    setAutoRewindMs,
    setRange,
    loopSegment,
    toggleRange,
    playRange,
    pause,
    pauseForEdit,
    clearEditResume,
    seek,
    skip,
    getCurrentMs,
    subscribeCurrentMs,
  };
}
