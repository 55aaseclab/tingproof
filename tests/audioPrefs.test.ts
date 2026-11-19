/**
 * 播放偏好应用测试（审计 P0-3）：
 * applyPlaybackPreferences 必须把保存的速度真正写入播放元素的 playbackRate
 * （修复：此前初始速度只进 React state，实际播放仍是 1.0×），并开启变速不变调。
 * 用 audioLike 桩验证赋值行为；真实 <audio> 的端到端行为归入浏览器人工验证。
 */
import { describe, expect, it } from "vitest";
import { applyPlaybackPreferences, clampSpeed, type AudioPrefsLike } from "../src/core/audioPrefs.js";

function makeAudioLike(): AudioPrefsLike {
  return { playbackRate: 1, preservesPitch: false, webkitPreservesPitch: false };
}

describe("applyPlaybackPreferences", () => {
  it("恢复 0.80×：playbackRate 被实际写入（而非只改 React state）", () => {
    const audio = makeAudioLike();
    applyPlaybackPreferences(audio, { speed: 0.8 });
    expect(audio.playbackRate).toBe(0.8);
  });

  it("变速不变调标志被开启（标准 + WebKit 属性）", () => {
    const audio = makeAudioLike();
    applyPlaybackPreferences(audio, { speed: 1.5 });
    expect(audio.preservesPitch).toBe(true);
    expect(audio.webkitPreservesPitch).toBe(true);
  });

  it("越界速度被钳制到 0.5–2.0；非法值回退 1.0", () => {
    expect(clampSpeed(0.2)).toBe(0.5);
    expect(clampSpeed(3)).toBe(2);
    expect(clampSpeed(Number.NaN)).toBe(1);
    const audio = makeAudioLike();
    applyPlaybackPreferences(audio, { speed: 9 });
    expect(audio.playbackRate).toBe(2);
  });
});
