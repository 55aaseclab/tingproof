/**
 * 段内播放模型（PRD docs/听校_PRD_V1.0.0.md V1.0.2 §3.2.5 / §3.3.5，纯函数）。
 *
 * 口径：
 * - 普通播放的可听范围为闭开区间 [start_ms, end_ms)；到 end_ms 立即暂停并把位置稳定在段尾；
 * - 循环模式是唯一「段尾回段首继续」的模式，且仅当 loop region 与当前段范围一致时生效；
 * - 行内按钮是播放/暂停开关：播放中点击 → 暂停在当前位置（不得回段首）；
 *   同段段内暂停后再次播放 → 自动回退且不早于段首；
 *   换段、停在段尾或播放头位于目标段外 → 从目标段 start_ms 开始；
 * - 后退/前进/自动回退/播放中 seek 都钳制在当前段内。
 */

export interface PlaybackRange {
  startMs: number;
  endMs: number;
}

/**
 * 范围标准化：取整后校验。start_ms >= end_ms 属于无效字幕段（PRD 3.2.7），
 * 必须拒绝播放——因此倒置、相等一律返回 null（不做静默交换）；
 * 全负或 clamp 后零宽同样无效；合法的负起点会钳到 0（如 -100..5000 → 0..5000）。
 */
export function normalizeRange(startMs: number, endMs: number): PlaybackRange | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const s = Math.round(startMs);
  const e = Math.round(endMs);
  if (s >= e) return null; // 倒置或相等：无效，禁止播放，提示先修时间轴
  const cs = Math.max(0, s);
  const ce = Math.max(0, e);
  if (ce <= cs) return null; // 全负/负终点：clamp 后零宽，同样无效
  return { startMs: cs, endMs: ce };
}

/** 两个范围是否为同一段（用于 loop region 与当前段的匹配、暂停点归属判断）。 */
export function sameRange(a: PlaybackRange | null | undefined, b: PlaybackRange | null | undefined): boolean {
  return !!a && !!b && a.startMs === b.startMs && a.endMs === b.endMs;
}

/** 段尾判定容差：帧调度误差内到段尾即视为“已到段尾”（<100ms，PRD AC-043 允许）。 */
export const END_TOLERANCE_MS = 50;

/**
 * rAF/timeupdate 心跳里的播放头决策。
 * - loop region 与当前段一致时：到/越过 endMs → 回段首继续（唯一回绕模式）；
 * - 否则：到/越过 endMs → 暂停（调用方把位置稳定在段尾）；
 * - 其余情况继续播放。
 */
export type TickAction =
  | { kind: "continue" }
  | { kind: "restart" }
  | { kind: "pauseAtEnd" };

export function tickAction(
  currentMs: number,
  range: PlaybackRange | null,
  loop: PlaybackRange | null,
): TickAction {
  if (!range) return { kind: "continue" };
  if (currentMs >= range.endMs - 0.5) {
    return sameRange(loop, range) ? { kind: "restart" } : { kind: "pauseAtEnd" };
  }
  return { kind: "continue" };
}

export interface ResolvePlayTargetInput {
  currentTimeMs: number;
  /** 最近一次暂停的位置；null 表示无暂停点。 */
  pausedAtMs: number | null;
  /** 暂停点是否属于当前（目标）段——换段后旧暂停点失效。 */
  pausedAtInRange: boolean;
  /** 暂停期间是否发生过 seek（此时自动回退不适用）。 */
  seekedSincePause: boolean;
  autoRewindMs: number;
  range: PlaybackRange | null;
}

/**
 * 播放（恢复）时应跳到的位置；null 表示原地播放。
 * - 暂停点属于当前段且未跳转过：段内 → 自动回退（不早于段首）；已到段尾 → 从段首；
 * - 暂停点不属于当前段（换段）：播放头在段内 → 原地播放（如刚定位到段首）；
 *   播放头在段尾或段外 → 从段首；
 * - 暂停期间 seek 过：段内原地播放，段外从段首。
 */
export function resolvePlayTarget(input: ResolvePlayTargetInput): number | null {
  const { currentTimeMs, pausedAtMs, pausedAtInRange, seekedSincePause, autoRewindMs, range } = input;
  if (!range) {
    // 无段上下文：保持旧的自动回退语义（暂停恢复且未跳转时回退，不早于 0）。
    if (pausedAtMs !== null && !seekedSincePause && autoRewindMs > 0) {
      const target = Math.max(0, pausedAtMs - autoRewindMs);
      return Math.abs(currentTimeMs - target) > 20 ? target : null;
    }
    return null;
  }
  if (pausedAtMs !== null && pausedAtInRange && !seekedSincePause) {
    if (pausedAtMs >= range.endMs - END_TOLERANCE_MS) return range.startMs;
    const target = Math.max(range.startMs, pausedAtMs - autoRewindMs);
    return Math.abs(currentTimeMs - target) > 20 ? target : null;
  }
  const curInRange =
    currentTimeMs >= range.startMs && currentTimeMs < range.endMs - END_TOLERANCE_MS;
  return curInRange ? null : range.startMs;
}

/** 后退/前进钳制在当前段内（无段上下文时仅钳非负）。 */
export function clampSkipToScope(
  currentMs: number,
  deltaMs: number,
  range: PlaybackRange | null,
): number {
  const raw = currentMs + deltaMs;
  if (!range) return Math.max(0, raw);
  return Math.min(range.endMs, Math.max(range.startMs, raw));
}
