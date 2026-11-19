import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { msg } from "../i18n.js";
import { usePlayer } from "../audio/usePlayer.js";
import { formatDisplay, formatDuration } from "../core/time.js";
import { randomUuid } from "../core/identity.js";
import { createPageExitGuard } from "../core/navigation.js";
import type { SegmentRecord, SegmentStatus } from "../store/types.js";
import { LanguageButton, useLanguage } from "./LanguageButton.js";
import { SegmentList } from "./SegmentList.js";
import { Timeline } from "./Timeline.js";

export type AssignmentTarget = { kind: "none" } | { kind: "invalid" } | { kind: "assignment"; spaceId: string; assignmentId: string };
type SegmentView = Omit<SegmentRecord, "projectId">;
interface AssignmentData {
  assignment: { id: string; spaceId: string; title: string; status: "active"; expiresAt: number | null };
  revision: number;
  cursor: number;
  segments: SegmentView[];
  canSubmit: boolean;
}
interface Correction { segmentId: string; correctedText: string; status?: SegmentStatus; }
interface PendingCorrections { expectedRevision: number; idempotencyKey: string; corrections: Correction[]; }
interface Draft { correctedText: string; status?: SegmentStatus; baseRevisionNo: number; }
interface AssignmentError { status: number; }
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const statuses: SegmentStatus[] = ["unreviewed", "editing", "questioned", "confirmed", "accepted_unclear"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const noChange = () => {};

export function assignmentTarget(search: string): AssignmentTarget {
  const query = new URLSearchParams(search);
  if (!query.has("space") && !query.has("assignment")) return { kind: "none" };
  const spaceId = query.get("space"), assignmentId = query.get("assignment");
  if (query.getAll("space").length !== 1 || query.getAll("assignment").length !== 1 || !identifier(spaceId) || !identifier(assignmentId)) return { kind: "invalid" };
  return { kind: "assignment", spaceId, assignmentId };
}
function unavailable(status: number): Error & AssignmentError {
  return Object.assign(new Error("Assignment could not be loaded."), { status });
}
function parseAssignment(value: unknown, target: Extract<AssignmentTarget, { kind: "assignment" }>): AssignmentData {
  if (!record(value) || !record(value.assignment) || value.assignment.id !== target.assignmentId || value.assignment.spaceId !== target.spaceId || typeof value.assignment.title !== "string" || !integer(value.revision) || !integer(value.cursor) || !Array.isArray(value.segments) || value.segments.length > 10000) throw unavailable(502);
  if (value.assignment.status !== "active") throw unavailable(404);
  const expiresAt = value.assignment.expiresAt;
  if (expiresAt !== null && (!integer(expiresAt) || expiresAt <= Date.now())) throw unavailable(403);
  const seen = new Set<string>();
  const segments = value.segments.map((segment: unknown): SegmentView => {
    if (!record(segment) || !identifier(segment.segmentId) || seen.has(segment.segmentId) || !integer(segment.startMs) || !integer(segment.endMs) || segment.endMs <= segment.startMs || !(segment.cueNo === null || integer(segment.cueNo)) || typeof segment.originalText !== "string" || typeof segment.correctedText !== "string" || !statuses.includes(segment.status as SegmentStatus) || !integer(segment.revisionNo) || !integer(segment.updatedAt)) throw unavailable(502);
    seen.add(segment.segmentId);
    return { segmentId: segment.segmentId, cueNo: segment.cueNo, startMs: segment.startMs, endMs: segment.endMs, originalText: segment.originalText, correctedText: segment.correctedText, status: segment.status as SegmentStatus, revisionNo: segment.revisionNo, updatedAt: segment.updatedAt };
  });
  return { assignment: { id: target.assignmentId, spaceId: target.spaceId, title: value.assignment.title, status: "active", expiresAt }, revision: value.revision, cursor: value.cursor, segments, canSubmit: record(value.permissions) && value.permissions.submit === true };
}
async function readSession(signal: AbortSignal) {
  const response = await fetch("/auth/session", { cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error", signal });
  if (!response.ok) throw unavailable(response.status);
  const session: unknown = await response.json();
  if (!record(session) || typeof session.csrfToken !== "string" || !session.csrfToken || !integer(session.expiresAt) || session.expiresAt <= Date.now()) throw unavailable(401);
  return { csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}
async function readAssignment(target: Extract<AssignmentTarget, { kind: "assignment" }>, signal: AbortSignal) {
  const session = await readSession(signal);
  const response = await fetch("/api/business/invoke", { method: "POST", cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error", signal, headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ appId: "tingproof", spaceId: target.spaceId, operation: "get_assignment", resourceId: target.assignmentId, input: {} }) });
  if (!response.ok) throw unavailable(response.status);
  return { data: parseAssignment(await response.json(), target), sessionExpiresAt: session.expiresAt, sessionRef: session.csrfToken };
}
async function submitAssignment(target: Extract<AssignmentTarget, { kind: "assignment" }>, pending: PendingCorrections, expectedSession: string, signal: AbortSignal) {
  const session = await readSession(signal);
  if (session.csrfToken !== expectedSession) throw unavailable(401);
  const response = await fetch("/api/business/invoke", { method: "POST", cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error", signal, headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ appId: "tingproof", spaceId: target.spaceId, operation: "submit_corrections", resourceId: target.assignmentId, expectedRevision: pending.expectedRevision, idempotencyKey: pending.idempotencyKey, input: { corrections: pending.corrections } }) });
  if (!response.ok) throw unavailable(response.status);
  await response.arrayBuffer();
}

function assignmentError(status: number) {
  if (status === 401) return msg("Your session expired. Sign in again to open this assignment.", "登录已失效，请重新登录后打开此任务。");
  if (status === 403) return msg("You do not currently have access to this assignment.", "你当前无权访问此任务。");
  if (status === 404) return msg("This assignment is unavailable, expired or revoked.", "此任务不存在、已到期或已撤销。");
  return msg("Could not load the assignment. Retry to check the latest version.", "暂时无法读取任务，请重试以核对最新版本。");
}

export function AssignmentWorkbench({ target }: { target: Exclude<AssignmentTarget, { kind: "none" }> }) {
  useLanguage();
  const [data, setData] = useState<AssignmentData | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const active = useRef<AbortController | null>(null), generation = useRef(0), writing = useRef(false), sessionRef = useRef<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const scope = target.kind === "assignment" ? `${target.spaceId}:${target.assignmentId}` : "invalid";
  const refresh = useCallback(async () => {
    if (target.kind !== "assignment" || writing.current) return null;
    const current = ++generation.current; active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setLoading(true); setError(null);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const result = await readAssignment(target, controller.signal);
      if (generation.current !== current) return null;
      if (sessionRef.current && sessionRef.current !== result.sessionRef) setSessionVersion(version => version + 1);
      sessionRef.current = result.sessionRef;
      setData(result.data); setExpiresAt(Math.min(result.sessionExpiresAt, result.data.assignment.expiresAt ?? Infinity));
      return result.data;
    } catch (reason) {
      if (generation.current !== current) return null;
      const status = record(reason) && typeof reason.status === "number" ? reason.status : 503;
      setError(status);
      if ([401, 403, 404, 502].includes(status)) { setData(null); setExpiresAt(null); }
      if ([401, 403].includes(status)) document.dispatchEvent(new CustomEvent("praxis-navigation-state", { detail: { state: status === 401 ? "login-required" : "authorization-required" } }));
      return null;
    } finally { clearTimeout(timeout); if (generation.current === current) setLoading(false); }
  }, [target]);
  const submit = useCallback(async (pending: PendingCorrections) => {
    if (target.kind !== "assignment" || !data?.canSubmit || !sessionRef.current || writing.current) throw unavailable(403);
    const current = ++generation.current; active.current?.abort(); const controller = new AbortController(); active.current = controller;
    writing.current = true; setLoading(true); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await submitAssignment(target, pending, sessionRef.current, controller.signal);
      if (generation.current !== current) throw unavailable(503);
    } catch (reason) {
      const status = record(reason) && typeof reason.status === "number" ? reason.status : 503;
      if (generation.current === current && [401, 403, 404].includes(status)) { setData(null); setExpiresAt(null); setError(status); }
      throw reason;
    } finally { clearTimeout(timeout); writing.current = false; if (generation.current === current) setLoading(false); }
  }, [target, data?.canSubmit]);
  useEffect(() => {
    setData(null); setExpiresAt(null); void refresh();
    const interval = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 30000);
    const visible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { generation.current++; active.current?.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [scope, refresh]);
  useEffect(() => {
    if (expiresAt === null) return;
    const expire = () => { generation.current++; active.current?.abort(); setData(null); setError(403); setLoading(false); };
    const timeout = setTimeout(expire, Math.max(0, Math.min(expiresAt - Date.now(), 2147483647)));
    return () => clearTimeout(timeout);
  }, [expiresAt]);
  if (target.kind === "invalid") return <div className="app"><div className="empty-state" role="alert">{msg("This assignment link is incomplete or invalid.", "任务链接不完整或无效。")}</div></div>;
  return <div className="app">
    {error !== null && <div className="notice-err" role="alert" style={{ padding: "8px 14px" }}>{assignmentError(error)} {data && msg("The last verified version remains visible.", "当前显示上次核验的版本。")}
      {error === 401 ? <a href={`/auth/login?return_to=${encodeURIComponent(`/apps/tingproof/?${new URLSearchParams({ space: target.spaceId, assignment: target.assignmentId })}`)}`}>{msg("Sign in", "登录")}</a> : <button type="button" onClick={() => void refresh()}>{msg("Retry", "重试")}</button>}
    </div>}
    {data ? <NativeAssignment key={`${scope}:${sessionVersion}`} data={data} loading={loading} onRefresh={refresh} onSubmit={submit} /> : <div className="empty-state" role="status">{loading ? msg("Loading assigned segments…", "正在读取分配的字幕段…") : error === null ? msg("No assigned material is available.", "暂无可读取的任务材料。") : ""}</div>}
  </div>;
}

function NativeAssignment({ data, loading, onRefresh, onSubmit }: { data: AssignmentData; loading: boolean; onRefresh: () => Promise<AssignmentData | null>; onSubmit: (pending: PendingCorrections) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(data.segments[0]?.segmentId ?? null), [file, setFile] = useState<File | null>(null), [audioUrl, setAudioUrl] = useState<string | null>(null), [audioError, setAudioError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState(new Map<string, Draft>()), [conflicts, setConflicts] = useState(new Set<string>()), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [saveMessage, setSaveMessage] = useState<string | null>(null), [composingCount, setComposingCount] = useState(0);
  const draftsRef = useRef(drafts), dataRef = useRef(data), savingRef = useRef(false), pendingRef = useRef<PendingCorrections | null>(null), composing = useRef(new Set<string>()), alive = useRef(true), dirty = useRef(false), exitGuard = useRef<ReturnType<typeof createPageExitGuard> | null>(null);
  dataRef.current = data;
  dirty.current = drafts.size > 0 || saving || composingCount > 0;
  const changeDrafts = useCallback((next: Map<string, Draft>) => { draftsRef.current = next; setDrafts(next); }, []);
  useEffect(() => { alive.current = true; exitGuard.current = createPageExitGuard(() => dirty.current); return () => { alive.current = false; exitGuard.current?.dispose(); }; }, []);
  useEffect(() => exitGuard.current?.refresh(), [drafts.size, saving, composingCount]);
  useEffect(() => {
    const next = new Map(draftsRef.current), changed = new Set<string>();
    if (!data.canSubmit) {
      if (next.size) setSaveMessage(msg("Submission access ended. The assignment is now read-only.", "提交权限已结束，任务现为只读。"));
      next.clear(); pendingRef.current = null; setUncertain(false); composing.current.clear(); setComposingCount(0);
    } else {
      for (const [id, draft] of next) {
        const source = data.segments.find(segment => segment.segmentId === id);
        if (!source || source.correctedText === draft.correctedText && (draft.status === undefined || source.status === draft.status)) next.delete(id);
        else if (source.revisionNo !== draft.baseRevisionNo) changed.add(id);
      }
      if (pendingRef.current && !next.size) { pendingRef.current = null; setUncertain(false); setSaveMessage(msg("Corrections verified in the current assignment.", "已在当前任务中核验校正。")); }
    }
    changeDrafts(next); setConflicts(changed);
  }, [data, changeDrafts]);
  const edit = (id: string, text: string) => {
    if (!dataRef.current.canSubmit || savingRef.current || uncertain) return;
    const source = dataRef.current.segments.find(segment => segment.segmentId === id); if (!source) return;
    const next = new Map(draftsRef.current), prior = next.get(id);
    if (text === source.correctedText && (prior?.status === undefined || prior.status === source.status)) next.delete(id);
    else next.set(id, { correctedText: text, ...(prior?.status && { status: prior.status }), baseRevisionNo: prior?.baseRevisionNo ?? source.revisionNo });
    changeDrafts(next); setSaveMessage(null); if (!next.has(id)) setConflicts(values => new Set([...values].filter(value => value !== id)));
  };
  const stageStatus = (id: string, status: SegmentStatus) => {
    if (!dataRef.current.canSubmit || savingRef.current || uncertain) return;
    const source = dataRef.current.segments.find(segment => segment.segmentId === id); if (!source) return;
    const next = new Map(draftsRef.current), prior = next.get(id), text = prior?.correctedText ?? source.correctedText;
    if (text === source.correctedText && status === source.status) next.delete(id);
    else next.set(id, { correctedText: text, status, baseRevisionNo: prior?.baseRevisionNo ?? source.revisionNo });
    changeDrafts(next); setSaveMessage(null);
  };
  const resolveConflict = (id: string, keep: boolean) => {
    const next = new Map(draftsRef.current), source = dataRef.current.segments.find(segment => segment.segmentId === id), draft = next.get(id);
    if (!keep || !source) next.delete(id); else if (draft) next.set(id, { ...draft, baseRevisionNo: source.revisionNo });
    changeDrafts(next); setConflicts(values => new Set([...values].filter(value => value !== id))); pendingRef.current = null; setUncertain(false);
  };
  const matches = (latest: AssignmentData, pending: PendingCorrections) => pending.corrections.every(correction => latest.segments.some(segment => segment.segmentId === correction.segmentId && segment.correctedText === correction.correctedText && (correction.status === undefined || segment.status === correction.status)));
  const verified = (latest: AssignmentData, pending: PendingCorrections) => {
    if (!matches(latest, pending)) return false;
    pendingRef.current = null; setUncertain(false); changeDrafts(new Map()); setConflicts(new Set()); setSaveMessage(msg("Corrections saved and verified.", "校正已保存并回读核验。")); return true;
  };
  const saveCorrections = async () => {
    if (!dataRef.current.canSubmit || savingRef.current || composing.current.size || conflicts.size || !draftsRef.current.size) return;
    const corrections: Correction[] = dataRef.current.segments.flatMap(segment => { const draft = draftsRef.current.get(segment.segmentId); return draft ? [{ segmentId: segment.segmentId, correctedText: draft.correctedText, ...(draft.status && { status: draft.status }) }] : []; });
    if (corrections.some(correction => correction.correctedText.length > 100000)) { setSaveMessage(msg("A correction is too long. Shorten it before saving.", "有一条校正过长，请缩短后保存。")); return; }
    const pending = pendingRef.current ?? { expectedRevision: dataRef.current.revision, idempotencyKey: randomUuid(), corrections };
    pendingRef.current = pending; savingRef.current = true; setSaving(true); setSaveMessage(null);
    try {
      await onSubmit(pending); if (!alive.current) return;
      const latest = await onRefresh(); if (!alive.current) return;
      if (!latest) { setUncertain(true); setSaveMessage(msg("The save is unconfirmed. Check the latest version or retry this same request.", "保存结果尚未确认。请核对最新版本，或重试同一请求。")); }
      else if (!verified(latest, pending)) { pendingRef.current = null; setUncertain(false); setConflicts(new Set(pending.corrections.map(value => value.segmentId))); setSaveMessage(msg("The current version differs. Compare it with your corrections before saving again.", "当前版本不同，请比较最新内容与草稿后再保存。")); }
    } catch (reason) {
      if (!alive.current) return;
      const status = record(reason) && typeof reason.status === "number" ? reason.status : 503;
      if ([401, 403, 404].includes(status)) return;
      const latest = await onRefresh(); if (!alive.current) return;
      if (latest && verified(latest, pending)) return;
      if (status === 409) { pendingRef.current = null; setUncertain(false); setConflicts(new Set(pending.corrections.map(value => value.segmentId))); setSaveMessage(msg("The assignment changed. Your draft is preserved; compare the latest correction and choose what to keep.", "任务已更新，草稿已保留。请比较最新校正并选择保留内容。")); }
      else if (status >= 500) { setUncertain(true); setSaveMessage(msg("The save is unconfirmed. Check the latest version or retry this same request.", "保存结果尚未确认。请核对最新版本，或重试同一请求。")); }
      else { pendingRef.current = null; setUncertain(false); setSaveMessage(msg("The corrections were rejected. Review your draft before retrying.", "校正被拒绝，请检查草稿后重试。")); }
    } finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const player = usePlayer(audioRef, { initialSpeed: 1, initialAutoRewindMs: 1500 });
  const segments = useMemo(() => [...data.segments].sort((a, b) => a.startMs - b.startMs || a.segmentId.localeCompare(b.segmentId)), [data.segments]);
  const selected = segments.find(segment => segment.segmentId === selectedId);
  const displayed = segments.map(segment => { const draft = drafts.get(segment.segmentId); return draft ? { ...segment, correctedText: draft.correctedText, status: draft.status ?? segment.status } : segment; });
  useEffect(() => { setSelectedId(id => segments.some(segment => segment.segmentId === id) ? id : segments[0]?.segmentId ?? null); }, [segments]);
  const { setRange, seek } = player;
  useEffect(() => { setRange(selected ? { startMs: selected.startMs, endMs: selected.endMs } : null); }, [selected?.segmentId, selected?.startMs, selected?.endMs, setRange]);
  useEffect(() => {
    if (!file) return;
    const audio = audioRef.current, url = URL.createObjectURL(file); setAudioUrl(url); setAudioError(null);
    return () => { audio?.pause(); URL.revokeObjectURL(url); };
  }, [file]);
  const locate = (id: string) => {
    const segment = segments.find(value => value.segmentId === id); if (!segment) return;
    setSelectedId(id); player.setRange({ startMs: segment.startMs, endMs: segment.endMs }); player.seek(segment.startMs);
  };
  const toggle = (id: string) => {
    const segment = segments.find(value => value.segmentId === id); if (!segment || !audioUrl) return;
    setSelectedId(id); player.toggleRange({ startMs: segment.startMs, endMs: segment.endMs });
  };
  const skip = (id: string, delta: number) => {
    const segment = segments.find(value => value.segmentId === id); if (!segment || !audioUrl) return;
    setSelectedId(id); player.setRange({ startMs: segment.startMs, endMs: segment.endMs }); player.skip(delta);
  };
  const loop = (id: string) => {
    const segment = segments.find(value => value.segmentId === id); if (!segment || !audioUrl) return;
    if (selectedId !== id) locate(id); player.loopSegment(segment.startMs, segment.endMs);
  };
  const seekAssigned = (ms: number) => {
    const segment = segments.find(value => ms >= value.startMs && ms <= value.endMs); if (!segment) return;
    setSelectedId(segment.segmentId); setRange({ startMs: segment.startMs, endMs: segment.endMs }); seek(ms);
  };
  const totalMs = Math.max(player.durationMs, ...segments.map(segment => segment.endMs), 0);
  return <div className="workbench" aria-busy={loading || saving}>
    <div className="wb-header"><span className="title">{data.assignment.title}</span><span className="hint">{msg("{0} assigned segments · revision {1} · {2}", "{0}个授权字幕段 · 版本{1} · {2}", segments.length, data.revision, data.canSubmit ? msg("correction access", "可提交校正") : msg("read-only", "只读"))}</span><span className="spacer" />{data.canSubmit && <button type="button" className="primary" disabled={saving || loading || !drafts.size || conflicts.size > 0 || composingCount > 0} onClick={() => void saveCorrections()}>{saving ? msg("Saving…", "正在保存…") : uncertain ? msg("Retry same save", "重试同一保存") : msg("Save corrections", "保存校正")}</button>}<button type="button" disabled={loading || saving} onClick={() => void onRefresh()}>{msg("Refresh assignment", "刷新任务")}</button><LanguageButton /></div>
    {drafts.size > 0 && <div className="hint" role="status" style={{ padding: "6px 14px" }}>{msg("{0} unsaved corrections. Changes are shared only after saving.", "{0}项未保存校正，保存后才会共享。", drafts.size)}</div>}
    {saveMessage && <div className="notice-warn" role="status" style={{ padding: "8px 14px" }}>{saveMessage}</div>}
    {[...conflicts].map(id => { const source = segments.find(segment => segment.segmentId === id), draft = drafts.get(id); if (!source || !draft) return null; return <div key={id} className="notice-warn" style={{ padding: "8px 14px" }}><p>{msg("Latest correction: {0}", "最新校正：{0}", source.correctedText)}</p><p>{msg("Your correction: {0}", "你的校正：{0}", draft.correctedText)}</p><button type="button" onClick={() => resolveConflict(id, false)}>{msg("Use latest correction", "采用最新校正")}</button> <button type="button" onClick={() => resolveConflict(id, true)}>{msg("Keep my correction", "保留我的校正")}</button></div>; })}
    <div className="notice-warn" style={{ padding: "8px 14px" }}>
      {msg("Assignment access does not include the source audio. Choose an MP3 you can access on this device to listen; it stays in this browser session and is not uploaded.", "任务权限不包含原始音频。可选择你在此设备有权使用的 MP3 收听；文件仅留在当前浏览器会话，不会上传。")}
      <label style={{ display: "block", marginTop: 6 }}>{msg("Local source audio", "本机源音频")} <input type="file" accept=".mp3,audio/mpeg" onChange={event => { const picked = event.target.files?.[0]; if (picked) setFile(picked); }} /></label>
    </div>
    {audioError && <div className="notice-err" role="alert" style={{ padding: "8px 14px" }}>{audioError}</div>}
    <div className="wb-main"><div className="wb-list">
      {segments.length ? <SegmentList readOnly={!data.canSubmit || saving || uncertain} allowIssueActions={false} playbackDisabled={!audioUrl} segments={displayed} selectedId={selectedId} playingSegmentId={player.playing ? selectedId : null} unresolvedBySegment={new Map()} loopSegmentId={player.loop ? selectedId : null}
        onDraftChange={(id, text) => edit(id, text)} onCompositionStart={id => { if (data.canSubmit && !saving && !uncertain) { composing.current.add(id); setComposingCount(composing.current.size); } }} onCompositionEnd={id => { composing.current.delete(id); setComposingCount(composing.current.size); }} onConfirmRow={id => stageStatus(id, "confirmed")} onUnconfirmRow={id => stageStatus(id, "editing")} onCreateIssueWithType={noChange} onLocate={locate} onEditorFocus={locate} onTogglePlay={toggle} onSkipBack={id => skip(id, -2000)} onSkipForward={id => skip(id, 2000)} onLoop={loop} /> : <div className="empty-state">{msg("This assignment has no subtitle segments.", "此任务没有字幕段。")}</div>}
    </div></div>
    <div className="player-bar"><Timeline segments={segments} durationMs={totalMs} loop={player.loop} onSeek={seekAssigned} subscribeCurrentMs={player.subscribeCurrentMs} /><div className="player-controls"><span className="hint">{msg("Assigned audio range", "授权字幕时间范围")}: {selected ? `${formatDisplay(selected.startMs)} – ${formatDisplay(selected.endMs)}` : "—"} · {formatDuration(totalMs)}</span><label>{msg("Speed", "速度")} <select value={player.speed} onChange={event => player.setSpeed(Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label></div>
      <audio ref={audioRef} src={audioUrl ?? undefined} preload="metadata" onError={() => setAudioError(msg("This audio could not be opened. Choose a browser-supported MP3 on this device.", "无法打开此音频，请在本机选择浏览器可播放的 MP3。"))} />
    </div>
  </div>;
}
