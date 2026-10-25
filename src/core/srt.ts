import { formatSrtTime } from "./time.js";

/**
 * 严格、可解释的 SRT 解析与序列化。
 *
 * 原则：
 * - 解析不猜测：无法解释的内容进入 errors（带行号），不静默丢弃；
 * - 能解释但偏离惯例的内容进入 warnings（如时间码后带坐标、序号缺失）；
 * - 序列化按 PRD 3.9.5：按起始时间重排，序号从 1 连续编号，HH:MM:SS,mmm。
 */

export interface SrtCue {
  /** 原 cue 序号（导入记录用）；可能为 null。 */
  seq: number | null;
  startMs: number;
  endMs: number;
  /** 文本行，保留内部换行；不含行尾空白。 */
  text: string;
}

export interface SrtIssue {
  line: number;
  message: string;
}

export interface SrtParseResult {
  cues: SrtCue[];
  errors: SrtIssue[];
  warnings: SrtIssue[];
}

export class SrtParseError extends Error {
  readonly issues: SrtIssue[];
  constructor(message: string, issues: SrtIssue[]) {
    super(message);
    this.name = "SrtParseError";
    this.issues = issues;
  }
}

const TIME_LINE_RE =
  /^(\d{1,3}):(\d{1,2}):(\d{1,2})([,.])(\d{1,3})(?!\d)\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})([,.])(\d{1,3})(?!\d)(.*)$/;
const SEQ_LINE_RE = /^\s*(\d{1,9})\s*$/;
/** 毫秒字段 ≥4 位数字：明确拒绝（避免截断解释造成时间漂移）。 */
const MS_TOO_LONG_RE = /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{4,})/;

function parseTimeField(
  h: string,
  m: string,
  s: string,
  msRaw: string,
): { ms: number | null; error?: string; warning?: string } {
  const hours = parseInt(h, 10);
  const minutes = parseInt(m, 10);
  const seconds = parseInt(s, 10);
  if (minutes > 59 || seconds > 59) {
    return {
      ms: null,
      error: `时间码字段超出范围：分钟与秒必须为 00–59（得到 "${m}:${s}"）`,
    };
  }
  // 毫秒按 SRT 惯例为 3 位；1–2 位按“缺少前导零”理解并告警（如 12,5 = 12,500）；
  // 4 位及以上在上游已单独报错。
  const ms = parseInt(msRaw.padEnd(3, "0"), 10);
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
  let warning: string | undefined;
  if (msRaw.length !== 3) {
    warning = `毫秒字段 "${msRaw}" 不是 3 位，已按 ${String(ms).padStart(3, "0")} 毫秒解释（建议修复源文件）`;
  }
  return { ms: total, warning };
}

