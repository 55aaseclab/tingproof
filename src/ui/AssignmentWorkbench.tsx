import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { msg } from "../i18n.js";
import { usePlayer } from "../audio/usePlayer.js";
import { formatDisplay, formatDuration } from "../core/time.js";
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
}
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
  return { assignment: { id: target.assignmentId, spaceId: target.spaceId, title: value.assignment.title, status: "active", expiresAt }, revision: value.revision, cursor: value.cursor, segments };
}
async function readAssignment(target: Extract<AssignmentTarget, { kind: "assignment" }>, signal: AbortSignal) {
  const options = { cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error", signal } as const;
  const sessionResponse = await fetch("/auth/session", options);
  if (!sessionResponse.ok) throw unavailable(sessionResponse.status);
  const session: unknown = await sessionResponse.json();
  if (!record(session) || typeof session.csrfToken !== "string" || !session.csrfToken || !integer(session.expiresAt) || session.expiresAt <= Date.now()) throw unavailable(401);
  const response = await fetch("/api/business/invoke", { ...options, method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ appId: "tingproof", spaceId: target.spaceId, operation: "get_assignment", resourceId: target.assignmentId, input: {} }) });
  if (!response.ok) throw unavailable(response.status);
  return { data: parseAssignment(await response.json(), target), sessionExpiresAt: session.expiresAt };
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
  const active = useRef<AbortController | null>(null), generation = useRef(0);
  const scope = target.kind === "assignment" ? `${target.spaceId}:${target.assignmentId}` : "invalid";
  const refresh = useCallback(async () => {
    if (target.kind !== "assignment") return;
    const current = ++generation.current; active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setLoading(true); setError(null);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const result = await readAssignment(target, controller.signal);
      if (generation.current !== current) return;
      setData(result.data); setExpiresAt(Math.min(result.sessionExpiresAt, result.data.assignment.expiresAt ?? Infinity));
    } catch (reason) {
      if (generation.current !== current) return;
      const status = record(reason) && typeof reason.status === "number" ? reason.status : 503;
      setError(status);
      if ([401, 403, 404, 502].includes(status)) { setData(null); setExpiresAt(null); }
      if ([401, 403].includes(status)) document.dispatchEvent(new CustomEvent("praxis-navigation-state", { detail: { state: status === 401 ? "login-required" : "authorization-required" } }));
    } finally { clearTimeout(timeout); if (generation.current === current) setLoading(false); }
  }, [target]);
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
    {data ? <NativeAssignment key={scope} data={data} loading={loading} onRefresh={() => void refresh()} /> : <div className="empty-state" role="status">{loading ? msg("Loading assigned segments…", "正在读取分配的字幕段…") : error === null ? msg("No assigned material is available.", "暂无可读取的任务材料。") : ""}</div>}
  </div>;
}

function NativeAssignment({ data, loading, onRefresh }: { data: AssignmentData; loading: boolean; onRefresh: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(data.segments[0]?.segmentId ?? null), [file, setFile] = useState<File | null>(null), [audioUrl, setAudioUrl] = useState<string | null>(null), [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const player = usePlayer(audioRef, { initialSpeed: 1, initialAutoRewindMs: 1500 });
  const segments = useMemo(() => [...data.segments].sort((a, b) => a.startMs - b.startMs || a.segmentId.localeCompare(b.segmentId)), [data.segments]);
  const selected = segments.find(segment => segment.segmentId === selectedId);
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
  return <div className="workbench" aria-busy={loading}>
    <div className="wb-header"><span className="title">{data.assignment.title}</span><span className="hint">{msg("{0} assigned segments · revision {1} · read-only", "{0}个授权字幕段 · 版本{1} · 只读", segments.length, data.revision)}</span><span className="spacer" /><button type="button" disabled={loading} onClick={onRefresh}>{msg("Refresh assignment", "刷新任务")}</button><LanguageButton /></div>
    <div className="notice-warn" style={{ padding: "8px 14px" }}>
      {msg("Assignment access does not include the source audio. Choose an MP3 you can access on this device to listen; it stays in this browser session and is not uploaded.", "任务权限不包含原始音频。可选择你在此设备有权使用的 MP3 收听；文件仅留在当前浏览器会话，不会上传。")}
      <label style={{ display: "block", marginTop: 6 }}>{msg("Local source audio", "本机源音频")} <input type="file" accept=".mp3,audio/mpeg" onChange={event => { const picked = event.target.files?.[0]; if (picked) setFile(picked); }} /></label>
    </div>
    {audioError && <div className="notice-err" role="alert" style={{ padding: "8px 14px" }}>{audioError}</div>}
    <div className="wb-main"><div className="wb-list">
      {segments.length ? <SegmentList readOnly playbackDisabled={!audioUrl} segments={segments} selectedId={selectedId} playingSegmentId={player.playing ? selectedId : null} unresolvedBySegment={new Map()} loopSegmentId={player.loop ? selectedId : null}
        onDraftChange={noChange} onCompositionStart={noChange} onCompositionEnd={noChange} onConfirmRow={noChange} onUnconfirmRow={noChange} onCreateIssueWithType={noChange} onLocate={locate} onEditorFocus={locate} onTogglePlay={toggle} onSkipBack={id => skip(id, -2000)} onSkipForward={id => skip(id, 2000)} onLoop={loop} /> : <div className="empty-state">{msg("This assignment has no subtitle segments.", "此任务没有字幕段。")}</div>}
    </div></div>
    <div className="player-bar"><Timeline segments={segments} durationMs={totalMs} loop={player.loop} onSeek={seekAssigned} subscribeCurrentMs={player.subscribeCurrentMs} /><div className="player-controls"><span className="hint">{msg("Assigned audio range", "授权字幕时间范围")}: {selected ? `${formatDisplay(selected.startMs)} – ${formatDisplay(selected.endMs)}` : "—"} · {formatDuration(totalMs)}</span><label>{msg("Speed", "速度")} <select value={player.speed} onChange={event => player.setSpeed(Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label></div>
      <audio ref={audioRef} src={audioUrl ?? undefined} preload="metadata" onError={() => setAudioError(msg("This audio could not be opened. Choose a browser-supported MP3 on this device.", "无法打开此音频，请在本机选择浏览器可播放的 MP3。"))} />
    </div>
  </div>;
}
