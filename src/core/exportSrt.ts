/**
 * SRT 导出构建与回读校验。
 * 非破坏性：只生成新文件，绝不触碰源 MP3/SRT；导出内容与项目数据在此组装。
 */

import { parseSrt, serializeSrt, type SrtCue } from "./srt.js";
import type { IssueRecord, SegmentRecord } from "../store/types.js";

export interface ExportPreview {
  cues: SrtCue[];
  segmentCount: number;
  unresolvedBlocking: number;
  unresolvedWarning: number;
  emptyTextCount: number;
}

/**
 * 由校对层构建导出 cue：优先使用未落盘草稿（V1.0.5 草稿管道），
 * 其次 correctedText（初始等于原始文本）。保证「先编辑后导出」内容新鲜、无陈旧导出。
 */
export function buildExportPreview(
  segments: SegmentRecord[],
  issues: IssueRecord[],
  drafts?: ReadonlyMap<string, string>,
): ExportPreview {
  const cues: SrtCue[] = segments.map((s) => ({
    seq: s.cueNo,
    startMs: s.startMs,
    endMs: s.endMs,
    text: drafts?.get(s.segmentId) ?? s.correctedText,
  }));
  const open = issues.filter((i) => i.status === "open");
  return {
    cues,
    segmentCount: segments.length,
    unresolvedBlocking: open.filter((i) => i.severity === "blocking").length,
    unresolvedWarning: open.filter((i) => i.severity === "warning").length,
    emptyTextCount: cues.filter((c) => c.text.trim() === "").length,
  };
}

export function renderExportSrt(preview: ExportPreview): string {
  return serializeSrt(preview.cues);
}

export interface RoundTripCheck {
  ok: boolean;
  cueCountExpected: number;
  cueCountActual: number;
  firstDiff: string | null;
  parseErrors: { line: number; message: string }[];
}

/**
 * 导出后重新解析回读：逐条比较起止毫秒与文本（PRD AC-032）。
 * 期望输入与实际输入的顺序都按起始时间排序后比较。
 */
export function verifyRoundTrip(expected: SrtCue[], actualRaw: string): RoundTripCheck {
  const parsed = parseSrt(actualRaw);
  const actual = [...parsed.cues].sort((a, b) => a.startMs - b.startMs);
  const sortedExpected = [...expected].sort((a, b) => a.startMs - b.startMs);
  let firstDiff: string | null = null;
  const n = Math.max(sortedExpected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = sortedExpected[i];
    const a = actual[i];
    if (!e || !a) {
      firstDiff = `第 ${i + 1} 条：一侧缺失（期望 ${sortedExpected.length} 条，实际 ${actual.length} 条）`;
      break;
    }
    if (e.startMs !== a.startMs || e.endMs !== a.endMs || e.text !== a.text) {
      firstDiff = `第 ${i + 1} 条不一致：期望 [${e.startMs}-${e.endMs}] “${e.text.slice(0, 30)}”，实际 [${a.startMs}-${a.endMs}] “${a.text.slice(0, 30)}”`;
      break;
    }
  }
  return {
    ok: firstDiff === null && parsed.errors.length === 0,
    cueCountExpected: sortedExpected.length,
    cueCountActual: actual.length,
    firstDiff,
    parseErrors: parsed.errors,
  };
}
