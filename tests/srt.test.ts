import { describe, expect, it } from "vitest";
import { parseSrt, serializeSrt } from "../src/core/srt.js";
import { formatSrtTime } from "../src/core/time.js";

describe("formatSrtTime", () => {
  it("格式化为 HH:MM:SS,mmm", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(1600)).toBe("00:00:01,600");
    expect(formatSrtTime(3_600_000 + 65_000 + 12)).toBe("01:01:05,012");
    expect(formatSrtTime(12_290_090)).toBe("03:24:50,090");
  });
  it("负值按 0 处理", () => {
    expect(formatSrtTime(-5)).toBe("00:00:00,000");
  });
});

describe("parseSrt 严格解析", () => {
  it("解析标准 SRT（LF 与 CRLF 均可）", () => {
    const raw = "1\r\n00:00:01,600 --> 00:00:02,940\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:03,600 --> 00:00:09,460\r\n大家好\r\n";
    const r = parseSrt(raw);
    expect(r.errors).toHaveLength(0);
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ seq: 1, startMs: 1600, endMs: 2940, text: "第一行\n第二行" });
    expect(r.cues[1].startMs).toBe(3600);
  });

  it("容忍 UTF-8 BOM", () => {
    const r = parseSrt("\uFEFF1\n00:00:01,000 --> 00:00:02,000\n你好\n");
    expect(r.errors).toHaveLength(0);
    expect(r.cues[0].text).toBe("你好");
  });

  it("缺少序号时仍可解析并告警", () => {
    const r = parseSrt("00:00:01,000 --> 00:00:02,000\n无序号\n");
    expect(r.errors).toHaveLength(0);
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].seq).toBeNull();
  });

  it("拒绝点号毫秒分隔符并给出可解释错误", () => {
    const r = parseSrt("1\n00:00:01.000 --> 00:00:02.000\nWebVTT 风格\n");
    expect(r.cues).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain("逗号");
  });

  it("报告时间行之前垃圾行的行号，但不丢弃可解析的段", () => {
    const raw = "1\n00:00:01,000 --> 00:00:02,000\n好的\n\n2\n这是垃圾行\n00:00:05,000 --> 00:00:06,000\n下一段\n";
    const r = parseSrt(raw);
    expect(r.cues).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(6);
    expect(r.errors[0].message).toContain("无法解释");
  });

  it("拒绝 end <= start 与负时间", () => {
    const r = parseSrt(
      "1\n00:00:02,000 --> 00:00:01,000\n倒置\n\n2\n00:00:03,000 --> 00:00:03,000\n零长\n\n3\n-00:00:01,000 --> 00:00:01,000\n负数\n",
    );
    expect(r.cues).toHaveLength(0);
    expect(r.errors).toHaveLength(3);
  });

  it("拒绝空文本", () => {
    const r = parseSrt("1\n00:00:01,000 --> 00:00:02,000\n");
    expect(r.errors.some((e) => e.message.includes("文本为空"))).toBe(true);
  });

  it("时间行尾坐标产生告警并被忽略", () => {
    const r = parseSrt("1\n00:00:01,000 --> 00:00:02,000 X1:40 X2:600\n带坐标\n");
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.some((w) => w.message.includes("额外内容"))).toBe(true);
    expect(r.cues).toHaveLength(1);
  });

  it("拒绝分钟/秒超出 0..59 的时间码（审计项 9）", () => {
    const r = parseSrt("1\n00:99:99,999 --> 00:99:99,999\n越界\n");
    expect(r.cues).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain("00–59");
    expect(r.errors[0].message).toContain("99:99");
  });

  it("接受 59:59,999 边界；拒绝 60 分/60 秒", () => {
    const ok = parseSrt("1\n00:59:59,999 --> 01:00:00,000\n边界\n");
    expect(ok.errors).toHaveLength(0);
    expect(ok.cues[0].startMs).toBe(3_599_999);
    expect(ok.cues[0].endMs).toBe(3_600_000);

    const bad1 = parseSrt("1\n00:60:00,000 --> 00:61:00,000\n超分\n");
    expect(bad1.cues).toHaveLength(0);
    expect(bad1.errors[0].message).toContain("00–59");
    const bad2 = parseSrt("1\n00:00:60,000 --> 00:01:00,000\n超秒\n");
    expect(bad2.cues).toHaveLength(0);
    expect(bad2.errors[0].message).toContain("00–59");
  });

  it("毫秒 1–2 位：按前导零缺失解释并告警（被测试的兼容行为）", () => {
    const r = parseSrt("1\n00:00:01,5 --> 00:00:02,50\n短毫秒\n");
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.some((w) => w.message.includes("不是 3 位"))).toBe(true);
    expect(r.cues[0].startMs).toBe(1_500);
    expect(r.cues[0].endMs).toBe(2_500);
  });

  it("毫秒 ≥4 位：明确报错而不是截断解释（审计项 9）", () => {
    const r = parseSrt("1\n00:00:01,1234 --> 00:00:02,000\n长毫秒\n");
    expect(r.cues).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain("1–3 位");
  });

  it("空输入不抛异常", () => {
    const r = parseSrt("");
    expect(r.cues).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });
});

describe("serializeSrt", () => {
  it("按起始时间重排并连续编号", () => {
    const out = serializeSrt([
      { seq: 7, startMs: 5000, endMs: 6000, text: "b" },
      { seq: 3, startMs: 1000, endMs: 2000, text: "a" },
    ]);
    expect(out).toBe("1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:05,000 --> 00:00:06,000\nb\n\n");
  });

  it("拒绝时间无效的 cue 而不是静默写出", () => {
    expect(() =>
      serializeSrt([{ seq: 1, startMs: 2000, endMs: 1000, text: "bad" }]),
    ).toThrow(/时间无效/);
    expect(() =>
      serializeSrt([{ seq: 1, startMs: -1, endMs: 1000, text: "bad" }]),
    ).toThrow(/时间无效/);
  });

  it("毫秒时间码对 100 小时以上的文件仍然正确（小时允许超过两位）", () => {
    expect(formatSrtTime(360_000_000 + 1)).toBe("100:00:00,001");
  });
});

describe("往返稳定性", () => {
  it("parse(serialize(parse(x))) 结果稳定", () => {
    const raw = "1\n00:00:01,600 --> 00:00:02,940\n第一行\n第二行\n\n2\n00:00:03,600 --> 00:00:09,460\n大家好\n\n3\n00:01:00,000 --> 00:01:10,500\n[掌声]\n";
    const first = parseSrt(raw);
    const once = serializeSrt(first.cues);
    const second = parseSrt(once);
    const twice = serializeSrt(second.cues);
    expect(second.errors).toHaveLength(0);
    expect(twice).toBe(once);
    expect(second.cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual(
      first.cues.map((c) => [c.startMs, c.endMs, c.text]),
    );
  });
});
