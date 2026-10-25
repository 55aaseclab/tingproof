/**
 * 音频源解析：从项目元数据 +（可选）会话内 File 恢复可播放的 File。
 * - FS Access：优先用持久化句柄，必要时请求一次只读权限，并用音频指纹验证身份；
 * - 降级路径：仅当本会话内还持有导入时的 File（不落库）；
 * - 指纹不匹配 → 明确拒绝（needsRelocate + fingerprintMismatch），防止把字幕配到错误录音。
 */

import { computeAudioFingerprint } from "./identity.js";
import type { ProjectMeta } from "../store/types.js";

export interface ResolvedAudio {
  file: File | null;
  needsRelocate: boolean;
  /** true 表示只需一次权限确认即可访问（不是文件丢失）。 */
  needsPermission: boolean;
  /** true 表示找到了文件但身份指纹与项目记录不一致（拒绝使用）。 */
  fingerprintMismatch: boolean;
}

type PermissionState = "granted" | "denied" | "prompt";

export async function resolveAudioFile(
  meta: ProjectMeta,
  sessionFile?: File | null,
): Promise<ResolvedAudio> {
  const storedFp = meta.media.audioFingerprint;

  const verify = async (file: File): Promise<ResolvedAudio | null> => {
    if (!storedFp) return null; // 旧项目无指纹：无法验证，明确交给调用方文案处理
    const fp = await computeAudioFingerprint(file);
    if (fp !== storedFp) {
      return { file: null, needsRelocate: true, needsPermission: false, fingerprintMismatch: true };
    }
    return null; // 验证通过，继续使用
  };

  const handle = meta.media.audioHandle;
  if (handle) {
    try {
      const h = handle as unknown as {
        queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
        requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
      };
      let perm: PermissionState = "granted";
      if (h.queryPermission) perm = await h.queryPermission({ mode: "read" });
      if (perm === "prompt" && h.requestPermission) {
        try {
          perm = await h.requestPermission({ mode: "read" });
        } catch {
          perm = "prompt";
        }
      }
      if (perm === "denied") {
        return { file: null, needsRelocate: true, needsPermission: false, fingerprintMismatch: false };
      }
      if (perm === "prompt") {
        return { file: null, needsRelocate: true, needsPermission: true, fingerprintMismatch: false };
      }
      const file = await handle.getFile();
      const mismatch = await verify(file);
      if (mismatch) return mismatch;
      return { file, needsRelocate: false, needsPermission: false, fingerprintMismatch: false };
    } catch {
      return { file: null, needsRelocate: true, needsPermission: false, fingerprintMismatch: false };
    }
  }

  if (sessionFile) {
    try {
      await sessionFile.slice(0, 1).arrayBuffer();
      const mismatch = await verify(sessionFile);
      if (mismatch) return mismatch;
      return { file: sessionFile, needsRelocate: false, needsPermission: false, fingerprintMismatch: false };
    } catch {
      // 会话内 File 已失效（浏览器重启后引用失效等）。
    }
  }

  return { file: null, needsRelocate: true, needsPermission: false, fingerprintMismatch: false };
}
