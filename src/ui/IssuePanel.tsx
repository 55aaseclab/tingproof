/**
 * 疑点面板：标记/筛选/跳转/解决/删除；未解决数量由工作台顶栏同步显示。
 */
import { useCallback, useState } from "react";
import { formatDisplay } from "../core/time.js";
import {
  ISSUE_TYPE_LABEL,
  type IssueRecord,
  type IssueSeverity,
  type IssueType,
  type SegmentRecord,
} from "../store/types.js";

interface Props {
  issues: IssueRecord[];
  segments: SegmentRecord[];
  activeId: string | null;
  onJumpPlay: (segmentId: string) => void;
  onResolve: (issueId: string) => void;
  onDelete: (issueId: string) => void;
  onCreate: (segmentId: string, type: IssueType, severity: IssueSeverity, note: string) => void;
}

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  blocking: "阻塞",
  warning: "警告",
};

export function IssuePanel({
  issues,
  segments,
  activeId,
  onJumpPlay,
  onResolve,
  onDelete,
  onCreate,
}: Props) {
  const [openOnly, setOpenOnly] = useState(true);
  const [formFor, setFormFor] = useState<string | null>(null);
  const [formType, setFormType] = useState<IssueType>("unclear");
  const [formSeverity, setFormSeverity] = useState<IssueSeverity>("blocking");
  const [formNote, setFormNote] = useState("");

  /**
   * 打开新建疑点表单（PRD V1.0.3）：
   * 疑点类型必须重置为默认“听不清”，不得沿用上一次保存或取消前选择的专名、数字等类型；
   * 表单打开后用户仍可改选。
   */
  const openIssueForm = useCallback(() => {
    if (!activeId) return;
    setFormType("unclear");
    setFormFor(activeId);
  }, [activeId]);

  const visible = openOnly ? issues.filter((i) => i.status === "open") : issues;
  const unresolvedCount = issues.filter((i) => i.status === "open").length;
  const blockingCount = issues.filter((i) => i.status === "open" && i.severity === "blocking").length;
  const segmentById = new Map(segments.map((s) => [s.segmentId, s]));

  return (
    <aside className="wb-side" aria-label="疑点面板">
      <h3>
        疑点（未解决 {unresolvedCount} · 阻塞 {blockingCount}）
      </h3>
      <div className="issue-form">
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          只看未解决
        </label>
        {formFor === null ? (
          <>
            <button
              disabled={!activeId}
              onClick={openIssueForm}
              title="为当前播放所在字幕段创建带表单的疑点"
            >
              为当前段新建疑点（表单）
            </button>
            <div className="hint">
              行内“⚑ 疑点”按钮会直接创建默认疑点（听不清 / 阻塞）；
              快捷键 <span className="kbd">Ctrl</span>+<span className="kbd">?</span> 同。
            </div>
          </>
        ) : (
          <>
            <div className="hint">
              新建疑点：{formatDisplay(segmentById.get(formFor)?.startMs ?? 0)}
            </div>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value as IssueType)}
              aria-label="疑点类型"
            >
              {(Object.keys(ISSUE_TYPE_LABEL) as IssueType[]).map((t) => (
                <option key={t} value={t}>
                  {ISSUE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select
              value={formSeverity}
              onChange={(e) => setFormSeverity(e.target.value as IssueSeverity)}
              aria-label="严重级别"
            >
              <option value="blocking">阻塞（影响最终导出）</option>
              <option value="warning">警告</option>
            </select>
            <textarea
              value={formNote}
              placeholder="备注：现象、候选写法、已尝试的听辨方法…"
              onChange={(e) => setFormNote(e.target.value)}
              rows={3}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="primary"
                onClick={() => {
                  if (!formFor) return;
                  onCreate(formFor, formType, formSeverity, formNote);
                  setFormFor(null);
                  setFormNote("");
                }}
              >
                保存疑点
              </button>
              <button onClick={() => setFormFor(null)}>取消</button>
            </div>
          </>
        )}
      </div>

      <div className="issue-list">
        {visible.length === 0 ? (
          <div className="empty-state" style={{ margin: "24px auto" }}>
            {openOnly ? "当前没有未解决疑点。" : "还没有任何疑点记录。"}
          </div>
        ) : (
          visible.map((issue) => {
            const seg = segmentById.get(issue.segmentId);
            return (
              <div
                key={issue.issueId}
                className={`issue-item ${issue.status === "resolved" ? "resolved" : ""} ${
                  issue.segmentId === activeId ? "active" : ""
                }`}
              >
                <div className="issue-meta">
                  <span className={`status-chip ${issue.severity === "blocking" ? "status-questioned" : "status-editing"}`}>
                    {SEVERITY_LABEL[issue.severity]}
                  </span>
                  <span>{ISSUE_TYPE_LABEL[issue.type]}</span>
                  <span className="cue-time">
                    {formatDisplay(issue.startMs)} → {formatDisplay(issue.endMs)}
                  </span>
                  <span>#{seg?.cueNo ?? "—"}</span>
                </div>
                {issue.note && <div className="issue-note">{issue.note}</div>}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => onJumpPlay(issue.segmentId)} title="选中该段并从其段首播放">⤓ 跳转播放</button>
                  {issue.status === "open" && (
                    <button onClick={() => onResolve(issue.issueId)}>✔ 已解决</button>
                  )}
                  <button className="danger" onClick={() => onDelete(issue.issueId)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="side-footer">
        导出前会显示未解决疑点数量；阻塞级疑点建议处理完再导出最终稿。
      </div>
    </aside>
  );
}
