/**
 * 校对工作台：三层模型的 V0.1 实现。
 * - 原始识别层：每段 originalText 只读展示，来自导入时写死的 SRT 原文；
 * - 逐字校对层：correctedText 可编辑；片段/疑点写入统一经过 SaveCoordinator（失败不静默丢失）；
 * - 选中策略：行内确认永远作用于被点击段；播放只在真正进入某段时接管选中（间隙保持选中）；
 * - 导出：空文本段为阻塞项；写出前用 isSameEntry 阻止选中源文件；写出后重新解析回读校验。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "../audio/usePlayer.js";
import { usePlaybackSelection } from "../audio/usePlaybackSelection.js";
import { usePeriodicPersist } from "../audio/usePeriodicPersist.js";
import { formatDisplay, formatDuration } from "../core/time.js";
import {
  buildExportPreview,
  renderExportSrt,
  verifyRoundTrip,
} from "../core/exportSrt.js";
import {
  downloadText,
  isAbortError,
  pickSaveTarget,
  readHandleText,
  supportsFileSystemAccess,
  writeToHandle,
  type SaveHandle,
} from "../core/fileWrite.js";
import { canVerifySources, checkExportTarget, type SourceHandleRef } from "../core/exportGuard.js";
import { computeAudioFingerprint } from "../core/identity.js";
import { decideRelocate } from "../core/legacyReconnect.js";
import { safeNavigate } from "../core/navigation.js";
import {
  planConfirm,
  planLoopToggle,
  planUnconfirm,
  reuseTimelineData,
  sameSortedOrderShape,
  segmentIdForRange,
  type TimelineSegLike,
} from "../core/selection.js";
import { randomUuid, sha256Hex } from "../core/identity.js";
import {
  confirmSegment,
  deleteIssue,
  getProjectIssues,
  getSrtSource,
  relinkAudio,
  savePlayback,
  updateMediaDuration,
  updateSegment,
  upsertIssue,
} from "../store/repo.js";
import { SaveCoordinator, type SaveState } from "../store/saveCoordinator.js";
import { applyIssueMerge, IssueSync } from "../store/issueSync.js";
import { PrefilterPanel } from "./PrefilterPanel.js";
import {
  type IssueRecord,
  type IssueSeverity,
  type IssueType,
  type ProjectMeta,
  type SegmentRecord,
  type SegmentStatus,
} from "../store/types.js";
import { useKeymap } from "./useKeymap.js";
import { Timeline } from "./Timeline.js";
import { SegmentList } from "./SegmentList.js";
import { IssuePanel } from "./IssuePanel.js";
import { ExportDialog } from "./ExportDialog.js";
import { KeymapBar } from "./KeymapBar.js";
import { useManualScrollTakeover } from "./useManualScroll.js";

interface Props {
  meta: ProjectMeta;
  /** 仅存在于当前会话内存中（导入当次传入或重定位后传入）；不落库。 */
  audioFile: File | null;
  audioNotice: string | null;
  initialSegments: SegmentRecord[];
  initialIssues: IssueRecord[];
  onBack: () => void;
  onRelocated: (meta: ProjectMeta, file: File) => void;
  /** 诊断/测试探针：每个 SegmentRow 提交后回调一次；生产不传即零开销、不污染 DOM。 */
  segmentRenderProbe?: (segmentId: string) => void;
}

