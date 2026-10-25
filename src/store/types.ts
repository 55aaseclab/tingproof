/** 数据模型（V0.1 范围：单项目/单音频，前两层文稿）。 */

export type SegmentStatus =
  | "unreviewed" // 未校对
  | "editing" // 校对中
  | "questioned" // 有疑点
  | "confirmed" // 已确认
  | "accepted_unclear"; // 接受不可辨

export const SEGMENT_STATUS_LABEL: Record<SegmentStatus, string> = {
  unreviewed: "○ 未校对",
  editing: "✎ 校对中",
  questioned: "⚑ 有疑点",
  confirmed: "✓ 已确认",
  accepted_unclear: "◐ 接受不可辨",
};

export interface SegmentRecord {
  segmentId: string;
  projectId: string;
  /** 原 cue 序号（导入记录，可能不连续）。 */
  cueNo: number | null;
  startMs: number;
  endMs: number;
  /** 原始识别层：只读。存储层与业务层都不得改写。 */
  originalText: string;
  /** 逐字校对层：可编辑。 */
  correctedText: string;
  status: SegmentStatus;
  revisionNo: number;
  updatedAt: number;
}

export type IssueStatus = "open" | "resolved";
export type IssueSeverity = "blocking" | "warning";
export type IssueType =
  | "unclear" // 听不清
  | "homophone" // 同音词
  | "proper_noun" // 专名
  | "number" // 数字
  | "segmentation" // 断句
  | "speaker" // 说话人
  | "fact" // 事实待查
  | "timeline"; // 时间轴

export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  unclear: "听不清",
  homophone: "同音词",
  proper_noun: "专名",
  number: "数字",
  segmentation: "断句",
  speaker: "说话人",
  fact: "事实待查",
  timeline: "时间轴",
};

export interface IssueRecord {
  issueId: string;
  projectId: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  type: IssueType;
  severity: IssueSeverity;
  note: string;
  status: IssueStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export interface MediaInfo {
  audioName: string;
  audioSize: number;
  audioLastModified: number;
  /**
   * 轻量音频身份指纹：文件大小 + 首/尾各 64KB 的 SHA-256。
   * 用于重定位时验证“是同一场录音”，并参与项目 ID 计算。
   * 只存 ~64 字符的哈希字符串，绝不把音频内容写入数据库。
   */
  audioFingerprint: string;
  srtFileName: string;
  srtSha256: string;
  /**
   * 源字幕文件句柄（仅 File System Access 环境；可持久化）。
   * 唯一用途：导出时用 isSameEntry 阻止用户把导出写到源 SRT 上。
   */
  srtHandle: FileSystemFileHandle | null;
  /** 源音频文件句柄（仅 File System Access 环境；可持久化，只读使用）。 */
  audioHandle: FileSystemFileHandle | null;
  mediaKey: string;
  /** 音频总时长；导入后从媒体元数据回填（受控元数据更新）。 */
  durationMs: number | null;
}

export interface PlaybackState {
  positionMs: number;
  speed: number;
  autoRewindMs: number;
  loopSegmentId: string | null;
}

export interface ProjectMeta {
  projectId: string;
  name: string;
  normalizedStem: string;
  createdAt: number;
  updatedAt: number;
  media: MediaInfo;
  playback: PlaybackState;
}

/** 原始识别层：写入一次后不可变。 */
export interface SrtSourceRecord {
  projectId: string;
  rawContent: string;
  sha256: string;
  sourceFilename: string;
  cueCount: number;
  importedAt: number;
}
