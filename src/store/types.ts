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

/** V1.1.4 疑点来源：人工创建或机器预筛建议（旧数据/旧客户端缺省视为 human）。 */
export type IssueOrigin = "human" | "machine_prefilter";
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
  /** V1.1.4：疑点来源（服务端控制；人工写路径不可设置）。缺省视为 human。 */
  origin?: IssueOrigin;
  /** V1.1.4 机器建议元数据（provider/model/promptVersion/runId/batchId/candidateKey/confidence/可疑片段/建议写法）。 */
  machineMetadata?: Record<string, unknown> | null;
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

/**
 * ground-truth 富审计事件（PRD V1.1.1 §4.4.6，当前实现范围）：
 * - 由一次成功的服务端写入在同一事务内追加；失败/校验拒绝/409 不产生事件；
 * - before/after 是结构化 JSON 对象或 null（删除动作 before 完整、after=null）；
 * - clientId 是持久但非实名的客户端实例 ID，不代表经过认证的人；
 *   旧库迁移前的历史行在新字段上为 null（诚实表达“当时未记录”）。
 */
export interface AuditEventRecord {
  /** 单调递增事件序号（升序分页游标）。 */
  id: number;
  projectId: string;
  /** 本次写入后的项目 revision。 */
  revision: number;
  action: string;
  objectType: string;
  objectId: string;
  /** epoch 毫秒时间戳。 */
  timestamp: number;
  clientId: string | null;
  source: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** 实际发生变化字段名列表；创建/删除动作为 null。 */
  changedFields: string[] | null;
  metadata: Record<string, unknown> | null;
}

// ---------- V1.1.4 机器文本预筛（PRD §3.4.9 / AC-069~071） ----------

/** 浏览器可见的预筛配置（绝不包含 API key、Authorization 或敏感 base URL）。 */
export interface PrefilterConfigDto {
  available: boolean;
  provider: string;
  model: string;
  promptVersion: string;
}

export interface PrefilterBatchDto {
  batchId: string;
  batchNo: number;
  status: string;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdCount: number;
  reusedCount: number;
  rejectedCount: number;
  segmentCount: number;
}

export interface PrefilterRunDto {
  runId: string;
  projectId: string;
  status: string;
  provider: string;
  model: string;
  promptVersion: string;
  total: number;
  processed: number;
  created: number;
  reused: number;
  rejected: number;
  failedBatches: number;
  startedAt: number | null;
  completedAt: number | null;
  batches: PrefilterBatchDto[];
}
