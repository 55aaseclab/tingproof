import { useLanguage } from "./ui/LanguageButton.js";
import { msg } from "./i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAudioFile } from "./core/audioSource.js";
import {
  getProject,
  getProjectIssues,
  getProjectSegments,
} from "./store/repo.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "./store/types.js";
import { ImportScreen } from "./ui/ImportScreen.js";
import { Workbench } from "./ui/Workbench.js";
import { AssignmentWorkbench, assignmentTarget } from "./ui/AssignmentWorkbench.js";

interface WorkbenchState {
  type: "workbench";
  meta: ProjectMeta;
  audioFile: File | null;
  audioNotice: string | null;
  segments: SegmentRecord[];
  issues: IssueRecord[];
}

export function App() {
  useLanguage();
  const [assignment, setAssignment] = useState(() => assignmentTarget(window.location.search));
  useEffect(() => {
    const changed = () => setAssignment(assignmentTarget(window.location.search));
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const [view, setView] = useState<WorkbenchState | { type: "import" }>({ type: "import" });
  const [loadError, setLoadError] = useState<string | null>(null);
  // 会话内音频 File（内存 only，绝不写库）；刷新后消失，工作台会要求重新定位。
  const sessionAudioRef = useRef(new Map<string, File>());

  const openRequest = useRef(0);
  const openProject = useCallback(async (projectId: string, sessionAudio?: File | null) => {
    const request = ++openRequest.current;
    setLoadError(null);
    try {
      const meta = await getProject(projectId);
      if (request !== openRequest.current) return;
      if (!meta) {
        setLoadError(msg("This project is unavailable or has been deleted.", "项目不存在或已被删除。"));
        return;
      }
      if (sessionAudio) sessionAudioRef.current.set(projectId, sessionAudio);
      const [segments, issues, audio] = await Promise.all([
        getProjectSegments(projectId),
        getProjectIssues(projectId),
        resolveAudioFile(meta, sessionAudio ?? sessionAudioRef.current.get(projectId) ?? null),
      ]);
      if (request !== openRequest.current) return;
      let audioNotice: string | null = null;
      if (audio.fingerprintMismatch) {
        audioNotice =
          msg("The selected audio does not match the project fingerprint. Locate the original MP3.", "找到的音频文件与项目记录的身份指纹不一致，已拒绝连接（防止把字幕配到错误录音）。请重新定位原始 MP3。");
      } else if (audio.needsRelocate) {
        audioNotice = audio.needsPermission
          ? msg("Allow access to the source audio in your browser.", "需要授权读取源音频（浏览器安全策略）。")
          : msg("Locate the original MP3 on this device to resume playback. Your corrections are saved.", "本会话没有可用的源音频句柄（非 Chrome 内核浏览器或已重启）。校稿数据不会丢失；请重新定位音频文件。");
      }
      setView({
        type: "workbench",
        meta,
        audioFile: audio.file,
        audioNotice,
        segments,
        issues,
      });
    } catch (err) {
      if (request === openRequest.current) setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (assignment.kind !== "none") return <AssignmentWorkbench key={assignment.kind === "assignment" ? `${assignment.spaceId}:${assignment.assignmentId}` : "invalid-assignment"} target={assignment} />;

  if (view.type === "workbench") {
    return (
      <Workbench
        key={view.meta.projectId}
        meta={view.meta}
        audioFile={view.audioFile}
        audioNotice={view.audioNotice}
        initialSegments={view.segments}
        initialIssues={view.issues}
        onBack={() => { openRequest.current++; setView({ type: "import" }); }}
        onRelocated={(meta, file) => {
          void openProject(meta.projectId, file);
        }}
      />
    );
  }

  return (
    <div className="app">
      {loadError && (
        <div className="notice-err" role="alert" style={{ padding: "8px 16px" }}>✖ {loadError}</div>
      )}
      <ImportScreen onOpenProject={(id, file) => void openProject(id, file)} />
    </div>
  );
}
