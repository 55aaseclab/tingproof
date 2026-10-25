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
): ConfirmPlan {
  const seg = sortedSegments.find((s) => s.segmentId === segmentId);
  if (!seg) return { ok: false, reason: "未找到该字幕段，请刷新后重试。" };
  if (seg.correctedText.trim() === "") {
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
