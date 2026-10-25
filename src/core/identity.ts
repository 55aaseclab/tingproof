/** 项目/媒体身份：不依赖 basename，防止同名文件碰撞。 */

export function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // 兜底（老环境）：RFC4122 v4 形式。
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * PRD 3.1.5：去扩展名、NFKC、去首尾空白、连续空白折叠为单个半角空格。
 * 用于配对键与显示名。
 */
export function normalizeName(fileName: string): string {
  const stem = fileName.replace(/\.[^./\\]+$/, "");
  return stem.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export interface MediaIdentityInput {
  audioName: string;
  audioSize: number;
  audioLastModified: number;
  srtName: string;
  srtRawSha256: string;
  /** 轻量音频身份指纹（computeAudioFingerprint），参与项目 ID，防止同名同大小不同内容碰撞。 */
  audioFingerprint: string;
}

/**
 * mediaKey = SHA-256(规范化音频名 | 音频大小 | 音频修改时间 | 音频指纹 | 规范化字幕名 | SRT 内容哈希)。
 * 同名但内容不同（大小、修改时间、音频指纹、字幕任一不同）会得到不同项目身份。
 */
export async function computeMediaKey(input: MediaIdentityInput): Promise<string> {
  const canonical = [
    normalizeName(input.audioName),
    String(input.audioSize),
    String(input.audioLastModified),
    input.audioFingerprint,
    normalizeName(input.srtName),
    input.srtRawSha256,
  ].join("|");
  return sha256Hex(canonical);
}

export function projectIdFromMediaKey(mediaKey: string): string {
  return `tp-${mediaKey.slice(0, 20)}`;
}

const AUDIO_FP_VERSION = "afp1";
/** 音频指纹采样块大小：首尾各 64KB（对 GB 级文件也只需读 128KB）。 */
export const AUDIO_FP_CHUNK = 64 * 1024;

/**
 * 轻量音频身份指纹：文件大小 + 首/尾 64KB 的 SHA-256。
 * 不同编码器/不同录音几乎必然在首尾字节不同；重定位时用于验证“是同一场录音”。
 * 不复制、不存储任何音频内容，只返回 64 字符哈希。
 */
export async function computeAudioFingerprint(blob: Blob): Promise<string> {
  const size = blob.size;
  const head = new Uint8Array(await blob.slice(0, Math.min(AUDIO_FP_CHUNK, size)).arrayBuffer());
  const headHash = await sha256Hex(head);
  let tailHash = "";
  if (size > AUDIO_FP_CHUNK) {
    const tail = new Uint8Array(await blob.slice(size - AUDIO_FP_CHUNK, size).arrayBuffer());
    tailHash = await sha256Hex(tail);
  }
  return sha256Hex(`${AUDIO_FP_VERSION}|${size}|${headHash}|${tailHash}`);
}
