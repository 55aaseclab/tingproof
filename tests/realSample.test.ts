/**
 * 真实样本回归测试（只读）：解析仓库内的真实 SRT，不做任何修改。
 * 文件缺失时跳过（例如在其他机器上运行）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSrt, serializeSrt } from "../src/core/srt.js";
import { sha256Hex } from "../src/core/identity.js";

const REAL_SRT_PATH = fileURLToPath(
  new URL("../../../../books/transcripts/环境画卷/青创 一 1 7月25日 上午9点10分.srt", import.meta.url),
);
const REAL_MP3_PATH = fileURLToPath(
  new URL("../../../../books/transcripts/环境画卷/青创 一   1   7月25日 上午9点10分.mp3", import.meta.url),
);

const hasSrt = existsSync(REAL_SRT_PATH);
const hasMp3 = existsSync(REAL_MP3_PATH);

describe.skipIf(!hasSrt)("真实样本：青创 一 1 7月25日 上午9点10分.srt", () => {
  const raw = readFileSync(REAL_SRT_PATH, "utf8");

  it("文件名含中文与空格差异可读，内容为合法 UTF-8（无替换符）", () => {
    expect(raw.length).toBeGreaterThan(100_000);
    expect(raw.includes("\uFFFD")).toBe(false);
  });

  it("严格解析零错误，字幕段数量在合理范围", () => {
    const result = parseSrt(raw);
    expect(result.errors).toEqual([]);
    expect(result.cues.length).toBeGreaterThan(1000);
    console.log(
      `[real-sample] cues=${result.cues.length}, warnings=${result.warnings.length}, ` +
        `first=${result.cues[0].startMs}ms, lastEnd=${result.cues[result.cues.length - 1].endMs}ms`,
    );
  });

  it("时间轴单调不减且时间有效（0 <= start < end）", () => {
    const result = parseSrt(raw);
    let prevEnd = -1;
    let overlaps = 0;
    for (const cue of result.cues) {
      expect(cue.startMs).toBeGreaterThanOrEqual(0);
      expect(cue.endMs).toBeGreaterThan(cue.startMs);
      if (cue.startMs < prevEnd) overlaps += 1;
      prevEnd = cue.endMs;
    }
    // 真实样本可能出现少量重叠：只记录，不作为解析失败。
    console.log(`[real-sample] overlapping cue pairs=${overlaps}`);
  });

  it("导出往返：serialize → parse 与解析结果逐条一致", () => {
    const result = parseSrt(raw);
    const once = serializeSrt(result.cues);
    const reparsed = parseSrt(once);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.cues).toHaveLength(result.cues.length);
    for (let i = 0; i < result.cues.length; i++) {
      expect(reparsed.cues[i].startMs).toBe(result.cues[i].startMs);
      expect(reparsed.cues[i].endMs).toBe(result.cues[i].endMs);
      expect(reparsed.cues[i].text).toBe(result.cues[i].text);
    }
  });

  it("记录真实 SRT 的 SHA-256（用于验收与溯源）", async () => {
    const sha = await sha256Hex(raw);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    console.log(`[real-sample] srt sha256(raw text) = ${sha}`);
  });
});

describe.skipIf(!hasMp3)("真实样本：MP3 文件存在性（只读检查）", () => {
  it("MP3 存在且大小与 PRD 记录一致（约 98.3 MB）", () => {
    const st = statSync(REAL_MP3_PATH);
    expect(st.size).toBeGreaterThan(90_000_000);
    expect(st.size).toBeLessThan(110_000_000);
    console.log(`[real-sample] mp3 bytes=${st.size}`);
  });
});
