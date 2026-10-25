import { useCallback, useRef, useState } from "react";
import { resolveAudioFile } from "./core/audioSource.js";
import {
  getProject,
  getProjectIssues,
  getProjectSegments,
} from "./store/repo.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "./store/types.js";
import { ImportScreen } from "./ui/ImportScreen.js";
import { Workbench } from "./ui/Workbench.js";

interface WorkbenchState {
  type: "workbench";
  meta: ProjectMeta;
  audioFile: File | null;
  audioNotice: string | null;
  segments: SegmentRecord[];
  issues: IssueRecord[];
}

export function App() {
  const [view, setView] = useState<WorkbenchState | { type: "import" }>({ type: "import" });
  const [loadError, setLoadError] = useState<string | null>(null);
  // 会话内音频 File（内存 only，绝不写库）；刷新后消失，工作台会要求重新定位。
  const sessionAudioRef = useRef(new Map<string, File>());

  const openProject = useCallback(async (projectId: string, sessionAudio?: File | null) => {
    setLoadError(null);
    try {
      const meta = await getProject(projectId);
      if (!meta) {
        setLoadError("项目不存在或已被删除。");
        return;
      }
      if (sessionAudio) sessionAudioRef.current.set(projectId, sessionAudio);
      const [segments, issues, audio] = await Promise.all([
        getProjectSegments(projectId),
        getProjectIssues(projectId),
        resolveAudioFile(meta, sessionAudio ?? sessionAudioRef.current.get(projectId) ?? null),
      ]);
      let audioNotice: string | null = null;
      if (audio.fingerprintMismatch) {
        audioNotice =
          "找到的音频文件与项目记录的身份指纹不一致，已拒绝连接（防止把字幕配到错误录音）。请重新定位原始 MP3。";
      } else if (audio.needsRelocate) {
        audioNotice = audio.needsPermission
          ? "需要授权读取源音频（浏览器安全策略）。"
          : "本会话没有可用的源音频句柄（非 Chrome 内核浏览器或已重启）。校稿数据不会丢失；请重新定位音频文件。";
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
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (view.type === "workbench") {
    return (
      <Workbench
        key={view.meta.projectId}
        meta={view.meta}
        audioFile={view.audioFile}
        audioNotice={view.audioNotice}
        initialSegments={view.segments}
        initialIssues={view.issues}
        onBack={() => setView({ type: "import" })}
        onRelocated={(meta, file) => {
          void openProject(meta.projectId, file);
        }}
      />
    );
  }

  return (
    <div className="app">
      {loadError && (
        <div className="notice-err" style={{ padding: "8px 16px" }}>✖ {loadError}</div>
      )}
      <ImportScreen onOpenProject={(id, file) => void openProject(id, file)} />
    </div>
  );
}
