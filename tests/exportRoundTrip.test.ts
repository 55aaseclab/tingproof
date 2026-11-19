/**
 * 导出回读测试（PRD AC-032）：构建 → 序列化 → 重新解析 → 逐条比较。
 * 同时验证：序号连续、时间码有效、导出预检的疑点计数。
 */
import { describe, expect, it } from "vitest";
import { buildExportPreview, renderExportSrt, verifyRoundTrip } from "../src/core/exportSrt.js";
import { parseSrt, serializeSrt } from "../src/core/srt.js";
import type { IssueRecord, SegmentRecord } from "../src/store/types.js";

function seg(partial: Partial<SegmentRecord> & Pick<SegmentRecord, "segmentId" | "startMs" | "endMs" | "originalText">): SegmentRecord {
  return {
    projectId: "p",
    cueNo: null,
    correctedText: partial.originalText,
    status: "unreviewed",
    revisionNo: 1,
    updatedAt: 0,
    ...partial,
  };
}

function issue(partial: Partial<IssueRecord> & Pick<IssueRecord, "issueId">): IssueRecord {
  return {
    projectId: "p",
    segmentId: "s",
    startMs: 0,
    endMs: 1000,
    type: "unclear",
    severity: "blocking",
    note: "",
    status: "open",
    createdAt: 0,
    resolvedAt: null,
    ...partial,
  };
}

describe("buildExportPreview", () => {
  it("使用校对层文本，统计未解决疑点", () => {
    const segments = [
      seg({ segmentId: "s1", startMs: 1600, endMs: 2940, originalText: "原文一", correctedText: "校对一" }),
      seg({ segmentId: "s2", startMs: 3600, endMs: 9460, originalText: "原文二", correctedText: "" }),
    ];
    const issues = [
      issue({ issueId: "i1", severity: "blocking", status: "open" }),
      issue({ issueId: "i2", severity: "warning", status: "open" }),
      issue({ issueId: "i3", severity: "blocking", status: "resolved" }),
    ];
    const preview = buildExportPreview(segments, issues);
    expect(preview.cues[0].text).toBe("校对一");
    expect(preview.unresolvedBlocking).toBe(1);
    expect(preview.unresolvedWarning).toBe(1);
    expect(preview.emptyTextCount).toBe(1);
  });
});

describe("导出回读（AC-032）", () => {
  it("导出→重解析：起止毫秒与文本逐条一致，序号 1..n 连续", () => {
    const segments = [
      seg({ segmentId: "s2", startMs: 3_600_000, endMs: 3_605_000, originalText: "第二段\n换行", correctedText: "第二段（已校对）\n换行保留" }),
      seg({ segmentId: "s1", startMs: 1600, endMs: 2940, originalText: "第一段" }),
      seg({ segmentId: "s3", startMs: 7_200_500, endMs: 7_205_000, originalText: "特殊字符 “引号” --> 箭头", correctedText: "特殊字符 “引号” --> 箭头" }),
    ];
    const preview = buildExportPreview(segments, []);
    const srt = renderExportSrt(preview);
    const check = verifyRoundTrip(preview.cues, srt);
    expect(check.ok).toBe(true);
    expect(check.cueCountActual).toBe(3);
    expect(check.firstDiff).toBeNull();

    // 序号按起始时间连续重排。
    const reparsed = parseSrt(srt);
    expect(reparsed.errors).toHaveLength(0);
    expect(reparsed.cues.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(reparsed.cues[0].text).toBe("第一段");
    expect(reparsed.cues[2].text).toBe("特殊字符 “引号” --> 箭头");
  });

  it("回读捕获篡改：内容被改动时 verifyRoundTrip 报告差异", () => {
    const cues = [{ seq: 1, startMs: 1000, endMs: 2000, text: "真实内容" }];
    const tampered = "1\n00:00:01,000 --> 00:00:02,000\n被改过的内容\n";
    const check = verifyRoundTrip(cues, tampered);
    expect(check.ok).toBe(false);
    expect(check.firstDiff).toContain("不一致");
  });

  it("回读捕获丢段：段数不一致时报错", () => {
    const cues = [
      { seq: 1, startMs: 1000, endMs: 2000, text: "a" },
      { seq: 2, startMs: 3000, endMs: 4000, text: "b" },
    ];
    const check = verifyRoundTrip(cues, "1\n00:00:01,000 --> 00:00:02,000\na\n");
    expect(check.ok).toBe(false);
    expect(check.firstDiff).toContain("缺失");
  });

  it("空文本段：导出内容可序列化但回读必然失败——因此被导出前阻塞（审计项 8）", () => {
    const cues = [{ seq: 1, startMs: 1000, endMs: 2000, text: "" }];
    const srt = serializeSrt(cues);
    const check = verifyRoundTrip(cues, srt);
    // 空段写出的 SRT 重新解析时因“字幕文本为空”报错 → 回读不通过。
    expect(check.ok).toBe(false);
    expect(check.parseErrors.some((p) => p.message.includes("文本为空"))).toBe(true);
  });

  it("长真实样本规模：24k 段导出与回读一致", () => {
    const cues = Array.from({ length: 24_000 }, (_, i) => ({
      seq: i + 1,
      startMs: i * 3000,
      endMs: i * 3000 + 2500,
      text: `第${i + 1}段的一些中文内容，包括标点。`,
    }));
    const srt = serializeSrt(cues);
    const check = verifyRoundTrip(cues, srt);
    expect(check.ok).toBe(true);
  });
});
