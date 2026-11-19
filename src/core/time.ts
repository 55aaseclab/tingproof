/** 内部时间统一为整数毫秒；禁止浮点累计误差。 */

export function clampMs(ms: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(ms)) return min;
  return Math.min(Math.max(Math.round(ms), min), max);
}

/**
 * SRT 标准时间码：HH:MM:SS,mmm
 * 负值按 0 处理（调用方负责在导出前做有效性校验）。
 */
export function formatSrtTime(ms: number): string {
  const t = clampMs(ms);
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const mmm = t % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(mmm).padStart(3, "0")}`;
}

/** 界面显示：HH:MM:SS.mmm（PRD 2.3.2：点号毫秒格式）。 */
export function formatDisplay(ms: number): string {
  return formatSrtTime(ms).replace(",", ".");
}

/** 紧凑显示，用于列表时间戳：mm:ss.t 或 h:mm:ss.t。 */
export function formatCompact(ms: number): string {
  const full = formatDisplay(ms);
  const parts = full.split(":");
  if (parts.length === 3 && parts[0] === "00") {
    return `${parts[1]}:${parts[2]}`;
  }
  return full;
}

/** 人类可读的时长，如 3:24:50 或 07:08。 */
export function formatDuration(ms: number): string {
  const t = clampMs(ms);
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
