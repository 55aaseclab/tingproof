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
import {
  createProject,
  getProject,
  listProjects,
  makeSegmentFromCue,
} from "../store/repo.js";
import type { ProjectMeta } from "../store/types.js";

interface Props {
  /** sessionAudioFile 仅保存在内存中传给工作台（当次会话可直接播放）；绝不写入数据库。 */
  onOpenProject: (projectId: string, sessionAudioFile: File | null) => void;
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
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  const abortRef = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    listProjects().then((ps) => {
      if (!abortRef.current) setProjects(ps.slice(0, 3));
    });
    return () => {
      abortRef.current = true;
    };
  }, []);

  const pickAudio = async () => {
    setError(null);
    const picked = await pickFile({ "audio/mpeg": [".mp3"] }, "MP3 音频");
    if (picked) {
      setAudio(picked);
      setConfirmedMismatch(false);
    }
  };

  const pickSrt = async () => {
    setError(null);
    const picked = await pickFile(
      { "application/x-subrip": [".srt"], "text/plain": [".srt"] },
      "SRT 字幕",
    );
    if (picked) {
      setSrt(picked);
      setSrtRaw(null);
      setConfirmedMismatch(false);
      try {
        setSrtRaw(await picked.readText());
      } catch (err) {
        setError(`读取字幕失败：${err instanceof Error ? err.message : String(err)}`);
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
      <h1>听校 TingProof V0.1</h1>
      <div className="sub">
        本地优先人工听校样机：导入一份 MP3 + SRT，边听边校；源文件只读，全部数据保存在本机浏览器。
      </div>

      {projects.length > 0 && (
        <div className="resume-card">
          <div>
            <div>继续上次校对</div>
            <div className="hint">
              {projects[0].name} · 已存 {formatDisplay(projects[0].playback.positionMs)} ·
              {" "}更新于 {new Date(projects[0].updatedAt).toLocaleTimeString("zh-CN")}
            </div>
          </div>
          <button className="primary" onClick={() => onOpenProject(projects[0].projectId, null)}>
            打开
          </button>
        </div>
      )}

      <div className="pick-row">
        <button onClick={pickAudio}>① 选择 MP3 音频</button>
        <span className="fileinfo">
          {audio
            ? `${audio.file.name}（${(audio.file.size / 1024 / 1024).toFixed(1)} MiB）`
            : "未选择"}
        </span>
      </div>
      <div className="pick-row">
        <button onClick={pickSrt}>② 选择 SRT 字幕</button>
        <span className="fileinfo">{srt ? srt.file.name : "未选择"}</span>
      </div>

      {pairing && (
        <div className="pairing">
          <table>
            <tbody>
              <tr>
                <th>规范化音频名</th>
                <td>{pairing.audioStem}</td>
              </tr>
              <tr>
                <th>规范化字幕名</th>
                <td>{pairing.srtStem}</td>
              </tr>
            </tbody>
          </table>
          {pairing.match ? (
            <div className="notice-ok">✔ 规范化后名称一致（NFKC + 折叠连续空格），自动配对成立。</div>
          ) : (
            <div>
              <div className="notice-warn">⚠ 规范化后名称不一致，请确认两份文件属于同一场录音。</div>
              <label>
                <input
                  type="checkbox"
                  checked={confirmedMismatch}
                  onChange={(e) => setConfirmedMismatch(e.target.checked)}
                />{" "}
                我确认这是同一场录音，仍要一起导入
              </label>
            </div>
          )}
        </div>
      )}

      {parseResult && (
        <div className="pairing">
          <div>
            解析结果：{parseResult.cues.length} 个字幕段
            {parseResult.cues.length > 0 && (
              <>
                ，{formatDisplay(parseResult.cues[0].startMs)} →{" "}
                {formatDisplay(parseResult.cues[parseResult.cues.length - 1].endMs)}
              </>
            )}
            ；{parseResult.errors.length} 个错误，{parseResult.warnings.length} 个警告。
          </div>
          {encodingSuspect && (
            <div className="notice-warn">
              ⚠ 文本中出现 U+FFFD 替换字符：文件可能不是 UTF-8（当前版本仅支持 UTF-8 / UTF-8 BOM）。
            </div>
          )}
          {parseResult.warnings.length > 0 && (
            <details>
              <summary>警告明细</summary>
              <div className="hint" style={{ whiteSpace: "pre-wrap" }}>
                {parseResult.warnings.map((w) => `行 ${w.line}: ${w.message}`).join("\n")}
              </div>
            </details>
          )}
          {parseResult.errors.length > 0 && (
            <div className="error-list">
              {parseResult.errors.map((e, i) => (
                <div key={i}>
                  行 {e.line}: {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="notice-err">✖ {error}</div>}

      <div>
        <button className="primary" disabled={!canImport} onClick={doImport}>
          {busy ? "导入中…" : "③ 导入并进入校对工作台"}
        </button>
        <span className="hint" style={{ marginLeft: 10 }}>
          导入会把 SRT 原文保存为只读层；音频只读取首尾 64KB 生成身份指纹（不复制、不存储音频内容）。
          项目身份由“规范化文件名 + 大小 + 修改时间 + 音频指纹 + 字幕内容哈希”决定，同名不同内容不会互相覆盖。
          非 Chrome 系浏览器重启后需重新定位音频文件。
        </span>
      </div>
    </div>
  );
}