/** 解析 SRT 文本。永不抛异常；错误以 issues 返回。 */
export function parseSrt(raw: string): SrtParseResult {
  const errors: SrtIssue[] = [];
  const warnings: SrtIssue[] = [];
  const cues: SrtCue[] = [];

  // 去掉 UTF-8 BOM；统一换行。
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r\n|\r|\n/);

  // 收集非空块，记录每个块的起始行号（1-based）。
  const blocks: { lines: string[]; startLine: number }[] = [];
  let current: { lines: string[]; startLine: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      current = null;
      continue;
    }
    if (!current) {
      current = { lines: [], startLine: i + 1 };
      blocks.push(current);
    }
    current.lines.push(line);
  }

  for (const block of blocks) {
    const timeIdx = block.lines.findIndex((l) => TIME_LINE_RE.test(l));
    if (timeIdx === -1) {
      const hasArrow = block.lines.some((l) => l.includes("-->"));
      const sample = block.lines[0]?.slice(0, 60) ?? "";
      // 毫秒位数超长时给出专门解释（TIME_LINE_RE 因 (?!\d) 无法匹配这种行）。
      const arrowLine = block.lines.find((l) => l.includes("-->"));
      const msTooLong = arrowLine ? MS_TOO_LONG_RE.exec(arrowLine) : null;
      errors.push({
        line: block.startLine,
        message: hasArrow
          ? msTooLong
            ? `毫秒字段必须是 1–3 位数字（得到 "${msTooLong[4]}"）`
            : `时间行格式无效（应为 "HH:MM:SS,mmm --> HH:MM:SS,mmm"）：${sample}`
          : `未找到时间行（块首行：${sample}）`,
      });
      continue;
    }

    // 时间行之前的行应为序号。
    let seq: number | null = null;
    for (let i = 0; i < timeIdx; i++) {
      const m = SEQ_LINE_RE.exec(block.lines[i]);
      if (m) {
        seq = parseInt(m[1], 10);
      } else {
        errors.push({
          line: block.startLine + i,
          message: `时间行之前存在无法解释的行（预期序号）：“${block.lines[i].slice(0, 60)}”`,
        });
      }
    }

    const tm = TIME_LINE_RE.exec(block.lines[timeIdx]);
    if (!tm) {
      // 区分“毫秒位数超长”与一般格式错误，给出可解释原因。
      const lineNo = block.startLine + timeIdx;
      const msTooLong = MS_TOO_LONG_RE.exec(block.lines[timeIdx]);
      errors.push({
        line: lineNo,
        message: msTooLong
          ? `毫秒字段必须是 1–3 位数字（得到 "${msTooLong[4]}"）`
          : "时间行格式无效（应为 \"HH:MM:SS,mmm --> HH:MM:SS,mmm\"）",
      });
      continue;
    }
    const start = parseTimeField(tm[1], tm[2], tm[3], tm[5]);
    const end = parseTimeField(tm[6], tm[7], tm[8], tm[10]);
    const trailing = tm[11]?.trim() ?? "";

    if (tm[4] !== "," || tm[9] !== ",") {
      errors.push({
        line: block.startLine + timeIdx,
        message:
          "SRT 时间码毫秒分隔符必须是英文逗号“,”（WebVTT 使用点号）。检测到点号，已拒绝该字幕段。",
      });
      continue;
    }
    if (start.error) {
      errors.push({ line: block.startLine + timeIdx, message: start.error });
      continue;
    }
    if (end.error) {
      errors.push({ line: block.startLine + timeIdx, message: end.error });
      continue;
    }
    if (start.ms === null || end.ms === null) {
      errors.push({ line: block.startLine + timeIdx, message: "时间行解析失败" });
      continue;
    }
    if (start.warning) warnings.push({ line: block.startLine + timeIdx, message: start.warning });
    if (end.warning) warnings.push({ line: block.startLine + timeIdx, message: end.warning });
    if (trailing) {
      warnings.push({
        line: block.startLine + timeIdx,
        message: `时间行末尾有额外内容“${trailing.slice(0, 40)}”（常见于 WebVTT 坐标），已忽略`,
      });
    }
    if (start.ms < 0 || end.ms < 0) {
      errors.push({ line: block.startLine + timeIdx, message: "时间码为负数" });
      continue;
    }
    if (end.ms <= start.ms) {
      errors.push({
        line: block.startLine + timeIdx,
        message: `结束时间（${end.ms} ms）必须晚于开始时间（${start.ms} ms）`,
      });
      continue;
    }

    const textLines = block.lines.slice(timeIdx + 1);
    if (textLines.length === 0) {
      errors.push({ line: block.startLine + timeIdx, message: "字幕文本为空" });
      continue;
    }

    cues.push({ seq, startMs: start.ms, endMs: end.ms, text: textLines.join("\n") });
  }

  // 检查时间重叠（仅告警；导入后由时间轴校验继续把关）。
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].startMs < cues[i - 1].endMs) {
      warnings.push({
        line: -1,
        message: `第 ${i}、${i + 1} 个字幕段时间重叠（${cues[i - 1].endMs} > ${cues[i].startMs} ms）`,
      });
    }
  }

  return { cues, errors, warnings };
}

/**
 * 序列化 cue 为 SRT。
 * - 按起始时间稳定排序，序号 1..n 连续编号（PRD 3.9.5）；
 * - 时间格式 HH:MM:SS,mmm；行尾使用 \n；
 * - start >= end 或负数的 cue 会被抛出（调用方应先做导出预检）。
 */
export function serializeSrt(cues: SrtCue[]): string {
  const invalid = cues.findIndex((c) => !(c.startMs >= 0 && c.endMs > c.startMs));
  if (invalid !== -1) {
    const c = cues[invalid];
    throw new Error(
      `第 ${invalid + 1} 条字幕段时间无效：start=${c.startMs}, end=${c.endMs}（要求 0 <= start < end）`,
    );
  }
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const blocks = sorted.map(
    (cue, i) => `${i + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}\n`,
  );
  return blocks.join("\n") + "\n";
}
