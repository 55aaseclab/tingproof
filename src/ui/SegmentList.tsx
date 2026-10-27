/**
 * 字幕段列表（PRD V1.0.4）。
 * - 点击行内非操作区域 → onLocate（选中 + 精确定位 startMs，不自动播放）；
 * - 聚焦校对文本框 → onEditorFocus（V1.1.4：当前播放段只精确暂停并记录续播点；其他段等同 onLocate）；
 * - 行内“⚑ 疑点”：只打开轻量类型选择层（8 类、无预选、单例、Esc/外部/再点关闭），
 *   选择类型后才对该段创建一条 blocking 疑点；按钮与菜单不冒泡成行定位、不改播放；
 * - 行内确认按钮双向：未确认“✓ 确认本段”，已确认“↶ 取消确认”（撤销不前进/不定位/不改播放）；
 * - 行内播放/暂停开关：未播放显示“▶ 播放”，播放中显示“⏸ 暂停”，可访问名称同步；
 *   按钮事件不冒泡触发行定位；双击时间码等价于该行播放/暂停开关；
 * - 行内 ±2 秒复听（V1.0.7 AC-051）：“⏪ 2s / ⏩ 2s”（可达名称“后退 2 秒 / 前进 2 秒”），
 *   固定排在播放/暂停之后、确认/取消确认之前；点击先选中按钮所在段，再由 Workbench
 *   复用 player.skip 的段内钳制逻辑 seek，不自动播放、不冒泡成行定位或播放/暂停开关。
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
  /** V1.1.4：未解决机器建议计数（行内显示“机器建议 ×N”）。 */
  machineCountBySegment?: Map<string, number>;
  loopSegmentId: string | null;
  /** 正文草稿变更（组合中 composing=true；持久化策略由 Workbench 决定）。 */
  onDraftChange: (segmentId: string, text: string, composing: boolean) => void;
  onCompositionStart: (segmentId: string) => void;
  onCompositionEnd: (segmentId: string) => void;
  /** 行内确认：永远作用于被点击的 segmentId。 */
  onConfirmRow: (segmentId: string) => void;
  /** 行内撤销确认（已确认段再次点击同一按钮）。 */
  onUnconfirmRow: (segmentId: string) => void;
  /** 点击非操作区域：选中并定位 startMs，不自动播放。聚焦文本框走 onEditorFocus（V1.1.4：当前播放段精确打断）。 */
  onLocate: (segmentId: string) => void;
  /** V1.1.4：聚焦校对文本框（与行空白区点击 onLocate 语义分离，AC-041/AC-067）。 */
  onEditorFocus: (segmentId: string) => void;
  /** 行内播放/暂停开关（含双击时间码）。 */
  onTogglePlay: (segmentId: string) => void;
  /** 行内后退 2 秒（AC-051）：Workbench 先选中按钮所在段并设活动范围，再复用 skip 钳制 seek。 */
  onSkipBack: (segmentId: string) => void;
  /** 行内前进 2 秒（AC-051）：同 onSkipBack，方向相反。 */
  onSkipForward: (segmentId: string) => void;
  onLoop: (segmentId: string) => void;
  /** 行内类型选择层选定后创建：type 为用户所选值。 */
  onCreateIssueWithType: (segmentId: string, type: IssueType) => void;
  /** 诊断/测试探针（可选）：每行每次提交后回调；生产不传即零开销。 */
  renderProbe?: (segmentId: string) => void;
}

interface RowProps {
  seg: SegmentRecord;
  selected: boolean;
  playing: boolean;
  looping: boolean;
  menuOpen: boolean;
  unresolvedCount: number;
  machineCount: number;
  onDraftChange: Props["onDraftChange"];
  onCompositionStart: Props["onCompositionStart"];
  onCompositionEnd: Props["onCompositionEnd"];
  onToggleMenu: (segmentId: string) => void;
  onCloseMenu: () => void;
  onConfirmRow: Props["onConfirmRow"];
  onUnconfirmRow: Props["onUnconfirmRow"];
  onLocate: Props["onLocate"];
  onEditorFocus: Props["onEditorFocus"];
  onTogglePlay: Props["onTogglePlay"];
  onSkipBack: Props["onSkipBack"];
  onSkipForward: Props["onSkipForward"];
  onLoop: Props["onLoop"];
  onCreateIssueWithType: Props["onCreateIssueWithType"];
  renderProbe: Props["renderProbe"];
}

/**
 * 非受控校对文本框（V1.0.5 AC-048）：
 * - 输入即原生显示：打字期间零 React 重渲染、零强制布局（高度交给 CSS field-sizing）；
 * - 文本经 onDraftChange 进入 Workbench 草稿管道（500ms 持久化，安全语义不变）；
 * - 仅当持久层文本（externalText）与本地草稿不同步时（如重新定位/重开项目）才回写 DOM。
 */
