/**
 * 音频源解析与指纹校验测试（审计项 2/4）：
 * - 会话内 File 指纹不匹配 → 拒绝并标记 fingerprintMismatch（防止配错录音）；
 * - 指纹匹配 → 正常返回；无指纹的旧项目 → 接受但明确为“无法验证”路径；
 * - 既无句柄也无会话文件 → needsRelocate；
 * - File 绝不入库：resolveAudioFile 只读取，不写任何存储。
 */
import { describe, expect, it } from "vitest";
import { resolveAudioFile } from "../src/core/audioSource.js";
import { computeAudioFingerprint } from "../src/core/identity.js";
import type { ProjectMeta } from "../src/store/types.js";

function makeFile(bytes: Uint8Array, name = "audio.mp3"): File {
  return new File([bytes as BlobPart], name, { type: "audio/mpeg" });
}

function makeMeta(fingerprint: string | null): ProjectMeta {
  return {
    projectId: "tp-audio-test",
    name: "测试项目",
    normalizedStem: "测试项目",
    createdAt: 1,
    updatedAt: 1,
    media: {
      audioName: "audio.mp3",
      audioSize: 200_000,
      audioLastModified: 1,
      audioFingerprint: fingerprint ?? "",
      srtFileName: "a.srt",
      srtSha256: "x",
      mediaKey: "k",
      durationMs: null,
      srtHandle: null,
      audioHandle: null,
    },
    playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
  };
}

describe("resolveAudioFile", () => {
  it("会话文件指纹匹配 → 返回文件", async () => {
    const file = makeFile(new Uint8Array(200_000).fill(7));
    const fp = await computeAudioFingerprint(file);
    const r = await resolveAudioFile(makeMeta(fp), file);
    expect(r.needsRelocate).toBe(false);
    expect(r.fingerprintMismatch).toBe(false);
    expect(r.file).toBe(file);
  });

  it("会话文件指纹不匹配 → 拒绝（fingerprintMismatch=true），防止把字幕配到错误录音", async () => {
    const fileA = makeFile(new Uint8Array(200_000).fill(7));
    const fileB = makeFile(new Uint8Array(200_000).fill(9), "audio.mp3");
    const fpA = await computeAudioFingerprint(fileA);
    const r = await resolveAudioFile(makeMeta(fpA), fileB);
    expect(r.file).toBeNull();
    expect(r.fingerprintMismatch).toBe(true);
    expect(r.needsRelocate).toBe(true);
  });

  it("旧项目无指纹 → 接受会话文件（无法验证，由界面文案说明）", async () => {
    const file = makeFile(new Uint8Array(200_000).fill(7));
    const r = await resolveAudioFile(makeMeta(null), file);
    expect(r.file).toBe(file);
    expect(r.fingerprintMismatch).toBe(false);
  });

  it("既无句柄也无会话文件 → 需要重新定位", async () => {
    const fp = "afp1|x|y|z";
    const r = await resolveAudioFile(makeMeta(fp), null);
    expect(r.file).toBeNull();
    expect(r.needsRelocate).toBe(true);
    expect(r.fingerprintMismatch).toBe(false);
  });

  it("会话文件失效（不可读）→ 需要重新定位", async () => {
    const fp = "afp1|x|y|z";
    const broken = {
      size: 1,
      slice: () => {
        throw new Error("NotReadableError");
      },
    } as unknown as File;
    const r = await resolveAudioFile(makeMeta(fp), broken);
    expect(r.needsRelocate).toBe(true);
  });
});
