/**
 * 旧项目音频重连策略（纯函数，审计 P0-4）。
 *
 * 三种结局：
 * - accept：项目已记录身份指纹且与所选文件一致 → 直接重连；
 * - reject：指纹不一致，或旧项目按文件名/大小核对失败 → 拒绝并说明；
 * - confirm-establish：旧项目没有任何可用指纹（迁移也无法从遗留正文补齐）→
 *   按记录中的 size 与规范化文件名核对，一致时要求用户显式确认
 *   「首次建立音频身份」，确认后才写入新指纹。绝不无提示接受，也保证旧项目可恢复。
 */

import { normalizeName } from "./identity.js";

export interface RelocateRecord {
  audioFingerprint?: string | null;
  audioSize?: number | null;
  audioName?: string | null;
}

export interface RelocatePicked {
  fingerprint: string;
  size: number;
  name: string;
}

export type RelocateDecision =
  | { action: "accept"; fingerprint: string }
  | { action: "reject"; reason: string }
  | { action: "confirm-establish"; fingerprint: string; reason: string };

export function decideRelocate(
  recorded: RelocateRecord | null | undefined,
  picked: RelocatePicked,
): RelocateDecision {
  const recordedFp = (recorded?.audioFingerprint ?? "").trim();
  if (recordedFp) {
    if (recordedFp === picked.fingerprint) {
      return { action: "accept", fingerprint: picked.fingerprint };
    }
    return {
      action: "reject",
      reason:
        "所选音频与项目记录的身份指纹不一致——它可能不是同一场录音，已拒绝连接。请选择导入时的原始 MP3 文件；两个文件都未被修改。",
    };
  }

  // 旧项目：没有可用指纹（迁移也未能从遗留正文补齐）。
  const nameOk =
    typeof recorded?.audioName === "string" && recorded.audioName.length > 0
      ? normalizeName(recorded.audioName) === normalizeName(picked.name)
      : true;
  const sizeOk =
    typeof recorded?.audioSize === "number" && recorded.audioSize > 0
      ? recorded.audioSize === picked.size
      : true;
  if (!nameOk || !sizeOk) {
    const why: string[] = [];
    if (!nameOk) why.push("规范化文件名不一致");
    if (!sizeOk) why.push("文件大小不一致");
    return {
      action: "reject",
      reason: `旧项目只能按记录中的文件名与大小核对：${why.join("、")}。已拒绝连接，请确认选择该项目导入时的原始 MP3。`,
    };
  }
  return {
    action: "confirm-establish",
    fingerprint: picked.fingerprint,
    reason:
      "这是旧版项目首次建立音频身份：已按记录中的文件名与大小核对一致（旧数据没有内容指纹可比对）。确认后将以本次所选文件作为该项目的音频，并写入身份指纹。",
  };
}
