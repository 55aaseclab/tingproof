/// <reference types="vite/client" />
/**
 * 仓库后端选择（PRD V1.1.0）：
 * - 生产与开发组合服务的生产事实源 = 服务端 API（remote）；
 * - IndexedDB 适配器只用于旧数据迁移来源与既有测试（绝不作为生产事实源）；
 * - 测试环境（vitest）默认 indexeddb，保持既有测试语义；可用 setBackendKind 显式切换。
 */

export type BackendKind = "remote" | "indexeddb";

export interface TingProofRepository {
  createProject: (typeof import("./idbRepo.js"))["createProject"];
  getProject: (typeof import("./idbRepo.js"))["getProject"];
  listProjects: (typeof import("./idbRepo.js"))["listProjects"];
  deleteProject: (typeof import("./idbRepo.js"))["deleteProject"];
  getProjectSegments: (typeof import("./idbRepo.js"))["getProjectSegments"];
  getProjectIssues: (typeof import("./idbRepo.js"))["getProjectIssues"];
  getSrtSource: (typeof import("./idbRepo.js"))["getSrtSource"];
  updateSegment: (typeof import("./idbRepo.js"))["updateSegment"];
  upsertIssue: (typeof import("./idbRepo.js"))["upsertIssue"];
  deleteIssue: (typeof import("./idbRepo.js"))["deleteIssue"];
  touchProject: (typeof import("./idbRepo.js"))["touchProject"];
  savePlayback: (typeof import("./idbRepo.js"))["savePlayback"];
  updateMediaDuration: (typeof import("./idbRepo.js"))["updateMediaDuration"];
  relinkAudio: (typeof import("./idbRepo.js"))["relinkAudio"];
}

let override: BackendKind | null = null;

function defaultKind(): BackendKind {
  const env = (import.meta as ImportMeta & { env?: { PROD?: boolean; MODE?: string } }).env;
  if (env?.PROD) return "remote"; // 生产：服务端 API 是唯一事实源
  if (env?.MODE === "test") return "indexeddb"; // 既有测试沿用 IndexedDB 适配器
  return "remote"; // dev：同一 Vite 组合服务提供 /api
}

export function getBackendKind(): BackendKind {
  return override ?? defaultKind();
}

/** 显式切换后端（测试/迁移工具用）；传 null 恢复默认。 */
export function setBackendKind(kind: BackendKind | null): void {
  override = kind;
}
