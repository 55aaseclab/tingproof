/**
 * 旧项目音频重连决策测试（审计 P0-4）。
 * 锁定：有指纹时严格比对；旧项目（无指纹）按规范化文件名+大小核对；
 * 核对通过也只能 confirm-establish（用户显式确认），绝不无提示接受；任何不一致都拒绝。
 */
import { describe, expect, it } from "vitest";
import { decideRelocate } from "../src/core/legacyReconnect.js";

describe("decideRelocate", () => {
  const fpRecorded = "afp1|1|aa|bb";

  it("已有指纹且匹配 → accept（正常项目的重连）", () => {
    const r = decideRelocate(
      { audioFingerprint: fpRecorded, audioSize: 100, audioName: "a.mp3" },
      { fingerprint: fpRecorded, size: 100, name: "a.mp3" },
    );
    expect(r).toEqual({ action: "accept", fingerprint: fpRecorded });
  });

  it("已有指纹但不匹配 → reject（不能把字幕配到错误录音）", () => {
    const r = decideRelocate(
      { audioFingerprint: fpRecorded, audioSize: 100, audioName: "a.mp3" },
      { fingerprint: "afp1|1|cc|dd", size: 100, name: "a.mp3" },
    );
    expect(r.action).toBe("reject");
  });

  it("旧项目：规范化文件名与大小一致 → confirm-establish（要求用户确认，不无提示接受）", () => {
    const r = decideRelocate(
      { audioFingerprint: "", audioSize: 98_320_717, audioName: "青创 一   1   7月25日 上午9点10分.mp3" },
      { fingerprint: "fp-new", size: 98_320_717, name: "青创 一 1 7月25日 上午9点10分.mp3" },
    );
    expect(r.action).toBe("confirm-establish");
    if (r.action === "confirm-establish") expect(r.fingerprint).toBe("fp-new");
  });

  it("旧项目：大小不一致 → reject", () => {
    const r = decideRelocate(
      { audioFingerprint: null, audioSize: 100, audioName: "a.mp3" },
      { fingerprint: "fp", size: 200, name: "a.mp3" },
    );
    expect(r.action).toBe("reject");
    if (r.action === "reject") expect(r.reason).toContain("大小");
  });

  it("旧项目：规范化文件名不一致 → reject", () => {
    const r = decideRelocate(
      { audioFingerprint: "", audioSize: 100, audioName: "第一场.mp3" },
      { fingerprint: "fp", size: 100, name: "第二场  [注：不同录音].mp3" },
    );
    expect(r.action).toBe("reject");
    if (r.action === "reject") expect(r.reason).toContain("文件名");
  });

  it("旧项目连 size/name 都缺失 → 仍走 confirm-establish（旧项目可恢复，不永久锁死）", () => {
    const r = decideRelocate({ audioFingerprint: "" }, { fingerprint: "fp", size: 1, name: "x.mp3" });
    expect(r.action).toBe("confirm-establish");
  });

  it("指纹为空白字符串视同无指纹（迁移失败的遗留记录）", () => {
    const r = decideRelocate(
      { audioFingerprint: "   ", audioSize: 100, audioName: "a.mp3" },
      { fingerprint: "fp", size: 100, name: "a.mp3" },
    );
    expect(r.action).toBe("confirm-establish");
  });
});
