import { describe, expect, it } from "vitest";
import {
  computeAudioFingerprint,
  computeMediaKey,
  normalizeName,
  projectIdFromMediaKey,
  sha256Hex,
} from "../src/core/identity.js";

describe("normalizeName（PRD 3.1.5 配对键）", () => {
  it("折叠连续空格、去首尾空白、去扩展名", () => {
    expect(normalizeName("青创 一   1   7月25日 上午9点10分.mp3")).toBe(
      "青创 一 1 7月25日 上午9点10分",
    );
    expect(normalizeName("青创 一 1 7月25日 上午9点10分.srt")).toBe(
      "青创 一 1 7月25日 上午9点10分",
    );
  });

  it("NFKC 规范化（全角数字/字母转半角）", () => {
    expect(normalizeName("第１讲ＡＢＣ.mp3")).toBe("第1讲ABC");
  });

  it("制表符等空白同样折叠", () => {
    expect(normalizeName("a\t\tb\t c.wav")).toBe("a b c");
  });
});

describe("项目身份不依赖 basename", () => {
  const base = {
    audioName: "青创 一   1   7月25日 上午9点10分.mp3",
    srtName: "青创 一 1 7月25日 上午9点10分.srt",
  };
  const input = (over: Partial<Parameters<typeof computeMediaKey>[0]> = {}) => ({
    ...base,
    audioSize: 100,
    audioLastModified: 1,
    srtRawSha256: "aa",
    audioFingerprint: "fp-1",
    ...over,
  });

  it("同名不同大小/修改时间 → 不同 mediaKey", async () => {
    const k1 = await computeMediaKey(input({ audioSize: 100 }));
    const k2 = await computeMediaKey(input({ audioSize: 200 }));
    const k3 = await computeMediaKey(input({ audioLastModified: 2 }));
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it("同名不同字幕内容 → 不同 mediaKey", async () => {
    const k1 = await computeMediaKey(input({ srtRawSha256: "aa" }));
    const k2 = await computeMediaKey(input({ srtRawSha256: "bb" }));
    expect(k1).not.toBe(k2);
  });

  it("同名同大小同时间但音频指纹不同 → 不同 mediaKey（审计项 4）", async () => {
    const k1 = await computeMediaKey(input({ audioFingerprint: "fp-1" }));
    const k2 = await computeMediaKey(input({ audioFingerprint: "fp-2" }));
    expect(k1).not.toBe(k2);
  });

  it("同一文件的重复导入 → 稳定 mediaKey（可恢复会话）", async () => {
    const k1 = await computeMediaKey(
      input({ audioSize: 98_320_717, audioLastModified: 1_754_400_000, srtRawSha256: "cc", audioFingerprint: "fp-3" }),
    );
    const k2 = await computeMediaKey(
      input({ audioSize: 98_320_717, audioLastModified: 1_754_400_000, srtRawSha256: "cc", audioFingerprint: "fp-3" }),
    );
    expect(k1).toBe(k2);
    expect(projectIdFromMediaKey(k1)).toMatch(/^tp-[0-9a-f]{20}$/);
  });

  it("sha256Hex 对已知输入返回正确摘要", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("音频身份指纹（轻量：size + 首/尾 64KB，不复制全量）", () => {
  function makeFile(bytes: Uint8Array, name: string): File {
    return new File([bytes as BlobPart], name, { type: "audio/mpeg" });
  }

  it("相同内容与名字 → 相同指纹", async () => {
    const a = makeFile(new Uint8Array(200_000).fill(7), "a.mp3");
    const b = makeFile(new Uint8Array(200_000).fill(7), "a.mp3");
    expect(await computeAudioFingerprint(a)).toBe(await computeAudioFingerprint(b));
  });

  it("同名同大小但内容不同 → 不同指纹（审计项 4 回归）", async () => {
    const a = makeFile(new Uint8Array(200_000).fill(7), "a.mp3");
    const b = makeFile(new Uint8Array(200_000).fill(8), "a.mp3");
    expect(a.size).toBe(b.size);
    expect(await computeAudioFingerprint(a)).not.toBe(await computeAudioFingerprint(b));
  });

  it("只有尾部字节不同 → 指纹不同（尾部块参与计算）", async () => {
    const a = new Uint8Array(200_000).fill(1);
    const b = new Uint8Array(200_000).fill(1);
    b[199_999] = 2;
    expect(await computeAudioFingerprint(makeFile(a, "x.mp3"))).not.toBe(
      await computeAudioFingerprint(makeFile(b, "x.mp3")),
    );
  });

  it("小于采样块的文件也能计算（size 参与）", async () => {
    const a = makeFile(new Uint8Array(10).fill(3), "tiny.mp3");
    const b = makeFile(new Uint8Array(11).fill(3), "tiny.mp3");
    expect(await computeAudioFingerprint(a)).not.toBe(await computeAudioFingerprint(b));
    expect(await computeAudioFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