export function Workbench({
  meta,
  audioFile,
  audioNotice,
  initialSegments,
  initialIssues,
  onBack,
  onRelocated,
  segmentRenderProbe,
}: Props) {
  const [segments, setSegments] = useState<SegmentRecord[]>(initialSegments);
  const [issues, setIssues] = useState<IssueRecord[]>(initialIssues);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSegments.length > 0 ? initialSegments[0].segmentId : null,
  );
  const [follow, setFollow] = useState(true);
  const [showExport, setShowExport] = useState(false);
  const [showKeymap, setShowKeymap] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  /** V1.1.4 原子确认失败信息（段与疑点保持原状态，可重试；AC-068）。 */
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [tailGapMs, setTailGapMs] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const segmentsRef = useRef(segments);
  const sortedRef = useRef<SegmentRecord[]>(initialSegments);
  const metaRef = useRef(meta);
  segmentsRef.current = segments;
  metaRef.current = meta;

  // V1.0.5 AC-048 + 第 10 轮审计 C：时间范围未变化时不重排完整时间轴——
  // 按 segmentId 建 Map，对缓存排序顺序中的每个 ID 精确比较 start/end，
  // 并把最新文本/状态对象映射进既有顺序；初始输入未排序也不会每键重排。
  const sortedCacheRef = useRef<{ value: SegmentRecord[] } | null>(null);
  const sortedSegments = useMemo(() => {
    const byId = new Map(segments.map((sg) => [sg.segmentId, sg]));
    const cached = sortedCacheRef.current;
    if (cached && sameSortedOrderShape(cached.value, byId)) {
      const value = cached.value.map((sg) => byId.get(sg.segmentId) ?? sg);
      sortedCacheRef.current = { value };
      return value;
    }
    const value = [...segments].sort((a, b) => a.startMs - b.startMs);
    sortedCacheRef.current = { value };
    return value;
  }, [segments]);
  sortedRef.current = sortedSegments;

  const keymap = useKeymap();

  // ---------- 保存协调器（片段/疑点/播放设置统一走这里；失败保留队列可重试） ----------

  const saveRef = useRef<SaveCoordinator | null>(null);
  if (!saveRef.current) saveRef.current = new SaveCoordinator(500);
  const save = saveRef.current;

  // 保存状态订阅：失败时顶栏显示「保存失败（N 项未落盘）」并可重试；
  // 确认意图的保护由 SaveCoordinator 的 EnqueuedOp token（isCurrent）实现——
  // confirm 前置保存失败后仅当队列项仍是本 confirm token 时才降级为草稿保存。
  const [saveStatus, setSaveStatus] = useState<SaveState>(save.state);
  useEffect(() => save.subscribe(setSaveStatus), [save]);
  useEffect(() => () => save.dispose(), [save]);

  /** 正文草稿（仅内存）：输入即时显示的载体；flush 时合并进持久层。 */
  const draftsRef = useRef(new Map<string, string>());
  /** 正在 IME 组合中的段：flush 时跳过，杜绝保存半字（composition end 会重新入队）。 */
  const composingSegmentsRef = useRef(new Set<string>());

  const persistSegment = useCallback(
    (segmentId: string) => {
      save.enqueue(`segment:${segmentId}`, async () => {
        const seg = segmentsRef.current.find((s) => s.segmentId === segmentId);
        if (!seg) return;
        // 中文 IME 组合中：跳过半字；composition end 会重新入队提交完整文本。
        if (composingSegmentsRef.current.has(segmentId)) return;
        const draft = draftsRef.current.get(segmentId);
        await updateSegment(segmentId, {
          correctedText: draft ?? seg.correctedText,
          status: seg.status,
        });
      });
      save.schedule();
    },
    [save],
  );

  // 页面隐藏时尽力落盘（浏览器不保证完成；常规自动保存间隔仅 500ms）。
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden" && save.pendingCount > 0) {
        void save.flush();
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [save]);

  // ---------- 播放器 ----------

  const player = usePlayer(audioRef, {
    initialSpeed: meta.playback.speed,
    initialAutoRewindMs: meta.playback.autoRewindMs,
    onDuration: (d) => {
      const last = sortedRef.current[sortedRef.current.length - 1];
      setTailGapMs(last ? Math.max(0, d - last.endMs) : null);
      // 恢复上次播放位置（仅当还没开始播放）。
      const pos = metaRef.current.playback.positionMs;
      const a = audioRef.current;
      if (a && pos > 0 && pos < d && a.currentTime === 0) {
        a.currentTime = pos / 1000;
      }
      // 受控元数据更新：时长写回项目记录（不经 metaRef 本地改写，刷新后仍可读回）。
      if (metaRef.current.media.durationMs !== d && d > 0) {
        void updateMediaDuration(metaRef.current.projectId, d);
      }
    },
    onPauseChange: (playing, pos) => {
      // 暂停时立即持久化准确位置（审计 P0-3：README 声明必须与实现一致）。
      if (!playing) {
        save.enqueue("playback", async () => {
          await savePlayback(metaRef.current.projectId, {
            ...metaRef.current.playback,
            loopSegmentId: null,
            positionMs: pos,
            speed: playerRef.current.speed,
            autoRewindMs: playerRef.current.autoRewindMs,
          });
        });
        save.schedule();
      }
    },
  });

  const playerRef = useRef(player);
  playerRef.current = player;

  // 速度 / 自动回退 / 循环变化时保存播放设置。
  // 说明：V0.1 的 A-B/整段循环是会话内临时状态，不跨会话恢复，因此 loopSegmentId 恒写 null。
  const persistPlayback = useCallback(() => {
    save.enqueue("playback", async () => {
      // 元数据尚未加载时保持已恢复的历史位置，避免挂载时把位置清零。
      const positionMs =
        playerRef.current.durationMs > 0
          ? playerRef.current.getCurrentMs()
          : metaRef.current.playback.positionMs;
      await savePlayback(metaRef.current.projectId, {
        ...metaRef.current.playback,
        loopSegmentId: null,
        speed: playerRef.current.speed,
        autoRewindMs: playerRef.current.autoRewindMs,
        positionMs,
      });
    });
    save.schedule();
  }, [save]);

  useEffect(() => {
    persistPlayback();
  }, [player.speed, player.autoRewindMs, player.loop, persistPlayback]);

  // 每 5 秒持久化播放位置（PRD 3.2.4）。
  // 计时器只创建一次（usePeriodicPersist 依赖仅 intervalMs）：
  // 播放进入新字幕段等 UI render 不会重置计时，连续播放满 5 秒必定触发保存。
  usePeriodicPersist(
    () => playerRef.current.playing,
    persistPlayback,
    5000,
  );

  // ---------- 音频源 ----------

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!audioFile) {
      setAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(audioFile);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioFile]);

  // 项目原始识别层完整性自检：库内 rawContent 哈希必须与导入记录一致。
  useEffect(() => {
    let cancelled = false;
    getSrtSource(meta.projectId)
      .then(async (src) => {
        if (!src || cancelled) return;
        const h = await sha256Hex(src.rawContent);
        if (h !== src.sha256) {
          setAppError(
            `项目原始字幕完整性校验失败（${src.sha256.slice(0, 8)} → ${h.slice(0, 8)}）。原始识别层可能被外部改动，请停止使用并报告问题。`,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [meta.projectId]);

  /** 返回项目页：先落盘；失败则留在工作台（顶部已有失败状态与重试按钮）。 */
  const handleBack = useCallback(async () => {
    const guard = await safeNavigate(save);
    if (!guard.allowed) {
      setAppError(guard.reason);
      return;
    }
    onBack();
  }, [save, onBack]);

  /** 重新定位音频：FS Access 或 <input> 降级；按 decideRelocate 三态决策处理。 */
  const relocateAudio = useCallback(async () => {
    setAudioError(null);
    // 离开/重挂载前先落盘（重定位会触发项目重载，未保存内容不能被 DB 旧数据覆盖）。
    const guard = await safeNavigate(save);
    if (!guard.allowed) {
      setAudioError(guard.reason);
      return;
    }
    let picked: { file: File; handle: FileSystemFileHandle | null } | null = null;
    try {
      if (supportsFileSystemAccess()) {
        const handles = await (
          window as unknown as {
            showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
          }
        ).showOpenFilePicker({
          multiple: false,
          types: [{ description: "MP3 音频", accept: { "audio/mpeg": [".mp3"] } }],
        });
        picked = { file: await handles[0].getFile(), handle: handles[0] };
      } else {
        picked = await new Promise<{ file: File; handle: null } | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".mp3,audio/mpeg";
          input.onchange = () => {
            const f = input.files?.[0];
            resolve(f ? { file: f, handle: null } : null);
          };
          input.click();
        });
      }
    } catch (err) {
      if (!isAbortError(err)) {
        setAudioError(`重新定位音频失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!picked) return;
    try {
      const fingerprint = await computeAudioFingerprint(picked.file);
      const decision = decideRelocate(
        {
          audioFingerprint: metaRef.current.media.audioFingerprint,
          audioSize: metaRef.current.media.audioSize,
          audioName: metaRef.current.media.audioName,
        },
        { fingerprint, size: picked.file.size, name: picked.file.name },
      );
      if (decision.action === "reject") {
        setAudioError(decision.reason);
        return;
      }
      if (decision.action === "confirm-establish") {
        // 旧项目首次建立身份：必须用户显式确认，绝不无提示接受。
        const ok = window.confirm(decision.reason);
        if (!ok) return;
      }
      await relinkAudio(metaRef.current.projectId, {
        audioName: picked.file.name,
        audioSize: picked.file.size,
        audioLastModified: picked.file.lastModified,
        audioFingerprint: decision.fingerprint,
        audioHandle: picked.handle,
      });
      onRelocated(
        {
          ...metaRef.current,
          media: {
            ...metaRef.current.media,
            audioName: picked.file.name,
            audioSize: picked.file.size,
            audioLastModified: picked.file.lastModified,
            audioFingerprint: decision.fingerprint,
            audioHandle: picked.handle,
          },
        },
        picked.file,
      );
    } catch (err) {
      setAudioError(`重新定位音频失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [onRelocated, save]);

  // ---------- 选中段跟踪（播放进入某段才接管；间隙保持选中） ----------

  const selectedIdRef = useRef(selectedId);
  const updateSelected = useCallback((id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  }, []);

  /**
   * 统一选中入口：更新选中段并让活动播放范围（= 该段 [startMs, endMs)）随之。
   * locate=true 时精确定位到 startMs（无预卷）；pauseIfPlaying=true 时先暂停旧段。
   */
  const selectSegment = useCallback(
    (segmentId: string, opts: { locate?: boolean; pauseIfPlaying?: boolean } = {}) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      updateSelected(segmentId);
      playerRef.current.setRange({ startMs: seg.startMs, endMs: seg.endMs });
      if (opts.pauseIfPlaying && audioRef.current && !audioRef.current.paused) {
        playerRef.current.pause();
      }
      if (opts.locate) playerRef.current.seek(seg.startMs);
    },
    [updateSelected],
  );

  /** 播放接管：只在播放真正进入某段时发生——跟随更新选中与范围，不暂停、不跳转。 */
  const handlePlaybackTakeover = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      updateSelected(segmentId);
      playerRef.current.setRange({ startMs: seg.startMs, endMs: seg.endMs });
    },
    [updateSelected],
  );

  const getSorted = useCallback(() => sortedRef.current, []);
  usePlaybackSelection(
    player.subscribeCurrentMs,
    getSorted,
    handlePlaybackTakeover,
  );

  // 挂载时为初始选中段建立活动播放范围。
  useEffect(() => {
    const first = sortedRef.current[0];
    if (first) playerRef.current.setRange({ startMs: first.startMs, endMs: first.endMs });
  }, []);

  // 人工滚动接管（PRD V1.0.4）：滚轮/触控板/滚动条/键盘滚动的首个事件立即暂停跟随；
  // 程序自身 scrollIntoView 经 beginProgrammatic 包裹，不会被误判为用户接管。
  const followRef = useRef(follow);
  followRef.current = follow;
  const { beginProgrammatic } = useManualScrollTakeover(listScrollRef, {
    enabled: () => followRef.current,
    onTakeover: () => setFollow(false),
  });

  // 跟随滚动（用户任何人工滚动打断；可点“回到播放点”或定位/播放恢复）。
  useEffect(() => {
    if (!follow || !selectedId) return;
    const container = listScrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-segment-id="${selectedId}"]`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    if (rect.top < box.top + 8 || rect.bottom > box.bottom - 8) {
      beginProgrammatic(() => el.scrollIntoView({ block: "center" }));
    }
  }, [selectedId, follow, beginProgrammatic]);

  // ---------- 片段操作 ----------

  const nextStatusAfterEdit = (prev: SegmentStatus): SegmentStatus =>
    prev === "questioned" ? "questioned" : "editing";

  /**
   * 正文草稿变更（V1.0.5 AC-048）：后续纯正文逐键不触发整表 React 状态更新
   * （同引用 bail）；首键可能有一次状态迁移渲染（确认→校对中），
   * saveStatus 的 saving 发布也各可能一次渲染。文本由非受控 textarea 原生显示。
   * IME 组合中间态进草稿但不调度持久化；composition end 后调度提交完整文本。
   */
  const editSegment = useCallback(
    (segmentId: string, text: string, composing: boolean) => {
      draftsRef.current.set(segmentId, text);
      setSegments((prev) => {
        const seg = prev.find((s) => s.segmentId === segmentId);
        if (!seg || seg.status === "editing" || seg.status === "questioned") return prev;
        return prev.map((s) =>
          s.segmentId === segmentId ? { ...s, status: nextStatusAfterEdit(s.status) } : s,
        );
      });
      if (!composing) persistSegment(segmentId);
    },
    [persistSegment],
  );

  const onCompositionStart = useCallback(
    (segmentId: string) => {
      composingSegmentsRef.current.add(segmentId);
    },
    [],
  );

  const onCompositionEnd = useCallback(
    (segmentId: string) => {
      composingSegmentsRef.current.delete(segmentId);
      persistSegment(segmentId); // 提交完整文本（约 500ms 后落盘）
    },
    [persistSegment],
  );

  const setStatus = useCallback(
    (segmentId: string, status: SegmentStatus) => {
      setSegments((prev) =>
        prev.map((s) => (s.segmentId === segmentId ? { ...s, status } : s)),
      );
      persistSegment(segmentId); // 合并未落盘草稿，避免状态写入覆盖文本
    },
    [persistSegment],
  );

  const focusSegmentEditor = useCallback((segmentId: string) => {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>(
        `[data-segment-id="${segmentId}"] textarea`,
      );
      el?.focus();
    }, 80);
  }, []);

  /**
   * P0-1（第 6 轮）：confirm 降级为普通草稿保存的辅助函数。
   * 在执行时读取 draftsRef/sortedRef 最新值（不闭包捕获旧 textToSend/status），
   * 不覆盖后续输入、新确认或同 label 新 op。
   */
  const downgradeConfirmToDraftSave = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((x) => x.segmentId === segmentId);
      if (!seg) return;
      save.enqueue(`segment:${segmentId}`, async () => {
        const segAtRun = sortedRef.current.find((x) => x.segmentId === segmentId);
        const draftAtRun = draftsRef.current.get(segmentId);
        if (!segAtRun) return;
        await updateSegment(segmentId, {
          correctedText: draftAtRun ?? segAtRun.correctedText,
          status: segAtRun.status,
        });
      });
    },
    [save],
  );

  /**
   * 行内确认 / Ctrl+Enter 确认（PRD V1.0.4；V1.1.4 原子化，AC-068 + 主审计 P0-2 第 5/6 轮）。
   * - 一次服务端原子事务：确认目标段（含 pending 草稿文本）并解决本段全部 open 疑点；
   * - P0-2（第 5 轮）：入队返回不可伪造的 EnqueuedOp token；
   *   confirm 自身失败后仅当队列项仍是该 token 时才替换为草稿保存（不覆盖后续输入/新确认）；
   *   前置 op 失败后的 flush().then 也仅当 token 仍 current 时替换；
   *   confirm 已成功而其他 op 后失败时不显示"确认被阻止"、不重新入队。
   * - P0-1（第 6 轮）：降级时在执行时读取最新 draftsRef/segmentsRef 值。
   */
  // ---------- issues 并发保护（P0-1 第 9 轮）：IssueSync 协调器（src/store/issueSync.ts） ----------
  // 设计与可证明的不变量见 issueSync.ts 头注。要点：
  // - per-ID pending token：旧保存在途→新 mutation→旧保存成功不会清新 mutation 的 pending；
  // - confirm 原子结果不进 pending，只保护 confirm 发生时在途的旧读（非永久保护）；
  // - 冻结决策在响应到达时同步执行（React 更新器延迟执行，finally 清理先于更新器——
  //   更新器内不得读 journal）；
  // - 服务端缺失的本地项：仅 touched/pending 保留，否则视为跨设备删除事实删除本地。

  const [issuesRefreshError, setIssuesRefreshError] = useState<string | null>(null);
  /** issues 状态的同步只读镜像（渲染时同步；必须在 refreshIssues 声明前）。 */
  const issuesRef = useRef(issues);
  issuesRef.current = issues;

  const issueSyncRef = useRef<IssueSync | null>(null);
  if (issueSyncRef.current === null) issueSyncRef.current = new IssueSync();
  const issueSync = issueSyncRef.current;

  /**
   * confirmSegment 原子返回的 resolvedIssues：服务端已落盘，不进 pending；
   * 若该 ID 有更晚的本地 pending mutation（第 10 轮 P0-1），保留其条目与 token。
   */
  const noteIssueConfirmed = useCallback(
    (...issueIds: string[]) => {
      issueSync.noteConfirmed(...issueIds);
    },
    [issueSync],
  );

  /** 在 issue 保存 op 内捕获 per-ID token；ack 仅当 token 仍是最新时生效。 */
  const captureIssueSaveToken = useCallback(
    (issueId: string) => issueSync.captureSaveToken(issueId),
    [issueSync],
  );

  /** 本地 issue mutation（create/resolve/delete）：写 per-ID journal + 分配新 pending token。 */
  const noteIssueMutation = useCallback(
    (...issueIds: string[]) => {
      issueSync.noteMutation(...issueIds);
    },
    [issueSync],
  );

  const refreshIssues = useCallback(async () => {
    const read = issueSync.beginRead();
    try {
      const latest = await getProjectIssues(meta.projectId);
      if (!issueSync.isLatestRead(read.gen)) {
        issueSync.endRead(read.gen);
        return; // 旧读不覆盖新读（反序返回整体丢弃）
      }
      // 响应到达时同步冻结决策——更新器延迟执行，不得在其中读 journal。
      const decisions = issueSync.freezeDecisions(
        read,
        latest.map((i) => i.issueId),
        issuesRef.current.map((i) => i.issueId),
      );
      setIssues((prev) => applyIssueMerge(decisions, latest, prev));
      setIssuesRefreshError(null);
    } catch (err) {
      if (issueSync.isLatestRead(read.gen)) {
        setIssuesRefreshError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      issueSync.endRead(read.gen);
    }
  }, [meta.projectId, issueSync]);

  const applyConfirm = useCallback(
    (segmentId: string, opts: { advance: boolean }) => {
      const draft = draftsRef.current.get(segmentId);
      const plan = planConfirm(sortedRef.current, segmentId, draft);
      if (!plan.ok) {
        window.alert(plan.reason);
        return;
      }
       const target = sortedRef.current.find((s) => s.segmentId === plan.confirmedId);
      const textToSend = draft ?? target?.correctedText;
      setConfirmError(null);
      let confirmSucceeded = false;
      // 入队 confirm op，获取不可伪造的队列项身份。
      const enqueued = save.enqueue(`segment:${plan.confirmedId}`, async () => {
        try {
          const result = await confirmSegment(plan.confirmedId, { correctedText: textToSend });
          if (!result) return;
          confirmSucceeded = true;
          const resolvedIds = new Set(result.resolvedIssues.map((i) => i.issueId));
          // confirmSegment 返回的 resolvedIssues：服务端已原子落盘，登记 confirmed 条目。
          // 第 10 轮 P0-1：若该 ID 有更晚的本地 pending mutation（确认在途期间用户又
          // create/resolve/delete），noteConfirmed 保留其 local 条目与 token，不覆盖/不 ack。
          if (resolvedIds.size > 0) {
            noteIssueConfirmed(...resolvedIds);
          }
          // P0-2（第 7 轮）：仅当 confirm token 仍 current 时才应用段级覆盖（draft 删除、
          // canonical segment 覆盖、自动前进/聚焦）。token 已被后续输入替换（T1→T2）时：
          // resolvedIssues 始终安全应用（服务端已原子确认），但绝不删除最新 draft、
          // 绝不覆盖最新本地文字/状态、绝不执行旧确认自动前进。
          if (enqueued.isCurrent()) {
            draftsRef.current.delete(plan.confirmedId);
            setSegments((prev) =>
              prev.map((s) => (s.segmentId === result.segment.segmentId ? result.segment : s)),
            );
            if (opts.advance) {
              if (plan.nextId) {
                selectSegment(plan.nextId, { locate: true, pauseIfPlaying: true });
                setFollow(true);
                focusSegmentEditor(plan.nextId);
              }
            } else {
              selectSegment(plan.confirmedId, {});
            }
          }
          // resolvedIssues 始终应用（无论 token 是否 current——服务端已原子确认）。
          if (resolvedIds.size > 0) {
            setIssues((prev) =>
              prev.map((i) => {
                if (!resolvedIds.has(i.issueId)) return i;
                const fresh = result.resolvedIssues.find((r) => r.issueId === i.issueId);
                return fresh ?? { ...i, status: "resolved" };
              }),
            );
          }
        } catch (err) {
          setConfirmError(
            `确认失败：${err instanceof Error ? err.message : String(err)}（段落与疑点未变化，可重试）`,
          );
          // P0-2（第 5 轮）+ P0-1（第 6 轮）：仅当队列项仍是本 confirm token 时降级；
          // 降级 op 在执行时读取最新值。
          if (enqueued.isCurrent()) {
            downgradeConfirmToDraftSave(plan.confirmedId);
          }
          throw err;
        }
      });
      // P0-2（第 5 轮）+ P0-1（第 6 轮）：flush 后检查——仅当 confirm 尚未执行且
      // 队列项仍是本 token 时才降级为草稿保存（执行时读最新值）。
      // confirm 已成功（confirmSucceeded）或其他 op 失败均不触发。
      void save.flush().then(() => {
        if (save.state.state === "failed" && !confirmSucceeded && enqueued.isCurrent()) {
          downgradeConfirmToDraftSave(plan.confirmedId);
          setConfirmError("前置保存失败，确认已被阻止。请先重试保存成功后再点击「确认本段」。");
        }
      });
    },
    [save, downgradeConfirmToDraftSave, focusSegmentEditor, selectSegment],
  );

  /** 稳定行内确认回调：父渲染不产生新函数，保住 SegmentRow 的 memo 跳过（第 10 轮审计 1）。 */
  const handleRowConfirm = useCallback(
    (segmentId: string) => applyConfirm(segmentId, { advance: false }),
    [applyConfirm],
  );

  /** 点击条目 / Alt+←→ / 回到播放点：选中 + 精确定位 startMs；播放中先暂停；不自动播放。
   *  聚焦文本框走 handleEditorFocus（当前播放段只精确暂停记续播点，其他段才定位段首）。 */
  const handleRowLocate = useCallback(
    (segmentId: string) => {
      selectSegment(segmentId, { locate: true, pauseIfPlaying: true });
      setFollow(true);
    },
    [selectSegment],
  );

  /**
   * V1.1.4 编辑打断精确续播（AC-067）：聚焦校对文本框与行空白区点击语义分离——
   * 当前选中段正在播放时聚焦其文本框 → 只在精确打断位置暂停（不 seek、不回段首），
   * 记录一次性无回退续播点；聚焦其他段仍按既有规则（暂停旧段、切换选中并定位新段段首）；
   * 行空白区点击始终走 handleRowLocate（AC-041 精确定位段首不受影响）。
   */
  const handleEditorFocus = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      const a = audioRef.current;
      const r = playerRef.current.range;
      const playingThisSegment =
        !!seg &&
        !!a &&
        !a.paused &&
        !!r &&
        r.startMs === seg.startMs &&
        r.endMs === seg.endMs &&
        selectedIdRef.current === segmentId;
      if (playingThisSegment) {
        playerRef.current.pauseForEdit();
        return;
      }
      selectSegment(segmentId, { locate: true, pauseIfPlaying: true });
      setFollow(true);
    },
    [selectSegment],
  );

  /** 行内播放/暂停开关（双击时间码同）：选中该段并按范围感知规则起播/暂停。 */
  const handleRowTogglePlay = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      updateSelected(segmentId);
      setFollow(true);
      playerRef.current.toggleRange({ startMs: seg.startMs, endMs: seg.endMs });
    },
    [updateSelected],
  );

  /**
   * 行内 ±2 秒复听（PRD V1.0.7 AC-051），与 F7/F9 共用 player.skip 的段内钳制：
   * - 目标行已选中且就是当前正在播放的活动范围 → 直接 skip，保持播放、段内 seek；
   * - 目标行未选中但播放器正在播其范围（重复时间范围段）→ 仅幂等切换选中
   *   （setRange 同范围 no-op，不打断播放），再 skip；
   * - 其余换段 → 先同步切换选中与活动范围（暂停旧段并定位到目标段段首），再 skip——
   *   全程不调用 play()：暂停时只定位、绝不自动播放。
   * 决策只读 ref（sortedRef/selectedIdRef/playerRef/audioRef），不依赖 React state 异步更新；
   * skip 后重申目标行选中：位置反查在重复时间范围下恒返回首行，不得覆盖显式行选择。
   */
  const handleRowSkip = useCallback(
    (segmentId: string, deltaMs: number) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      const a = audioRef.current;
      const r = playerRef.current.range;
      const playingTargetRange =
        !!a && !a.paused && !!r && r.startMs === seg.startMs && r.endMs === seg.endMs;
      if (selectedIdRef.current !== segmentId) {
        setFollow(true);
        selectSegment(segmentId, {
          locate: !playingTargetRange,
          pauseIfPlaying: !playingTargetRange,
        });
      }
      playerRef.current.skip(deltaMs);
      // usePlaybackSelection 按播放头位置反查段（重复时间范围恒返回第一行），
      // selectSegment/skip 内 seek 的位置通知会把选中拉回重复范围的首行；
      // 显式行操作必须以按钮所在行为准（AC-051），这里重申目标行选中（幂等）。
      if (selectedIdRef.current !== segmentId) updateSelected(segmentId);
    },
    [selectSegment],
  );

  /** 稳定行内复听回调（AC-051 顺序：播放/暂停之后、确认之前）。 */
  const handleRowSkipBack = useCallback(
    (segmentId: string) => handleRowSkip(segmentId, -2000),
    [handleRowSkip],
  );
  const handleRowSkipForward = useCallback(
    (segmentId: string) => handleRowSkip(segmentId, 2000),
    [handleRowSkip],
  );

  /** 疑点面板「跳转播放」：选中目标段并从其段首播放（区别于行内播放/暂停开关）。 */
  const handleJumpPlay = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      updateSelected(segmentId);
      setFollow(true);
      playerRef.current.playRange({ startMs: seg.startMs, endMs: seg.endMs });
    },
    [updateSelected],
  );

  const handleTimelineSeek = useCallback((ms: number) => playerRef.current.seek(ms), []);

  // 第 10 轮审计 item 3 + 第 11 轮审计 3：先结构比较（直接用 SegmentRecord 字段），
  // 纯正文变化返回同一引用（React.memo 跳过 Timeline render）；不每键先 map 1,676 个对象。
  const timelineDataCacheRef = useRef<TimelineSegLike[] | null>(null);
  const timelineData = useMemo(() => {
    const { reused, value } = reuseTimelineData(timelineDataCacheRef.current, segments);
    if (!reused) timelineDataCacheRef.current = value;
    return value;
  }, [segments]);

  /** F8 与行内播放/暂停按钮共用：对当前选中段做范围感知播放/暂停切换（底部无重复按钮）。 */
  const handleMainToggle = useCallback(() => {
    const seg = sortedRef.current.find((s) => s.segmentId === selectedIdRef.current);
    if (!seg) return;
    playerRef.current.toggleRange({ startMs: seg.startMs, endMs: seg.endMs });
  }, []);

  const toggleLoopSegment = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      const { locateFirst } = planLoopToggle(selectedIdRef.current, segmentId);
      if (locateFirst) {
        // 先让目标段成为当前段/范围（定位但不自动播放），循环才真正作用在该段上。
        selectSegment(segmentId, { locate: true, pauseIfPlaying: true });
      }
      playerRef.current.loopSegment(seg.startMs, seg.endMs);
    },
    [selectSegment],
  );

  // ---------- 疑点（写入纳入保存协调器） ----------

  const unresolved = useMemo(
    () => issues.filter((i) => i.status === "open"),
    [issues],
  );
  // 疑点集合不变时保持同一 Map 实例：正文编辑不会让未修改行失去 memo 跳过能力。
  const unresolvedBySegment = useMemo(
    () => buildUnresolvedBySegment(unresolved),
    [unresolved],
  );
  const machineBySegment = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of unresolved) {
      if (issue.origin === "machine_prefilter") {
        map.set(issue.segmentId, (map.get(issue.segmentId) ?? 0) + 1);
      }
    }
    return map;
  }, [unresolved]);

  const createIssue = useCallback(
    (segmentId: string, type: IssueType, severity: IssueSeverity, note: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg) return;
      const issue: IssueRecord = {
        issueId: randomUuid(),
        projectId: metaRef.current.projectId,
        segmentId,
        startMs: seg.startMs,
        endMs: seg.endMs,
        type,
        severity,
        note,
        status: "open",
        createdAt: Date.now(),
        resolvedAt: null,
      };
      setIssues((prev) => [...prev, issue]);
      noteIssueMutation(issue.issueId); // per-ID token：保存成功前任何 GET 不得覆盖本地结果
      save.enqueue(`issue:${issue.issueId}`, async () => {
        const ackThisSave = captureIssueSaveToken(issue.issueId);
        const latest = issuesRef.current.find((i) => i.issueId === issue.issueId);
        if (!latest) return; // 已被删除：跳过
        await upsertIssue(latest);
        ackThisSave(); // 保存成功：仅当 token 仍是最新时才 ack
      });
      if (seg.status !== "confirmed") {
        setSegments((prev) =>
          prev.map((s) =>
            s.segmentId === segmentId && s.status !== "confirmed"
              ? { ...s, status: "questioned" }
              : s,
          ),
        );
        persistSegment(segmentId);
      }
      save.schedule();
    },
    [save, persistSegment],
  );

  /** 行内类型选择层选定后创建：severity 恒为 blocking、备注为空（PRD V1.0.4）。 */
  const handleCreateIssueWithType = useCallback(
    (segmentId: string, type: IssueType) => {
      createIssue(segmentId, type, "blocking", "");
    },
    [createIssue],
  );

  /** 行内撤销确认：有未解决疑点回到 questioned，否则 editing；
   *  选中目标与行内确认一致（按钮所在行），不跳下一段、不改变播放头。 */
  const unconfirmSegment = useCallback(
    (segmentId: string) => {
      const seg = sortedRef.current.find((s) => s.segmentId === segmentId);
      if (!seg || seg.status !== "confirmed") return;
      const hasOpen = issuesRef.current.some(
        (i) => i.segmentId === segmentId && i.status === "open",
      );
      setStatus(segmentId, planUnconfirm(hasOpen));
      selectSegment(segmentId, {});
    },
    [setStatus, selectSegment],
  );

  const resolveIssue = useCallback(
    (issueId: string) => {
      const issue = issuesRef.current.find((i) => i.issueId === issueId);
      if (!issue) return;
      const resolved: IssueRecord = { ...issue, status: "resolved", resolvedAt: Date.now() };
      setIssues((prev) => prev.map((i) => (i.issueId === issueId ? resolved : i)));
      noteIssueMutation(issueId); // per-ID token：保存成功前任何 GET 不得覆盖本地结果
      save.enqueue(`issue:${issueId}`, async () => {
        const ackThisSave = captureIssueSaveToken(issueId);
        const latest = issuesRef.current.find((i) => i.issueId === issueId);
        if (!latest) return;
        await upsertIssue(latest);
        ackThisSave();
      });
      const stillOpen = issuesRef.current.some(
        (i) => i.segmentId === issue.segmentId && i.issueId !== issueId && i.status === "open",
      );
      if (!stillOpen) {
        setSegments((prev) =>
          prev.map((s) =>
            s.segmentId === issue.segmentId && s.status === "questioned"
              ? { ...s, status: "editing" }
              : s,
          ),
        );
        persistSegment(issue.segmentId);
      }
      save.schedule();
    },
    [save, persistSegment],
  );

  const removeIssue = useCallback(
    (issueId: string) => {
      const issue = issuesRef.current.find((i) => i.issueId === issueId);
      setIssues((prev) => prev.filter((i) => i.issueId !== issueId));
      noteIssueMutation(issueId); // per-ID token：保存成功前任何 GET 不得覆盖本地结果
      save.enqueue(`issue:${issueId}`, async () => {
        const ackThisSave = captureIssueSaveToken(issueId);
        // 删除前重新确认仍在库中语义：直接 delete（幂等）。
        const stillThere = issuesRef.current.some((i) => i.issueId === issueId);
        if (stillThere) return; // 已被撤销/重建：跳过
        await deleteIssue(issueId);
        ackThisSave();
      });
      if (issue) {
        const stillOpen = issuesRef.current.some(
          (i) => i.segmentId === issue.segmentId && i.issueId !== issueId && i.status === "open",
        );
        if (!stillOpen) {
          setSegments((prev) =>
            prev.map((s) =>
              s.segmentId === issue.segmentId && s.status === "questioned"
                ? { ...s, status: "editing" }
                : s,
            ),
          );
          persistSegment(issue.segmentId);
        }
      }
      save.schedule();
    },
    [save, persistSegment],
  );

  // ---------- 键盘（F7 后退 / F8 播放暂停 / F9 前进，可配置） ----------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const inText = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === keymap.playPause) {
          e.preventDefault();
          e.stopPropagation();
          handleMainToggle();
          return;
        }
        if (e.key === keymap.seekBack) {
          e.preventDefault();
          e.stopPropagation();
          playerRef.current.skip(-2000);
          return;
        }
        if (e.key === keymap.seekForward) {
          e.preventDefault();
          e.stopPropagation();
          playerRef.current.skip(2000);
          return;
        }
      }

      if (e.altKey && e.key === "ArrowLeft" && !inText) {
        e.preventDefault();
        e.stopPropagation();
        const sorted = sortedRef.current;
        const idx = sorted.findIndex((s) => s.segmentId === selectedIdRef.current);
        const prev = sorted[Math.max(0, idx - 1)];
        if (prev) {
          handleRowLocate(prev.segmentId);
        }
        return;
      }
      if (e.altKey && e.key === "ArrowRight" && !inText) {
        e.preventDefault();
        e.stopPropagation();
        const sorted = sortedRef.current;
        const idx = sorted.findIndex((s) => s.segmentId === selectedIdRef.current);
        const next = sorted[Math.min(sorted.length - 1, idx + 1)];
        if (next) {
          handleRowLocate(next.segmentId);
        }
        return;
      }

      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedIdRef.current) {
          applyConfirm(selectedIdRef.current, { advance: true });
        }
        return;
      }
      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        e.stopPropagation();
        if (selectedIdRef.current) toggleLoopSegment(selectedIdRef.current);
        return;
      }
      if (e.ctrlKey && e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedIdRef.current) createIssue(selectedIdRef.current, "unclear", "blocking", "");
        return;
      }
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        setShowKeymap((v) => !v);
        return;
      }
      if (e.key === "Escape" && inText) {
        (target as HTMLElement).blur();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [keymap, applyConfirm, toggleLoopSegment, createIssue, handleRowLocate, handleMainToggle]);

  // ---------- 导出 ----------

  // V1.0.5 AC-048：导出预览是导出时才需要的全量计算——不在输入路径上逐键重建。
  const computeExportPreview = useCallback(
    () => buildExportPreview(segments, issues, draftsRef.current),
    [segments, issues],
  );

  const sourceHandleRefs = useMemo<SourceHandleRef[]>(
    () => [
      { label: "源字幕（SRT）", handle: meta.media.srtHandle },
      { label: "源音频（MP3）", handle: meta.media.audioHandle },
    ],
    [meta.media.srtHandle, meta.media.audioHandle],
  );

  const doExport = useCallback(
    async (fileName: string): Promise<string> => {
      const exportPreview = computeExportPreview();
      // 空文本段是明确阻塞项：空段导出后必然无法通过回读校验（见 exportRoundTrip 测试）。
      if (exportPreview.emptyTextCount > 0) {
        throw new Error(
          `存在 ${exportPreview.emptyTextCount} 个空文本段，导出被阻止。请补全这些段的文本后重试。`,
        );
      }
      const srtText = renderExportSrt(exportPreview);
      // 写出前先在内存中自检一次（下载路径没有回读能力，靠这一步兜底）。
      const selfCheck = verifyRoundTrip(exportPreview.cues, srtText);
      if (!selfCheck.ok) {
        throw new Error(`导出内容自检失败：${selfCheck.firstDiff ?? "未知差异"}`);
      }
      const target = await pickSaveTarget(fileName);
      if (target.mode === "download") {
        await downloadText(target.name, srtText);
        return `✔ 已通过浏览器下载写出（${exportPreview.cues.length} 段）。下载不会覆盖已有文件；此环境无法回读磁盘文件，内容已在写出前自检通过。`;
      }
      // 源文件保护：阻止把导出写到源 SRT / 源 MP3 上；无法验证时默认阻止（不冒险写出）。
      const guard = await checkExportTarget(target.handle, sourceHandleRefs);
      if (guard.status === "match") {
        throw new Error(
          `已阻止导出：所选文件与${guard.label}是同一个文件。导出不能覆盖源文件，请另选文件名或目录（未写出任何内容）。`,
        );
      }
      if (guard.status === "unverifiable") {
        throw new Error(
          `无法验证所选位置不是源文件（${guard.reason}）。为安全起见已阻止写出，未写出任何内容；可重新打开项目恢复源文件句柄后重试。`,
        );
      }
      await writeToHandle(target.handle as SaveHandle, srtText);
      const written = await readHandleText(target.handle as SaveHandle);
      const check = verifyRoundTrip(exportPreview.cues, written);
      if (!check.ok) {
        throw new Error(
          `导出后回读校验失败：${
            check.firstDiff ??
            check.parseErrors.map((p) => `行 ${p.line}: ${p.message}`).join("；")
          }`,
        );
      }
      return `✔ 已写出并回读校验通过（${check.cueCountActual} 段，写出方式：File System Access API）。`;
    },
    [computeExportPreview, sourceHandleRefs],
  );

  // ---------- 渲染 ----------

  const totalMs = player.durationMs || meta.media.durationMs || 0;

  return (
    <div className="workbench">
      <div className="wb-header">
        <button onClick={() => void handleBack()}>← 项目</button>
        <span className="title">{meta.name}</span>
        <span className="hint">
          {segments.length} 段 · 音频 {formatDuration(totalMs)}
          {tailGapMs !== null && tailGapMs > 1000 && (
            <span
              className="tail-gap"
              title="音频总长减去最后一条字幕结束时间（尾部覆盖差异，PRD AC-025）"
            >
              · 尾部未覆盖 {formatDuration(tailGapMs)}
            </span>
          )}
        </span>
        <span className={`issue-badge ${unresolved.length === 0 ? "zero" : ""}`}>
          未解决疑点 {unresolved.length}
        </span>
        <span className="spacer" />
        <PrefilterPanel
          projectId={meta.projectId}
          onIssuesChanged={refreshIssues}
          flushSaves={() => save.flush()}
          getSaveState={() => save.state}
        />
        <button onClick={() => setShowKeymap((v) => !v)}>
          快捷键（<Kbd label={keymap.playPause} /> 播放）
        </button>
        <button className="primary" onClick={() => setShowExport(true)}>
          导出 SRT…
        </button>
        <SaveStatusView status={saveStatus} onRetry={() => void save.flush()} />
      </div>

      {showKeymap && <KeymapBar keymap={keymap} onClose={() => setShowKeymap(false)} />}
      {appError && <div className="notice-err" style={{ padding: "6px 14px" }}>✖ {appError}</div>}
      {confirmError && (
        <div className="notice-err" style={{ padding: "6px 14px" }} role="alert">✖ {confirmError}</div>
      )}
      {issuesRefreshError && (
        <div className="notice-err" style={{ padding: "6px 14px" }} role="alert">
          ✖ 读取最新疑点失败：{issuesRefreshError}
          <button
            style={{ marginLeft: 8 }}
            onClick={() => void refreshIssues()}
            title="只重新读取疑点列表，不会重跑预筛模型"
          >
            重试读取疑点
          </button>
        </div>
      )}
      {audioNotice && !audioFile && (
        <div className="notice-warn" style={{ padding: "6px 14px" }}>
          ⚠ {audioNotice}
          <button style={{ marginLeft: 8 }} onClick={() => void relocateAudio()}>
            重新定位音频文件…
          </button>
        </div>
      )}
      {audioError && <div className="notice-err" style={{ padding: "6px 14px" }}>✖ {audioError}</div>}

      <div className="wb-main">
        <div className="wb-list" ref={listScrollRef}>
          {segments.length === 0 ? (
            <div className="empty-state">
              <div>该项目没有任何字幕段。</div>
              <div className="hint">请返回导入页重新选择 SRT。</div>
            </div>
          ) : (
            <SegmentList
              segments={sortedSegments}
              selectedId={selectedId}
              unresolvedBySegment={unresolvedBySegment}
              machineCountBySegment={machineBySegment}
              onDraftChange={editSegment}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onConfirmRow={handleRowConfirm}
              onUnconfirmRow={unconfirmSegment}
              onLocate={handleRowLocate}
              onEditorFocus={handleEditorFocus}
              renderProbe={segmentRenderProbe}
              onTogglePlay={handleRowTogglePlay}
              onSkipBack={handleRowSkipBack}
              onSkipForward={handleRowSkipForward}
              playingSegmentId={player.playing ? selectedId : null}
              onLoop={toggleLoopSegment}
              onCreateIssueWithType={handleCreateIssueWithType}
              loopSegmentId={segmentIdForRange(sortedSegments, player.loop)}
            />
          )}
        </div>
        <IssuePanel
          issues={issues}
          segments={sortedSegments}
          activeId={selectedId}
          onJumpPlay={handleJumpPlay}
          onResolve={resolveIssue}
          onDelete={removeIssue}
          onCreate={createIssue}
        />
      </div>

      <div className="player-bar">
        <Timeline
          segments={timelineData}
          durationMs={totalMs}
          loop={player.loop}
          onSeek={handleTimelineSeek}
          subscribeCurrentMs={player.subscribeCurrentMs}
        />
        <div className="player-controls">
          <TimeDisplay subscribeCurrentMs={player.subscribeCurrentMs} totalMs={totalMs} />
          <label>
            速度
            <select
              value={player.speed.toFixed(2)}
              onChange={(e) => player.setSpeed(parseFloat(e.target.value))}
            >
              {[0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0].map((r) => (
                <option key={r} value={r.toFixed(2)}>
                  {r.toFixed(2)}×
                </option>
              ))}
            </select>
          </label>
          <label title="从暂停恢复播放时自动回退的毫秒数；仅在暂停期间没有跳转时生效">
            自动回退
            <input
              type="number"
              min={0}
              max={5000}
              step={100}
              value={player.autoRewindMs}
              onChange={(e) => player.setAutoRewindMs(parseInt(e.target.value || "0", 10))}
              style={{ width: 76 }}
            />
            ms
          </label>
          <button
            onClick={() => selectedId && toggleLoopSegment(selectedId)}
            title="循环当前字幕段（Ctrl+L）"
          >
            {player.loop ? "⭯ 循环中" : "⭯ 循环本段"}
          </button>
          {player.loop && (
            <span className="loop-indicator">
              循环 {formatDisplay(player.loop.startMs)} – {formatDisplay(player.loop.endMs)}
            </span>
          )}
          {!follow && (
            <button
              onClick={() => {
                setFollow(true);
                if (selectedId) handleRowLocate(selectedId);
              }}
            >
              回到播放点
            </button>
          )}
        </div>
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="metadata"
          onError={() =>
            setAudioError(
              "音频无法解码或文件不可访问（浏览器解码失败）。源文件未被修改；如文件被移动，请点击上方“重新定位音频文件”。",
            )
          }
        />
      </div>

      {showExport && (
        <ExportDialog
          computePreview={computeExportPreview}
          suggestedName={`${meta.normalizedStem}.校对.V001.srt`}
          fsAccess={supportsFileSystemAccess()}
          sourceGuardReady={canVerifySources(sourceHandleRefs)}
          onExport={doExport}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

function buildUnresolvedBySegment(unresolved: IssueRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of unresolved) m.set(i.segmentId, (m.get(i.segmentId) ?? 0) + 1);
  return m;
}

function Kbd({ label }: { label: string }) {
  return <span className="kbd">{label}</span>;
}

function SaveStatusView({
  status,
  onRetry,
}: {
  status: SaveState;
  onRetry: () => void;
}) {
  if (status.state === "idle") return <span className="save-status">尚未编辑</span>;
  if (status.state === "saving") return <span className="save-status">↻ 保存中…</span>;
  if (status.state === "saved")
    return (
      <span className="save-status saved">
        ✔ 已保存 {new Date(status.at).toLocaleTimeString("zh-CN", { hour12: false })}
      </span>
    );
  return (
    <span className="save-status failed">
      ✖ 保存失败（{status.failedCount} 项未落盘）：{status.message}{" "}
      <button onClick={onRetry}>重试</button>
    </span>
  );
}

function TimeDisplay({
  subscribeCurrentMs,
  totalMs,
}: {
  subscribeCurrentMs: (cb: (ms: number) => void) => () => void;
  totalMs: number;
}) {
  const [ms, setMs] = useState(0);
  useEffect(() => subscribeCurrentMs(setMs), [subscribeCurrentMs]);
  return (
    <span className="time-display">
      {formatDisplay(ms)} <span className="total">/ {formatDisplay(totalMs)}</span>
    </span>
  );
}
