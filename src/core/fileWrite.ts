/**
 * 浏览器环境下的安全文件写出（重构版）。
 *
 * 流程：pickSaveTarget（选择目标）→ 调用方做源文件保护检查 → writeToHandle / downloadText。
 *
 * 说明（不要夸大）：
 * - FS Access 路径：浏览器把内容写入临时文件，close() 成功时才替换目标文件；
 *   写入过程出错时调用 abort() 丢弃临时内容，不产生“半份文件替换”的含混结果。
 * - 降级路径：Blob 下载，由用户在浏览器里选择保存位置，不会覆盖已有文件。
 * - 两种路径都不会由应用主动触碰源音频/源字幕；FS Access 下另由 exportGuard 阻止用户选到源文件。
 */

export interface WritableLike {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
}

export interface SaveHandle {
  name: string;
  getFile: () => Promise<File>;
  isSameEntry?: (other: unknown) => Promise<boolean>;
  createWritable: () => Promise<WritableLike>;
}

export type SaveTarget =
  | { mode: "fs"; handle: SaveHandle }
  | { mode: "download"; name: string };

export function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** 打开“另存为”对话框；用户取消时抛 AbortError（调用方按“已取消”处理）。 */
export async function pickSaveTarget(
  suggestedName: string,
  acceptExtension = ".srt",
): Promise<SaveTarget> {
  if (supportsFileSystemAccess()) {
    const handle = await (
      window as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<SaveHandle>;
      }
    ).showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: acceptExtension === ".srt" ? "SRT 字幕" : "文本文件",
          accept: { "application/x-subrip": [acceptExtension] },
        },
      ],
    });
    return { mode: "fs", handle };
  }
  return { mode: "download", name: suggestedName };
}

/**
 * 写入并关闭。失败时 abort 丢弃临时内容（不 commit 半份文件），然后抛出原始错误。
 */
export async function writeToHandle(handle: SaveHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort?.();
    } catch {
      // abort 失败可忽略：close 未成功调用时浏览器不会替换目标文件。
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function readHandleText(handle: SaveHandle): Promise<string> {
  return (await handle.getFile()).text();
}

/** 降级路径：Blob 下载。浏览器决定保存位置，不会覆盖已有文件。 */
export async function downloadText(name: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: "application/x-subrip;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
