/**
 * 选中/播放定位策略（纯函数，可自动测试）。
 *
 * 策略（稳定且可解释）：
 * - 「选中段」是用户当前工作段：由定位、行内确认、Ctrl+Enter、Alt+←/→ 显式设置；
 * - 播放只有真正进入某个字幕段时间范围时，才把选中段切到该段；
 * - 播放位于字幕间隙（含首段之前、末段之后）时，保持当前选中段不变；
 * - 行内「确认」永远作用于被点击的 segmentId，与播放位置无关；
 *   Ctrl+Enter 作用于当前选中段。
 */

export interface SegmentLike {
  segmentId: string;
  startMs: number;
  endMs: number;
  status: string;
  correctedText: string;
}

/** 播放头所在的字幕段；在间隙（含首段前、末段后）返回 null。要求按 startMs 升序。 */
export function computePlaybackSegmentId(
  sortedSegments: SegmentLike[],
  ms: number,
): string | null {
  let lo = 0;
  let hi = sortedSegments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sortedSegments[mid];
    if (ms < s.startMs) hi = mid - 1;
    else if (ms >= s.endMs) lo = mid + 1;
    else return s.segmentId;
  }
  return null;
}

/** 在指定段之后（按时间序）的第一个未确认段。 */
export function nextUnreviewedAfter(
  sortedSegments: SegmentLike[],
  segmentId: string,
): SegmentLike | null {
  const idx = sortedSegments.findIndex((s) => s.segmentId === segmentId);
  if (idx === -1) return null;
  return sortedSegments.slice(idx + 1).find((s) => s.status !== "confirmed") ?? null;
}

export type ConfirmPlan =
  | { ok: true; confirmedId: string; nextId: string | null }
  | { ok: false; reason: string };

/**
 * 确认计划：行内确认与 Ctrl+Enter 共用。
 * 与播放位置无关——只看被点击/被选中的 segmentId（回归测试锁定该行为）。
 */
export function planConfirm(
  sortedSegments: SegmentLike[],
  segmentId: string,
  /** 目标段的最新草稿（存在时优先于 correctedText，包括空字符串——第 13 轮审计 P0）。 */
  draftText?: string,
): ConfirmPlan {
  const seg = sortedSegments.find((s) => s.segmentId === segmentId);
  if (!seg) return { ok: false, reason: "未找到该字幕段，请刷新后重试。" };
  const effectiveText = draftText !== undefined ? draftText : seg.correctedText;
  if (effectiveText.trim() === "") {
    return {
      ok: false,
      reason: "语音段文本为空，不能确认。若该段不是讲话内容，请标记疑点并说明。",
    };
  }
  return {
    ok: true,
    confirmedId: seg.segmentId,
    nextId: nextUnreviewedAfter(sortedSegments, segmentId)?.segmentId ?? null,
  };
}

/** 由 loop region 反查其所属字幕段（loop 标记按真实 range 计算，而非选中段）。 */
export function segmentIdForRange(
  sortedSegments: SegmentLike[],
  range: { startMs: number; endMs: number } | null | undefined,
): string | null {
  if (!range) return null;
  return (
    sortedSegments.find((s) => s.startMs === range.startMs && s.endMs === range.endMs)
      ?.segmentId ?? null
  );
}

/**
 * 行内循环开关计划：目标段不是当前选中段时，必须先把它设为当前段/范围
 * （定位但不自动播放），循环才真正作用在该段上。
 */
export function planLoopToggle(
  currentSelectedId: string | null,
  targetSegmentId: string,
): { locateFirst: boolean } {
  return { locateFirst: currentSelectedId !== targetSegmentId };
}

/**
 * 撤销确认后的目标状态（PRD V1.0.4 行内确认/撤销确认规则）：
 * 有未解决疑点 → 回到“有疑点”（questioned）；否则 → 回到“校对中”（editing）。
 */
export function planUnconfirm(hasOpenIssue: boolean): "questioned" | "editing" {
  return hasOpenIssue ? "questioned" : "editing";
}

export interface TimelineSegLike {
  segmentId: string;
  startMs: number;
  endMs: number;
  status: string;
}

/**
 * 排序缓存形状比较（第 10 轮审计 C）：按 segmentId 对「缓存已排序顺序」逐项精确比较
 * start/end——不假设原始输入顺序与缓存排序顺序相同；ID 替换、时间变化、数量变化都判不同。
 */
export function sameSortedOrderShape(
  cachedSorted: SegmentLike[],
  incomingById: Map<string, SegmentLike>,
): boolean {
  if (incomingById.size !== cachedSorted.length) return false;
  for (const cachedSeg of cachedSorted) {
    const next = incomingById.get(cachedSeg.segmentId);
    if (!next) return false; // ID 替换
    if (next.startMs !== cachedSeg.startMs || next.endMs !== cachedSeg.endMs) return false;
  }
  return true;
}

/**
 * 时间轴数据比较（第 10 轮审计 item 3）：id/start/end/status 任一变化即不同；
 * 纯正文（correctedText）变化必须判定相同——文本变化不重绘时间轴静态层。
 */
export function sameTimelineData(a: TimelineSegLike[], b: TimelineSegLike[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].segmentId !== b[i].segmentId ||
      a[i].startMs !== b[i].startMs ||
      a[i].endMs !== b[i].endMs ||
      a[i].status !== b[i].status
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 时间轴数据复用/投影 helper（第 11 轮审计 3）：
 * 纯正文（id/start/end/status 全同）变化 → reused=true 且 value 为**同一引用**；
 * 状态/时间/数量/ID 变化 → 新数组。调用方（Workbench）据此让 React.memo 真正跳过。
 */
export function reuseTimelineData<T extends { segmentId: string; startMs: number; endMs: number; status: string }>(
  cached: TimelineSegLike[] | null,
  segments: T[],
): { reused: boolean; value: TimelineSegLike[] } {
  if (cached && sameTimelineData(cached, segments)) {
    return { reused: true, value: cached };
  }
  return {
    reused: false,
    value: segments.map((s) => ({
      segmentId: s.segmentId,
      startMs: s.startMs,
      endMs: s.endMs,
      status: s.status,
    })),
  };
}