function AutoTextarea({
  initialText,
  externalText,
  onDraftChange,
  onCompositionStart,
  onCompositionEnd,
  onFocus,
  ariaLabel,
}: {
  initialText: string;
  externalText: string;
  onDraftChange: (v: string, composing: boolean) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onFocus: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const lastKnownRef = useRef(initialText);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (externalText !== lastKnownRef.current) {
      el.value = externalText;
      lastKnownRef.current = externalText;
    }
  }, [externalText]);
  return (
    <textarea
      ref={ref}
      className="seg-corrected"
      defaultValue={initialText}
      aria-label={ariaLabel}
      onFocus={onFocus}
      onChange={(e) => {
        const v = e.target.value;
        lastKnownRef.current = v;
        onDraftChange(v, (e.nativeEvent as InputEvent).isComposing ?? false);
      }}
      onCompositionStart={() => onCompositionStart()}
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
  machineCount,
  onDraftChange,
  onCompositionStart,
  onCompositionEnd,
  onToggleMenu,
  onCloseMenu,
  onConfirmRow,
  onUnconfirmRow,
  onLocate,
  onEditorFocus,
  onTogglePlay,
  onSkipBack,
  onSkipForward,
  onLoop,
  onCreateIssueWithType,
  renderProbe,
}: RowProps) {
  const isConfirmed = seg.status === "confirmed";
  const issueTriggerRef = useRef<HTMLButtonElement | null>(null);
  renderProbe?.(seg.segmentId);
  // 渲染探针（可选）：仅在传入时于渲染体调用（第 11 轮审计 4）——
  // 生产不传 → 不注册任何 effect、零开销；StrictMode 双调用由测试基线吸收。

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
  // AC-051：行内复听按钮事件不冒泡（pointerdown/click 都不触发行定位或播放/暂停开关）。
  const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();
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
        {machineCount > 0 && <span className="status-chip machine-chip">机器建议 ×{machineCount}</span>}
        {looping && <span className="loop-indicator">⭯ 循环中</span>}
        <span className="hint">#{seg.cueNo ?? "—"}</span>
      </div>
      <div className="seg-original" title="原始识别层（只读）">
        {seg.originalText}
      </div>
      <AutoTextarea
        initialText={seg.correctedText}
        externalText={seg.correctedText}
        ariaLabel={`校对文本 ${formatDisplay(seg.startMs)}`}
        onFocus={() => onEditorFocus(seg.segmentId)}
        onDraftChange={(v, composing) => onDraftChange(seg.segmentId, v, composing)}
        onCompositionStart={() => onCompositionStart(seg.segmentId)}
        onCompositionEnd={() => onCompositionEnd(seg.segmentId)}
      />
      <div className="seg-actions">
        <button
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
          title={
            playing
              ? "暂停：停在当前位置，不会回跳段首"
              : "播放：选中该段并起播（同段段内恢复按自动回退；有编辑打断点则从打断点无回退续播；段尾/段外从段首；段尾自动暂停；循环模式除外）"
          }
        >
          {playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
        <button
          onPointerDown={stopPropagation}
          onClick={(e) => {
            e.stopPropagation();
            onSkipBack(seg.segmentId);
          }}
          aria-label="后退 2 秒"
          title="后退 2 秒：先选中该段并在段内钳制定位；暂停时只定位不自动播放，播放中保持播放（与 F7 共用段内钳制）"
        >
          ⏪ 2s
        </button>
        <button
          onPointerDown={stopPropagation}
          onClick={(e) => {
            e.stopPropagation();
            onSkipForward(seg.segmentId);
          }}
          aria-label="前进 2 秒"
          title="前进 2 秒：先选中该段并在段内钳制定位；暂停时只定位不自动播放，播放中保持播放（与 F9 共用段内钳制）"
        >
          ⏩ 2s
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
            title="打开疑点类型选择（8 类，选择后才创建）；Ctrl+? 创建默认疑点"
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
  machineCountBySegment,
  loopSegmentId,
  onDraftChange,
  onCompositionStart,
  onCompositionEnd,
  onConfirmRow,
  onUnconfirmRow,
  onLocate,
  onEditorFocus,
  onTogglePlay,
  onSkipBack,
  onSkipForward,
  onLoop,
  onCreateIssueWithType,
  renderProbe,
}: Props) {
  // 列表级单例：同一时间最多一个类型选择层展开。
  const [menuForId, setMenuForId] = useState<string | null>(null);
  // 稳定回调：避免任何列表级状态变化让未修改行失去 memo 跳过能力（AC-048）。
  const toggleMenu = useCallback((id: string) => setMenuForId((prev) => (prev === id ? null : id)), []);
  const closeMenu = useCallback(() => setMenuForId(null), []);
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
          machineCount={machineCountBySegment?.get(seg.segmentId) ?? 0}
          onDraftChange={onDraftChange}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onToggleMenu={toggleMenu}
          onCloseMenu={closeMenu}
          onConfirmRow={onConfirmRow}
          onUnconfirmRow={onUnconfirmRow}
          onLocate={onLocate}
          onEditorFocus={onEditorFocus}
          onTogglePlay={onTogglePlay}
          onSkipBack={onSkipBack}
          onSkipForward={onSkipForward}
          onLoop={onLoop}
          onCreateIssueWithType={onCreateIssueWithType}
          renderProbe={renderProbe}
        />
      ))}
    </div>
  );
}
