/**
 * 导出源文件保护测试（审计项 10）：
 * - checkExportTarget 用 isSameEntry 识别源文件并阻止（match）；
 * - isSameEntry 抛错 → unverifiable：默认安全，调用方必须阻止并如实说明；
 * - 无句柄（降级导入）→ 无法自动校验，文案必须降级为“请勿选择”而不是承诺保护；
 * - canVerifySources 决定文案承诺强度。
 */
import { describe, expect, it } from "vitest";
import { canVerifySources, checkExportTarget, type SourceHandleRef } from "../src/core/exportGuard.js";

function fakeHandle(isSame: (o: unknown) => Promise<boolean>) {
  return { isSameEntry: isSame };
}

describe("checkExportTarget", () => {
  const sources: SourceHandleRef[] = [
    { label: "源字幕（SRT）", handle: fakeHandle(async (o) => o === "srt-target") },
    { label: "源音频（MP3）", handle: fakeHandle(async () => false) },
  ];

  it("目标与源 SRT 是同一文件 → match（调用方阻止写出）", async () => {
    const r = await checkExportTarget("srt-target", sources);
    expect(r).toEqual({ status: "match", label: "源字幕（SRT）" });
  });

  it("目标是新文件 → clear，放行", async () => {
    expect(await checkExportTarget("new-export.srt", sources)).toEqual({ status: "clear" });
  });

  it("isSameEntry 抛错 → unverifiable（默认安全：阻止导出而不是冒险写出）", async () => {
    const throwing: SourceHandleRef[] = [
      { label: "源字幕（SRT）", handle: fakeHandle(async () => { throw new Error("permission lost"); }) },
    ];
    const r = await checkExportTarget("anything", throwing);
    expect(r).toEqual({ status: "unverifiable", reason: "permission lost" });
  });

  it("无句柄（降级导入）→ clear + canVerifySources=false（文案降级为“请勿选择”）", async () => {
    const noHandles: SourceHandleRef[] = [
      { label: "源字幕（SRT）", handle: null },
      { label: "源音频（MP3）", handle: null },
    ];
    expect(await checkExportTarget("whatever", noHandles)).toEqual({ status: "clear" });
    expect(canVerifySources(noHandles)).toBe(false);
    expect(canVerifySources(sources)).toBe(true);
  });
});
