/**
 * 字幕段列表。V0.1 使用 content-visibility 跳过屏外渲染（约 1.1k 段真实样本下流畅；
 * PRD 的完整虚拟滚动放到 V0.5，见 README 已知限制）。
 */
import { memo, useCallback, useEffect, useRef } from "react";
import { formatDisplay } from "../core/time.js";
import {
  SEGMENT_STATUS_LABEL,
  type SegmentRecord,
  type SegmentStatus,
} from "../store/types.js";

interface Props {
  segments: SegmentRecord[];
  /** 选中段（用户当前工作段；行内确认不受播放位置影响）。 */
  selectedId: string | null;
  unresolvedBySegment: Map<string, number>;
  loopSegmentId: string | null;
  onEdit: (segmentId: string, text: string, composing: boolean) => void;
  onCompositionEnd: (segmentId: string) => void;
  /** 行内确认：永远作用于被点击的 segmentId。 */
  onConfirmRow: (segmentId: string) => void;
  /** 点进/聚焦某行编辑器时，该行成为选中段（Ctrl+Enter 语义正确的前提）。 */
  onFocusRow: (segmentId: string) => void;
  onSeek: (segmentId: string, andPlay?: boolean) => void;
  onLoop: (segmentId: string) => void;
  onCreateIssue: (segmentId: string) => void;
}

interface RowProps {
  seg: SegmentRecord;
  selected: boolean;
  looping: boolean;
  unresolvedCount: number;
  onEdit: Props["onEdit"];
  onCompositionEnd: Props["onCompositionEnd"];
  onConfirmRow: Props["onConfirmRow"];
  onFocusRow: Props["onFocusRow"];
  onSeek: Props["onSeek"];
  onLoop: Props["onLoop"];
  onCreateIssue: Props["onCreateIssue"];
}

function AutoTextarea({
  value,
  onChange,
  onCompositionEnd,
  onFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string, composing: boolean) => void;
  onCompositionEnd: () => void;
  onFocus: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(resize, [value, resize]);
  return (
    <textarea
      ref={ref}
      className="seg-corrected"
      value={value}
      aria-label={ariaLabel}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value, (e.nativeEvent as InputEvent).isComposing ?? false)}
      onCompositionEnd={() => onCompositionEnd()}
    />
  );
}

const SegmentRow = memo(function SegmentRow({
  seg,
  selected,
  looping,
  unresolvedCount,
  onEdit,
  onCompositionEnd,
  onConfirmRow,
  onFocusRow,
  onSeek,
  onLoop,
  onCreateIssue,
}: RowProps) {
  // 点击行内任意位置（非按钮/链接）也把该行设为选中段。
  const selectOnPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("button") || t.closest("textarea")) return;
    onFocusRow(seg.segmentId);
  };
  return (
    <div
      className={`seg-row ${selected ? "active" : ""}`}
      data-segment-id={seg.segmentId}
      onPointerDown={selectOnPointer}
    >
      <div className="seg-meta">
        <span className="cue-time" onDoubleClick={() => onSeek(seg.segmentId, true)} title="双击从该段开始播放">
          {formatDisplay(seg.startMs)} → {formatDisplay(seg.endMs)}
        </span>
        <span className={`status-chip status-${seg.status}`}>
          {SEGMENT_STATUS_LABEL[seg.status as SegmentStatus]}
        </span>
        {unresolvedCount > 0 && (
          <span className="status-chip status-questioned">⚑ 疑点 ×{unresolvedCount}</span>
        )}
        {looping && <span className="loop-indicator">⭯ 循环中</span>}
        <span className="hint">#{seg.cueNo ?? "—"}</span>
      </div>
      <div className="seg-original" title="原始识别层（只读）">
        {seg.originalText}
      </div>
      <AutoTextarea
        value={seg.correctedText}
        ariaLabel={`校对文本 ${formatDisplay(seg.startMs)}`}
        onFocus={() => onFocusRow(seg.segmentId)}
        onChange={(v, composing) => onEdit(seg.segmentId, v, composing)}
        onCompositionEnd={() => onCompositionEnd(seg.segmentId)}
      />
      <div className="seg-actions">
        <button onClick={() => onSeek(seg.segmentId)} title="选中该段并定位到开始前 300ms（不自动播放）">
          ▶ 定位
        </button>
        <button
          onClick={() => onConfirmRow(seg.segmentId)}
          title="确认这一段（与播放位置无关）；Ctrl+Enter 确认当前选中段并跳到下一未校对段"
        >
          ✓ 确认本段
        </button>
        <button
          onClick={() => onCreateIssue(seg.segmentId)}
          title="为这一段创建疑点（默认：听不清 / 阻塞）；Ctrl+? 同"
        >
          ⚑ 疑点
        </button>
        <button onClick={() => onLoop(seg.segmentId)} title="循环播放该段时间范围（Ctrl+L）">
          ⭯ 循环
        </button>
      </div>
    </div>
  );
});

export function SegmentList({
  segments,
  selectedId,
  unresolvedBySegment,
  loopSegmentId,
  onEdit,
  onCompositionEnd,
  onConfirmRow,
  onFocusRow,
  onSeek,
  onLoop,
  onCreateIssue,
}: Props) {
  return (
    <div role="list" aria-label="字幕段列表">
      {segments.map((seg) => (
        <SegmentRow
          key={seg.segmentId}
          seg={seg}
          selected={seg.segmentId === selectedId}
          looping={seg.segmentId === loopSegmentId}
          unresolvedCount={unresolvedBySegment.get(seg.segmentId) ?? 0}
          onEdit={onEdit}
          onCompositionEnd={onCompositionEnd}
          onConfirmRow={onConfirmRow}
          onFocusRow={onFocusRow}
          onSeek={onSeek}
          onLoop={onLoop}
          onCreateIssue={onCreateIssue}
        />
      ))}
    </div>
  );
}
