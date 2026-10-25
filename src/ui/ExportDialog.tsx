/**
 * 导出对话框：
 * - 导出前显示未解决疑点数量与空文本段数量；
 * - 空文本段为阻塞项（空段导出后必然无法通过回读校验），必须先修复；
 * - 源文件保护文案按能力如实区分：有源句柄时自动阻止选到源文件；无句柄时明确“无法自动校验”。
 */
import { useCallback, useState } from "react";
import type { ExportPreview } from "../core/exportSrt.js";

interface Props {
  /** 打开对话框时才计算全量预览（V1.0.5 AC-048：不在输入路径上逐键重建）。 */
  computePreview: () => ExportPreview;
  suggestedName: string;
  fsAccess: boolean;
  /** true = 导出时能用 isSameEntry 自动阻止写到源文件上。 */
  sourceGuardReady: boolean;
  onExport: (fileName: string) => Promise<string>;
  onClose: () => void;
}

export function ExportDialog({
  computePreview,
  suggestedName,
  fsAccess,
  sourceGuardReady,
  onExport,
  onClose,
}: Props) {
  const [fileName, setFileName] = useState(suggestedName);
  const [preview] = useState(computePreview); // 仅在打开时计算一次
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [ack, setAck] = useState(false);

  const blocking = preview.unresolvedBlocking;
  const warnings = preview.unresolvedWarning;
  const emptyText = preview.emptyTextCount;
  const exportBlocked = emptyText > 0;

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const msg = await onExport(fileName);
      setResult({ ok: true, text: msg });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setResult({ ok: true, text: "已取消（未写出任何文件）。" });
      } else {
        setResult({
          ok: false,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setBusy(false);
    }
  }, [fileName, onExport]);

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" aria-label="导出 SRT">
      <div className="modal">
        <h2>导出逐字校对层为 SRT</h2>
        <div className="stat-row">
          <span>字幕段：{preview.segmentCount}</span>
          <span className={blocking > 0 ? "notice-err" : "notice-ok"}>
            ⚑ 未解决阻塞疑点：{blocking}
          </span>
          <span className={warnings > 0 ? "notice-warn" : "notice-ok"}>
            未解决警告疑点：{warnings}
          </span>
          <span className={emptyText > 0 ? "notice-err" : "notice-ok"}>
            空文本段：{emptyText}
          </span>
        </div>
        {exportBlocked && (
          <div className="notice-err">
            ✖ 存在 {emptyText} 个空文本段：空段写入 SRT 后无法通过“重新解析回读”校验，
            因此导出被阻塞。请补全这些段的文本（或将内容恢复为原文）后再导出。
          </div>
        )}
        <div className="hint">
          导出为非破坏性：应用只会写出一个新文件，不会主动修改源 MP3 / 源 SRT，也不会改动项目数据。
          {fsAccess
            ? sourceGuardReady
              ? "已启用源文件保护：保存时若选择到源 SRT 或源音频文件本身，将被自动阻止（未写出任何内容）。"
              : "注意：该项目没有保存源文件的浏览器句柄，无法自动校验所选位置——请在保存对话框中不要选择源 SRT / 源 MP3 本身。"
            : "当前环境不支持 File System Access API，将退级为浏览器下载；下载不会覆盖已有文件。内容会在写出前于内存中自检。"}
        </div>
        {blocking > 0 && (
          <div className="notice-warn">
            存在未解决的阻塞疑点。样机不阻止带疑点的草稿导出，但建议处理后再导出最终稿。
            <label style={{ display: "block", marginTop: 6 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{" "}
              我知道仍有未解决疑点，仍要导出草稿
            </label>
          </div>
        )}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          文件名
          <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
        </label>
        {result && (
          <div className={`export-result ${result.ok ? "ok" : "bad"}`}>{result.text}</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={busy || exportBlocked || (blocking > 0 && !ack)}
            onClick={() => void run()}
          >
            {busy ? "导出中…" : "导出"}
          </button>
        </div>
      </div>
    </div>
  );
}
