/**
 * 播放偏好应用（纯副作用函数，注入 audioLike 便于测试）：
 * 把保存的速度/自动回退真正应用到 HTMLAudioElement 上——
 * 挂载与元数据就绪时各调用一次，保证恢复的 0.80× 立即生效（审计 P0-3）。
 */

export interface AudioPrefsLike {
  playbackRate: number;
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
}

export interface PlaybackPrefs {
  speed: number;
  autoRewindMs?: number;
}

export function clampSpeed(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(2, Math.max(0.5, rate));
}

export function applyPlaybackPreferences(audio: AudioPrefsLike, prefs: PlaybackPrefs): void {
  audio.playbackRate = clampSpeed(prefs.speed);
  // 变速不变调：标准属性 + WebKit 兼容属性都显式设置。
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
}
