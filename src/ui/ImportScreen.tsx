import { LanguageButton } from "./LanguageButton.js";
import { msg } from "../i18n.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSrt } from "../core/srt.js";
import {
  computeAudioFingerprint,
  computeMediaKey,
  normalizeName,
  projectIdFromMediaKey,
  sha256Hex,
} from "../core/identity.js";
import { formatDisplay } from "../core/time.js";
import { getBackendKind } from "../store/backend.js";
import { migrateLegacyIndexedDbProjects } from "../store/legacyMigration.js";
import { RevisionConflictError } from "../store/remoteRepo.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  makeSegmentFromCue,
} from "../store/repo.js";
import type { ProjectMeta } from "../store/types.js";

interface Props {
  /** sessionAudioFile 仅保存在内存中传给工作台（当次会话可直接播放）；绝不写入数据库。 */
  onOpenProject: (projectId: string, sessionAudioFile: File | null) => void;
}

/** 最近项目默认最多展示条数；超出后可“加载更多”（PRD 2.3.2）。 */
const RECENT_PAGE_SIZE = 20;

function formatUpdatedAt(ts: number): string {
  return new Date(ts).toLocaleString(msg("en", "zh-CN"), { hour12: false });
}

interface PickedFile {
  file: File;
  /** FS Access 时可从同一句柄再次读取；普通 input 也兼容。 */
  readText: () => Promise<string>;
  /** FS Access 句柄：持久化后重启仍可重新定位音频。 */
  handle?: FileSystemFileHandle | null;
}

