/**
 * 导出目标保护：阻止把导出写到源字幕/源音频文件上。
 * 依赖 File System Access 的 isSameEntry（同一底层文件判定为相同），
 * 不依赖路径字符串（浏览器出于安全不暴露完整路径）。
 *
 * 三态结果（默认安全）：
 * - match：目标就是某个源文件 → 必须阻止；
 * - clear：所有源句柄都比较通过（或项目本就没有句柄）→ 放行；
 * - unverifiable：句柄存在但比较失败（如权限丢失）→ 放行前无法验证，
 *   调用方应默认阻止并如实说明。
 */

export interface SourceHandleRef {
  /** 出错提示用的可读名称，如 “源字幕（SRT）”。 */
  label: string;
  /** 无句柄（降级导入）时为 null，表示无法自动校验。 */
  handle: {
    isSameEntry?: (other: never) => Promise<boolean>;
  } | null;
}

export type ExportGuardResult =
  | { status: "match"; label: string }
  | { status: "clear" }
  | { status: "unverifiable"; reason: string };

export async function checkExportTarget(
  target: unknown,
  sources: SourceHandleRef[],
): Promise<ExportGuardResult> {
  for (const src of sources) {
    const isSame = src.handle?.isSameEntry;
    if (typeof isSame !== "function") continue;
    try {
      if (await isSame.call(src.handle, target as never)) {
        return { status: "match", label: src.label };
      }
    } catch (err) {
      return {
        status: "unverifiable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { status: "clear" };
}

/** 是否所有给定的源句柄都可用于自动校验（决定导出文案的承诺强度）。 */
export function canVerifySources(sources: SourceHandleRef[]): boolean {
  return sources.length > 0 && sources.every((s) => typeof s.handle?.isSameEntry === "function");
}
