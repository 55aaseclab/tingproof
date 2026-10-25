/**
 * 字幕段列表（PRD V1.0.2 §3.3.5）。
 * - 点击行内非操作区域 / 聚焦校对文本框 → onLocate（选中 + 精确定位 startMs，不自动播放）；
 * - 行内主操作是播放/暂停开关：未播放显示“▶ 播放”，播放中显示“⏸ 暂停”，可访问名称同步；
 * - 按钮事件不冒泡触发行定位；双击时间码等价于该行播放/暂停开关。
 * 渲染优化：content-visibility 跳过屏外渲染（约 1.1k 段真实样本下流畅）。
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
  /** 正在播放的段（= 选中段且处于播放状态）；用于行内按钮的动态文案。 */
  playingSegmentId: string | null;
  unresolvedBySegment: Map<string, number>;
  loopSegmentId: string | null;
  onEdit: (segmentId: string, text: string, composing: boolean) => void;
  onCompositionEnd: (segmentId: string) => void;
  /** 行内确认：永远作用于被点击的 segmentId。 */
  onConfirmRow: (segmentId: string) => void;
  /** 点击非操作区域 / 聚焦文本框：选中并定位 startMs，不自动播放。 */
  onLocate: (segmentId: string) => void;
  /** 行内播放/暂停开关（含双击时间码）。 */
  onTogglePlay: (segmentId: string) => void;
  onLoop: (segmentId: string) => void;
  onCreateIssue: (segmentId: string) => void;
}

interface RowProps {
  seg: SegmentRecord;
  selected: boolean;
  playing: boolean;
  looping: boolean;
  unresolvedCount: number;
  onEdit: Props["onEdit"];
  onCompositionEnd: Props["onCompositionEnd"];
  onConfirmRow: Props["onConfirmRow"];
  onLocate: Props["onLocate"];
  onTogglePlay: Props["onTogglePlay"];
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
  playing,
  looping,
  unresolvedCount,
  onEdit,
  onCompositionEnd,
  onConfirmRow,
  onLocate,
  onTogglePlay,
  onLoop,
  onCreateIssue,
}: RowProps) {
  // 点击行内非操作区域（按钮/文本框之外）= 定位，不播放。
  const locateOnPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // 操作区（按钮、文本框、时间码）不触发行定位：时间码是播放/暂停开关的一部分，
    // 真实双击的前置 pointerdown 不能被当成行定位（审计项 2）。
    if (t.closest("button") || t.closest("textarea") || t.closest(".cue-time")) return;
    onLocate(seg.segmentId);
  };
  const toggle = () => onTogglePlay(seg.segmentId);
  return (
    <div
      className={`seg-row ${selected ? "active" : ""}`}
      data-segment-id={seg.segmentId}
      onPointerDown={locateOnPointer}
    >
      <div className="seg-meta">
        <span
          className="cue-time"
          onDoubleClick={toggle}
          title="双击 = 该段播放/暂停开关"
        >
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
        onFocus={() => onLocate(seg.segmentId)}
        onChange={(v, composing) => onEdit(seg.segmentId, v, composing)}
        onCompositionEnd={() => onCompositionEnd(seg.segmentId)}
      />
      <div className="seg-actions">
        <button
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
          title={
            playing
              ? "暂停：停在当前位置，不会回跳段首"
              : "播放：选中该段并从段首开始（段尾自动暂停；循环模式除外）"
          }
        >
          {playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
        <button
          onClick={() => onConfirmRow(seg.segmentId)}
          title="确认这一段（与播放位置无关）；Ctrl+Enter 确认当前选中段并定位下一未校对段段首"
        >
          ✓ 确认本段
        </button>
        <button
          onClick={() => onCreateIssue(seg.segmentId)}
          title="为这一段创建疑点（默认：听不清 / 阻塞）；Ctrl+? 同"
        >
          ⚑ 疑点
        </button>
        <button onClick={() => onLoop(seg.segmentId)} title="循环播放该段时间范围（Ctrl+L）；唯一的段尾回段首继续模式">
          ⭯ 循环
        </button>
      </div>
    </div>
  );
});

export function SegmentList({
  segments,
  selectedId,
  playingSegmentId,
  unresolvedBySegment,
  loopSegmentId,
  onEdit,
  onCompositionEnd,
  onConfirmRow,
  onLocate,
  onTogglePlay,
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
          playing={seg.segmentId === playingSegmentId}
          looping={seg.segmentId === loopSegmentId}
          unresolvedCount={unresolvedBySegment.get(seg.segmentId) ?? 0}
          onEdit={onEdit}
          onCompositionEnd={onCompositionEnd}
          onConfirmRow={onConfirmRow}
          onLocate={onLocate}
          onTogglePlay={onTogglePlay}
          onLoop={onLoop}
          onCreateIssue={onCreateIssue}
        />
      ))}
    </div>
  );
}