function supportsFsAccess(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

async function pickFile(accept: Record<string, string[]>, description: string): Promise<PickedFile | null> {
  if (supportsFsAccess()) {
    try {
      const handles = await (
        window as unknown as {
          showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({ multiple: false, types: [{ description, accept }] });
      const handle = handles[0];
      const file = await handle.getFile();
      return {
        file,
        readText: () => handle.getFile().then((f) => f.text()),
        handle,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = Object.values(accept).flat().join(",");
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) {
        resolve(null);
        return;
      }
      resolve({ file: f, readText: () => f.text() });
    };
    input.click();
  });
}

export function ImportScreen({ onOpenProject }: Props) {
  const [audio, setAudio] = useState<PickedFile | null>(null);
  const [srt, setSrt] = useState<PickedFile | null>(null);
  const [srtRaw, setSrtRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [listError, setListError] = useState(false);
  const pickerRequest = useRef({ audio: 0, srt: 0 });
  const srtSelection = useRef(0);
  const [recentVisibleCount, setRecentVisibleCount] = useState(RECENT_PAGE_SIZE);
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  /** 行内二次确认展开中的项目（同一时间最多一个，PRD V1.1.3 / AC-066）。 */
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  /** 删除请求进行中的项目集合：仅这些条目的按钮禁用，不阻塞其他项目。 */
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  /** 按项目记录的删除失败信息；成功即清除，条目保留可重试。 */
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  /** 同步防重复守卫：删除期间重复点击最多产生一次调用。 */
  const deleteInFlight = useRef(new Set<string>());
  /**
   * 已成功删除、但尚未被“删除之后发出的刷新”确认的项目 ID：
   * 任何更早发出的 listProjects 响应都不得复活它们（无幽灵条目）。
   * 非 tombstone——一旦某个删除之后发出的刷新返回，即从集合移除，
   * 同 projectId 后续真正重建的项目可正常重新出现。
   */
  const pendingDeletedRef = useRef<Set<string>>(new Set());
  /** 列表请求代次：只有最新代次的响应可应用，迟到的旧响应直接丢弃（防乱序覆盖）。 */
  const listGenRef = useRef(0);
  const abortRef = useRef(false);

  /**
   * 拉取项目列表（统一走请求代次 + 删除失效保护，PRD V1.1.3 / AC-066）：
   * - 应用响应时先清掉“本次请求发出前已删除”的排除项（响应必然已反映这些删除），
   *   再按剩余排除项过滤——删除之后才返回的旧响应不能复活已删除条目；
   * - clearOnFailure：初次加载失败清空并提示（既有行为）；安全刷新失败保留当前列表。
   */
  const fetchProjects = useCallback(
    (opts: { clearOnFailure: boolean }): Promise<boolean> => {
      const gen = ++listGenRef.current;
      const issuedPending = new Set(pendingDeletedRef.current);
      if (opts.clearOnFailure) { setListError(false); setProjectsLoaded(false); }
      return listProjects()
        .then((ps) => {
          if (abortRef.current || gen !== listGenRef.current) return true; // 迟到的旧代次响应：丢弃
          for (const id of issuedPending) pendingDeletedRef.current.delete(id);
          const pending = pendingDeletedRef.current;
          setProjects(pending.size > 0 ? ps.filter((p) => !pending.has(p.projectId)) : ps);
          setProjectsLoaded(true);
          setListError(false);
          return true;
        })
        .catch(() => {
          if (abortRef.current || gen !== listGenRef.current) return false;
          if (opts.clearOnFailure) {
            setProjects([]);
            setProjectsLoaded(true);
            setListError(true);
          }
          return false;
        });
    },
    [],
  );

  /** 初次/常规刷新：失败清空并提示（既有行为）。 */
  const refreshProjects = useCallback(
    () => fetchProjects({ clearOnFailure: true }),
    [fetchProjects],
  );

  /** 409 后的安全刷新：只更新列表与 revision 缓存；失败保留当前列表与目标行（不清空）。 */
  const refreshProjectsSafely = useCallback(
    () => fetchProjects({ clearOnFailure: false }),
    [fetchProjects],
  );

  useEffect(() => {
    abortRef.current = false;
    void refreshProjects();
    return () => {
      abortRef.current = true;
    };
  }, [refreshProjects]);

  // 旧 IndexedDB 项目 → 服务端幂等迁移（仅 remote 后端；失败静默可重试，本地数据永不删除）。
  useEffect(() => {
    if (getBackendKind() !== "remote") return;
    let cancelled = false;
    migrateLegacyIndexedDbProjects()
      .then((results) => {
        if (cancelled || results.length === 0) return;
        void refreshProjects();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshProjects]);

  /** 打开行内二次确认（PRD V1.1.3 / AC-066）：清掉该项目旧错误；取消不发任何请求。 */
  const openDeleteConfirm = useCallback((projectId: string) => {
    setConfirmingDeleteId(projectId);
    setDeleteErrors((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  /**
   * 确认删除（PRD V1.1.3 / AC-066）：调用既有 deleteProject 删除服务端项目业务数据
   * （项目行/SRT/segments/issues/播放进度，跨设备消失）；本机 MP3/SRT 源文件不受影响。
   * 成功后本地列表立即移除（无整页刷新）并登记失效保护（旧列表响应不得复活该条目）。
   * 409 版本冲突：绝不自动重试删除（安全边界）——只安全刷新列表/revision，目标项目
   * 仍存在则保留该行，提示用户重新点击「删除」并再次确认；刷新失败保留当前列表。
   * 删除中状态在这段处理（含冲突刷新）完成后恢复；普通失败语义不变。
   */
  const requestDelete = useCallback(
    (projectId: string) => {
      if (deleteInFlight.current.has(projectId)) return; // 防重复：最多一次调用
      deleteInFlight.current.add(projectId);
      setConfirmingDeleteId(null);
      setDeletingIds((prev) => new Set(prev).add(projectId));
      void deleteProject(projectId)
        .then(() => {
          if (abortRef.current) return;
          // 成功：登记失效保护，任何更早发出的列表响应不得复活该条目；本地立即移除，
          // 总数随之递减，删到 0 条由空状态渲染“暂无最近项目。”。
          pendingDeletedRef.current.add(projectId);
          setProjects((prev) => prev.filter((p) => p.projectId !== projectId));
        })
        .catch(async (err: unknown) => {
          if (abortRef.current) return;
          if (err instanceof RevisionConflictError) {
            // 409：不自动再次 DELETE。安全刷新（listProjects 更新 revision 缓存）后，
            // 由用户重新点击「删除」并二次确认，第二次删除携带最新 revision。
            const refreshed = await refreshProjectsSafely();
            if (abortRef.current) return;
            setDeleteErrors((prev) => ({
              ...prev,
              [projectId]: refreshed
                ? msg("Another device changed this project. Refresh and confirm deletion again.", "项目已在其他设备更新（版本冲突），未删除。请重新点击「删除」并再次确认。")
                : msg("Another device changed the project. Refresh its revision before retrying deletion.", "项目已在其他设备更新（版本冲突），未删除；暂时无法刷新版本信息，请稍后重试。"),
            }));
            return;
          }
          setDeleteErrors((prev) => ({
            ...prev,
            [projectId]: err instanceof Error ? err.message : String(err),
          }));
        })
        .finally(() => {
          deleteInFlight.current.delete(projectId);
          if (abortRef.current) return;
          setDeletingIds((prev) => {
            const next = new Set(prev);
            next.delete(projectId);
            return next;
          });
        });
    },
    [refreshProjectsSafely],
  );

  const pickAudio = async () => {
    const request = ++pickerRequest.current.audio;
    setError(null);
    try {
      const picked = await pickFile({ "audio/mpeg": [".mp3"] }, msg("MP3 audio", "MP3 音频"));
      if (picked && request === pickerRequest.current.audio) {
        setAudio(picked);
        setConfirmedMismatch(false);
      }
    } catch {
      if (request === pickerRequest.current.audio) setError(msg("Could not open that audio file. Choose a readable MP3.", "无法打开音频文件，请重新选择可读取的 MP3。"));
    }
  };

  const pickSrt = async () => {
    const request = ++pickerRequest.current.srt;
    setError(null);
    let picked;
    try {
      picked = await pickFile({ "application/x-subrip": [".srt"], "text/plain": [".srt"] }, msg("SRT subtitles", "SRT 字幕"));
    } catch {
      if (request === pickerRequest.current.srt) setError(msg("Could not open that subtitle file. Choose a readable SRT.", "无法打开字幕文件，请重新选择可读取的 SRT。"));
      return;
    }
    if (!picked || request !== pickerRequest.current.srt) return;
    const selection = ++srtSelection.current;
    setSrt(picked);
    setSrtRaw(null);
    setConfirmedMismatch(false);
    try {
      const text = await picked.readText();
      if (selection === srtSelection.current) setSrtRaw(text);
    } catch (err) {
      if (selection === srtSelection.current) {
        setError(msg("Could not read subtitles: {0}", "读取字幕失败：{0}", err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const parseResult = useMemo(() => {
    if (srtRaw === null) return null;
    return parseSrt(srtRaw);
  }, [srtRaw]);

  const pairing = useMemo(() => {
    if (!audio || !srt) return null;
    const a = normalizeName(audio.file.name);
    const s = normalizeName(srt.file.name);
    return { audioStem: a, srtStem: s, match: a === s };
  }, [audio, srt]);

  const encodingSuspect = useMemo(
    () => srtRaw !== null && srtRaw.includes("\uFFFD"),
    [srtRaw],
  );

  const canImport =
    !!audio && !!srt && !!parseResult && parseResult.errors.length === 0 &&
    (pairing?.match || confirmedMismatch) && !busy;

  const doImport = useCallback(async () => {
    if (!audio || !srt || srtRaw === null || !parseResult) return;
    setBusy(true);
    setError(null);
    try {
      // 轻量音频指纹：只读首尾各 64KB，用于项目身份与将来的重定位校验。
      const audioFingerprint = await computeAudioFingerprint(audio.file);
      const srtSha = await sha256Hex(srtRaw);
      const mediaKey = await computeMediaKey({
        audioName: audio.file.name,
        audioSize: audio.file.size,
        audioLastModified: audio.file.lastModified,
        srtName: srt.file.name,
        srtRawSha256: srtSha,
        audioFingerprint,
      });
      const projectId = projectIdFromMediaKey(mediaKey);
      const existing = await getProject(projectId);
      if (existing) {
        onOpenProject(existing.projectId, audio.file);
        return;
      }
      const stem = normalizeName(audio.file.name);
      const meta = await createProject({
        meta: {
          projectId,
          name: stem,
          normalizedStem: stem,
          media: {
            audioName: audio.file.name,
            audioSize: audio.file.size,
            audioLastModified: audio.file.lastModified,
            audioFingerprint,
            srtFileName: srt.file.name,
            srtSha256: srtSha,
            mediaKey,
            durationMs: null,
            srtHandle: srt.handle ?? null,
            audioHandle: audio.handle ?? null,
          },
          playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
        },
        srtSource: {
          rawContent: srtRaw,
          sha256: srtSha,
          sourceFilename: srt.file.name,
          cueCount: parseResult.cues.length,
        },
        segments: parseResult.cues.map((cue) => makeSegmentFromCue(projectId, cue)),
      });
      onOpenProject(meta.projectId, audio.file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [audio, srt, srtRaw, parseResult, onOpenProject]);

  return (
    <div className="import-screen">
      <div className="import-heading"><h1>{msg("TingProof", "听校 TingProof V0.1")}</h1><LanguageButton /></div>
      <div className="sub">{msg("Import an MP3 and SRT to review subtitles against the recording. Your project is saved on this service. Select the audio file on each device.", "人工听校工作台：导入一份 MP3 + SRT，边听边校；项目进度保存在当前听校服务中，源音频由本设备选择或重新定位。")}</div>

      <section className="recent-projects" aria-busy={!projectsLoaded}>
          <div className="recent-head">
            <h2>{msg("Resume proofreading", "继续上次校对")}</h2>
            {projects.length > 0 && (
              <span className="hint">{msg("Total:", "共 ")}{projects.length}{msg(" projects · most recently updated first", " 个项目 · 按更新时间倒序")}</span>
            )}
          </div>
          {!projectsLoaded ? (
            <p className="hint" role="status">{msg("Loading recent projects…", "正在读取最近项目…")}</p>
          ) : listError ? (
            <div className="notice-err" role="alert">{msg("Could not load recent projects.", "暂时无法读取最近项目。 ")}<button onClick={() => void refreshProjects()}>{msg("Retry", "重试读取")}</button>
            </div>
          ) : projects.length === 0 ? (
            <p className="hint">{msg("No recent projects.", "暂无最近项目。")}</p>
          ) : (
            <>
              <ul className="recent-list" aria-label={msg("Recent projects", "最近项目")}>
                {projects.slice(0, recentVisibleCount).map((p) => {
                  const deleting = deletingIds.has(p.projectId);
                  const confirming = confirmingDeleteId === p.projectId && !deleting;
                  return (
                    <li key={p.projectId} className="recent-item">
                      <div className="recent-info">
                        <div className="recent-name">{p.name}</div>
                        <div className="hint">{msg("Saved playback position ", "已存播放位置 ")}{formatDisplay(p.playback.positionMs)} ·{" "}{msg("Updated ", "更新于 ")}{formatUpdatedAt(p.updatedAt)}
                        </div>
                      </div>
                      <div className="recent-actions">
                        <button
                          className="primary"
                          aria-label={msg("Open {0}", "打开 {0}", p.name)}
                          disabled={deleting}
                          onClick={() => onOpenProject(p.projectId, null)}
                        >{msg("Open", "打开")}</button>
                        <button
                          className="danger"
                          aria-label={msg("Delete {0}", "删除 {0}", p.name)}
                          disabled={deleting}
                          onClick={() => openDeleteConfirm(p.projectId)}
                        >
                          {deleting ? msg("Deleting…", "删除中…") : msg("Delete", "删除")}
                        </button>
                      </div>
                      {confirming && (
                        <div className="delete-confirm">
                          <div className="hint">{msg("This permanently deletes the project's subtitles, corrections, issues and playback position. The original MP3 and SRT files stay on your device.", "将删除该项目的字幕、校对文本、疑点和播放进度，无法撤销；不会删除本机 MP3/SRT 源文件。")}</div>
                          <div className="delete-confirm-actions">
                            <button
                              className="danger"
                              aria-label={msg("Confirm deletion of {0}", "确认删除 {0}", p.name)}
                              onClick={() => requestDelete(p.projectId)}
                            >{msg("Confirm deletion", "确认删除")}</button>
                            <button
                              aria-label={msg("Cancel deletion of {0}", "取消删除 {0}", p.name)}
                              onClick={() => setConfirmingDeleteId(null)}
                            >{msg("Cancel", "取消")}</button>
                          </div>
                        </div>
                      )}
                      {deleteErrors[p.projectId] && (
                        <div className="notice-err" role="alert">{msg("✖ Could not delete: ", "✖ 删除失败：")}{deleteErrors[p.projectId]}{msg(" (you can retry)", "（项目未删除，可重试）")}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {recentVisibleCount < projects.length && (
                <button onClick={() => setRecentVisibleCount((n) => n + RECENT_PAGE_SIZE)}>{msg("Show more (", "加载更多（还有 ")}{projects.length - recentVisibleCount}{msg(" remaining)", " 个）")}</button>
              )}
            </>
          )}
      </section>

      <div className="pick-row">
        <button onClick={pickAudio}>{msg("① Choose MP3 audio", "① 选择 MP3 音频")}</button>
        <span className="fileinfo">
          {audio
            ? msg("{0} ({1} MiB)", "{0}（{1} MiB）", audio.file.name, (audio.file.size / 1024 / 1024).toFixed(1))
            : msg("No file selected", "未选择")}
        </span>
      </div>
      <div className="pick-row">
        <button onClick={pickSrt}>{msg("② Choose SRT subtitles", "② 选择 SRT 字幕")}</button>
        <span className="fileinfo">{srt ? srt.file.name : msg("No file selected", "未选择")}</span>
      </div>

      {pairing && (
        <div className="pairing">
          <table>
            <tbody>
              <tr>
                <th>{msg("Normalized audio name", "规范化音频名")}</th>
                <td>{pairing.audioStem}</td>
              </tr>
              <tr>
                <th>{msg("Normalized subtitle name", "规范化字幕名")}</th>
                <td>{pairing.srtStem}</td>
              </tr>
            </tbody>
          </table>
          {pairing.match ? (
            <div className="notice-ok">{msg("✔ The filenames match after normalization.", "✔ 规范化后名称一致（NFKC + 折叠连续空格），自动配对成立。")}</div>
          ) : (
            <div>
              <div className="notice-warn">{msg("⚠ The filenames differ. Confirm that both files belong to the same recording.", "⚠ 规范化后名称不一致，请确认两份文件属于同一场录音。")}</div>
              <label>
                <input
                  type="checkbox"
                  checked={confirmedMismatch}
                  onChange={(e) => setConfirmedMismatch(e.target.checked)}
                />{" "}{msg("These files belong to the same recording. Import them together.", "我确认这是同一场录音，仍要一起导入")}</label>
            </div>
          )}
        </div>
      )}

      {parseResult && (
        <div className="pairing">
          <div>{msg("Parsed: ", "解析结果：")}{parseResult.cues.length}{msg(" subtitle segments", " 个字幕段")}{parseResult.cues.length > 0 && (
              <>
                {msg(", ", "，")}{formatDisplay(parseResult.cues[0].startMs)} →{" "}
                {formatDisplay(parseResult.cues[parseResult.cues.length - 1].endMs)}
              </>
            )}
            {msg(" · ", "；")}{parseResult.errors.length}{msg(" errors, ", " 个错误，")}{parseResult.warnings.length}{msg(" warnings.", " 个警告。")}</div>
          {encodingSuspect && (
            <div className="notice-warn">{msg("⚠ Found U+FFFD replacement characters. Save the file as UTF-8 or UTF-8 with BOM.", "⚠ 文本中出现 U+FFFD 替换字符：文件可能不是 UTF-8（当前版本仅支持 UTF-8 / UTF-8 BOM）。")}</div>
          )}
          {parseResult.warnings.length > 0 && (
            <details>
              <summary>{msg("Show warnings", "警告明细")}</summary>
              <div className="hint" style={{ whiteSpace: "pre-wrap" }}>
                {parseResult.warnings.map((w) => msg("Line {0}: {1}", "行 {0}: {1}", w.line, w.message)).join("\n")}
              </div>
            </details>
          )}
          {parseResult.errors.length > 0 && (
            <div className="error-list">
              {parseResult.errors.map((e, i) => (
                <div key={i}>{msg("Line ", "行 ")}{e.line}: {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="notice-err" role="alert">✖ {error}</div>}

      <div>
        <button className="primary" disabled={!canImport} onClick={doImport}>
          {busy ? msg("Importing…", "导入中…") : msg("③ Import and start proofreading", "③ 导入并进入校对工作台")}
        </button>
        <span className="hint" style={{ marginLeft: 10 }}>{msg("The original SRT is kept read-only. Audio stays on this device. TingProof reads its first and last 64 KB to identify it. Matching uses the normalized filename, size, modification time, audio fingerprint and subtitle hash. Some browsers require you to locate the audio file again after a restart.", "导入会把 SRT 原文保存为只读层；音频只读取首尾 64KB 生成身份指纹（不复制、不存储音频内容）。 项目身份由“规范化文件名 + 大小 + 修改时间 + 音频指纹 + 字幕内容哈希”决定，同名不同内容不会互相覆盖。 非 Chrome 系浏览器重启后需重新定位音频文件。")}</span>
      </div>
    </div>
  );
}
