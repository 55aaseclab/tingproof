/**
 * 字幕段列表（PRD V1.0.4）。
 * - 点击行内非操作区域 / 聚焦校对文本框 → onLocate（选中 + 精确定位 startMs，不自动播放）；
 * - 行内“⚑ 疑点”：只打开轻量类型选择层（8 类、无预选、单例、Esc/外部/再点关闭），
 *   选择类型后才对该段创建一条 blocking 疑点；按钮与菜单不冒泡成行定位、不改播放；
 * - 行内确认按钮双向：未确认“✓ 确认本段”，已确认“↶ 取消确认”（撤销不前进/不定位/不改播放）；
 * - 行内播放/暂停开关：未播放显示“▶ 播放”，播放中显示“⏸ 暂停”，可访问名称同步；
 *   按钮事件不冒泡触发行定位；双击时间码等价于该行播放/暂停开关。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { IssueTypeMenu } from "./IssueTypeMenu.js";
import { formatDisplay } from "../core/time.js";
import {
  SEGMENT_STATUS_LABEL,
  type IssueType,
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
  /** 行内撤销确认（已确认段再次点击同一按钮）。 */
  onUnconfirmRow: (segmentId: string) => void;
  /** 点击非操作区域 / 聚焦文本框：选中并定位 startMs，不自动播放。 */
  onLocate: (segmentId: string) => void;
  /** 行内播放/暂停开关（含双击时间码）。 */
  onTogglePlay: (segmentId: string) => void;
  onLoop: (segmentId: string) => void;
  /** 行内类型选择层选定后创建：type 为用户所选值。 */
  onCreateIssueWithType: (segmentId: string, type: IssueType) => void;
}

interface RowProps {
  seg: SegmentRecord;
  selected: boolean;
  playing: boolean;
  looping: boolean;
  menuOpen: boolean;
  unresolvedCount: number;
  onEdit: Props["onEdit"];
  onCompositionEnd: Props["onCompositionEnd"];
  onToggleMenu: (segmentId: string) => void;
  onCloseMenu: () => void;
  onConfirmRow: Props["onConfirmRow"];
  onUnconfirmRow: Props["onUnconfirmRow"];
  onLocate: Props["onLocate"];
  onTogglePlay: Props["onTogglePlay"];
  onLoop: Props["onLoop"];
  onCreateIssueWithType: Props["onCreateIssueWithType"];
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
  menuOpen,
  unresolvedCount,
  onEdit,
  onCompositionEnd,
  onToggleMenu,
  onCloseMenu,
  onConfirmRow,
  onUnconfirmRow,
  onLocate,
  onTogglePlay,
  onLoop,
  onCreateIssueWithType,
}: RowProps) {
  const isConfirmed = seg.status === "confirmed";
  const issueTriggerRef = useRef<HTMLButtonElement | null>(null);

  // 点击行内非操作区域（按钮/文本框/时间码/类型菜单之外）= 定位，不播放。
  const locateOnPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (
      t.closest("button") ||
      t.closest("textarea") ||
      t.closest(".cue-time") ||
      t.closest(".type-menu")
    ) {
      return;
    }
    if (menuOpen) onCloseMenu(); // 点击行内其他位置也关闭选择层
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
          onClick={() => (isConfirmed ? onUnconfirmRow(seg.segmentId) : onConfirmRow(seg.segmentId))}
          aria-label={isConfirmed ? "取消确认" : "确认本段"}
          title={
            isConfirmed
              ? "撤销确认：有未解决疑点回到「有疑点」，否则回到「校对中」；不前进、不定位、不改播放"
              : "确认这一段（与播放位置无关）；Ctrl+Enter 确认当前选中段并定位下一未校对段段首"
          }
        >
          {isConfirmed ? "↶ 取消确认" : "✓ 确认本段"}
        </button>
        <div className="issue-trigger-wrap">
          <button
            ref={issueTriggerRef}
            data-issue-trigger={seg.segmentId}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => onToggleMenu(seg.segmentId)}
            title="打开疑点类型选择（8 类，选择后才创建）；Ctrl+? 直接创建「听不清 / 阻塞」疑点"
          >
            ⚑ 疑点
          </button>
          {menuOpen && (
            <IssueTypeMenu
              segmentId={seg.segmentId}
              triggerEl={issueTriggerRef.current}
              onPick={(type) => {
                onCreateIssueWithType(seg.segmentId, type);
                onCloseMenu();
              }}
              onClose={onCloseMenu}
            />
          )}
        </div>
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
  onUnconfirmRow,
  onLocate,
  onTogglePlay,
  onLoop,
  onCreateIssueWithType,
}: Props) {
  // 列表级单例：同一时间最多一个类型选择层展开。
  const [menuForId, setMenuForId] = useState<string | null>(null);
  return (
    <div role="list" aria-label="字幕段列表">
      {segments.map((seg) => (
        <SegmentRow
          key={seg.segmentId}
          seg={seg}
          selected={seg.segmentId === selectedId}
          playing={seg.segmentId === playingSegmentId}
          looping={seg.segmentId === loopSegmentId}
          menuOpen={menuForId === seg.segmentId}
          unresolvedCount={unresolvedBySegment.get(seg.segmentId) ?? 0}
          onEdit={onEdit}
          onCompositionEnd={onCompositionEnd}
          onToggleMenu={(id) => setMenuForId((prev) => (prev === id ? null : id))}
          onCloseMenu={() => setMenuForId(null)}
          onConfirmRow={onConfirmRow}
          onUnconfirmRow={onUnconfirmRow}
          onLocate={onLocate}
          onTogglePlay={onTogglePlay}
          onLoop={onLoop}
          onCreateIssueWithType={onCreateIssueWithType}
        />
      ))}
    </div>
  );
}
