/**
 * 播放引擎：包装 HTMLAudioElement。
 *
 * - F7 后退 / F8 播放暂停 / F9 前进（默认映射，可配置）；
 * - 变速不变调（preservesPitch）；
 * - 自动回退：仅“从暂停恢复”且暂停期间没有跳转过时生效（PRD AC-007）；
 * - A-B / 当前段循环：播放越过循环终点时回到起点；
 * - 播放位置通过订阅分发（rAF 驱动），时间轴与时间显示不整树重渲染。
 *
 * 所有增强只作用于播放，不修改源音频（浏览器仅读取本地文件）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { clampMs } from "../core/time.js";
import { applyPlaybackPreferences } from "../core/audioPrefs.js";

export interface LoopRegion {
  startMs: number;
  endMs: number;
}

export interface PlayerApi {
  playing: boolean;
  durationMs: number;
  speed: number;
  autoRewindMs: number;
  loop: LoopRegion | null;
  setSpeed: (rate: number) => void;
  setAutoRewindMs: (ms: number) => void;
  setLoop: (region: LoopRegion | null) => void;
  loopSegment: (startMs: number, endMs: number) => void;
  togglePlay: () => void;
  seek: (ms: number) => void;
  skip: (deltaMs: number) => void;
  getCurrentMs: () => number;
  subscribeCurrentMs: (cb: (ms: number) => void) => () => void;
}

interface SeekOptions {
  /** 自动回退引起的 seek 不打断暂停恢复语义。 */
  fromAutoRewind?: boolean;
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
  const [loop, setLoopState] = useState<LoopRegion | null>(null);

  const pausedAtRef = useRef<number | null>(null);
  const seekedSincePauseRef = useRef(false);
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

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = clampMs(a.currentTime * 1000);
    const lp = loopRef.current;
    if (lp && t >= lp.endMs - 1) {
      a.currentTime = lp.startMs / 1000;
      notify(clampMs(lp.startMs));
    } else {
      notify(t);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [audioRef, notify]);

  const startRaf = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

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
      setPlaying(true);
      startRaf();
    };
    const onPause = () => {
      setPlaying(false);
      stopRaf();
      notify(clampMs(a.currentTime * 1000));
      onPauseChangeRef.current?.(false, clampMs(a.currentTime * 1000));
    };
    const onSeeked = () => notify(clampMs(a.currentTime * 1000));
    const onEnded = () => {
      setPlaying(false);
      stopRaf();
      notify(clampMs(a.currentTime * 1000));
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("seeked", onSeeked);
    a.addEventListener("ended", onEnded);
    if (!a.paused) startRaf();
    return () => {
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("seeked", onSeeked);
      a.removeEventListener("ended", onEnded);
      stopRaf();
    };
  }, [audioRef, notify, startRaf, stopRaf]);

  const seek = useCallback(
    (ms: number, seekOpts: SeekOptions = {}) => {
      const a = audioRef.current;
      if (!a) return;
      const max = Number.isFinite(a.duration) ? clampMs(a.duration * 1000) : Number.MAX_SAFE_INTEGER;
      const target = clampMs(ms, 0, max);
      a.currentTime = target / 1000;
      if (!seekOpts.fromAutoRewind) {
        if (a.paused) seekedSincePauseRef.current = true;
        // 手动跳转离开循环区 500ms 以上时解除循环。
        const lp = loopRef.current;
        if (lp && (target < lp.startMs - 500 || target > lp.endMs + 500)) {
          loopRef.current = null;
          setLoopState(null);
        }
      }
      notify(target);
    },
    [audioRef, notify],
  );

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      const pausedAt = pausedAtRef.current;
      if (pausedAt !== null && !seekedSincePauseRef.current && autoRewindRef.current > 0) {
        const target = clampMs(pausedAt - autoRewindRef.current, 0);
        if (Math.abs(a.currentTime * 1000 - target) > 20) {
          a.currentTime = target / 1000;
          notify(target);
        }
      }
      pausedAtRef.current = null;
      seekedSincePauseRef.current = false;
      void a.play().catch(() => {
        // 自动播放策略或解码失败：保持暂停状态，不崩溃。
      });
    } else {
      pausedAtRef.current = clampMs(a.currentTime * 1000);
      a.pause();
    }
  }, [audioRef, notify]);

  const skip = useCallback(
    (deltaMs: number) => {
      const a = audioRef.current;
      if (!a) return;
      seek(clampMs(a.currentTime * 1000) + deltaMs);
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

  const setLoop = useCallback((region: LoopRegion | null) => {
    loopRef.current = region;
    setLoopState(region);
  }, []);

  const loopSegment = useCallback(
    (startMs: number, endMs: number) => {
      const lp = loopRef.current;
      if (lp && Math.abs(lp.startMs - startMs) < 1 && Math.abs(lp.endMs - endMs) < 1) {
        setLoop(null);
      } else {
        setLoop({ startMs, endMs });
      }
    },
    [setLoop],
  );

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
    loop,
    setSpeed,
    setAutoRewindMs,
    setLoop,
    loopSegment,
    togglePlay,
    seek,
    skip,
    getCurrentMs,
    subscribeCurrentMs,
  };
}
