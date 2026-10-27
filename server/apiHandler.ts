/**
 * 服务端 API（PRD 4.4.4 服务端 API 与并发契约 / 4.4.6 ground-truth 审计契约）：
 * - GET    /api/projects                          全部项目摘要（updated_at 倒序）
 * - POST   /api/projects                          幂等创建（稳定 project_id；同 id 不同原始 SRT → 409）
 * - GET    /api/projects/:id                      项目元数据 + revision + SRT + segments + issues + playback
 * - GET    /api/projects/:id/segments|issues|srt  子资源读取
 * - GET    /api/projects/:id/audit-events         只读审计事件查询（afterId/limit 升序分页；V1.1.1）
 * - PATCH  /api/projects/:id/playback             播放位置/设置（expectedRevision）
 * - PATCH  /api/projects/:id/media                受控元数据（durationMs / relink，不含句柄与音频正文）
 * - POST   /api/projects/:id/touch                更新 updated_at（expectedRevision）
 * - PATCH  /api/segments/:segmentId               校对文本/状态/时间轴（expectedRevision；内部归属校验）
 *          兼容别名：PATCH /api/projects/:id/segments/:segmentId
 * - PUT    /api/projects/:id/issues/:issueId      疑点创建/更新（expectedRevision）
 * - DELETE /api/projects/:id/issues/:issueId      疑点删除（expectedRevision）
 *          兼容别名：DELETE /api/issues/:issueId
 * - POST   /api/projects/:id/migrate              旧 IndexedDB 项目幂等迁移（服务端已有则不覆盖）
 * - DELETE /api/projects/:id                      删除项目（expectedRevision）
 * 写入约定：ground-truth 写入缺少或不匹配 expectedRevision（或 If-Match）→ 409 + 服务端当前 revision；成功 → 事务内 revision+1。
 * 预筛 run/batch 操作性元数据是例外（§3.4.9/§4.4.4）：创建 run 不改 revision、不携带 expectedRevision。
 * 客户端来源（V1.1.1）：写入请求携带 X-TingProof-Client-Id / X-TingProof-Source 请求头，
 * 服务端严格校验长度与字符集并记入审计事件；缺失时诚实回退 unknown/api；
 * clientId 是非实名客户端实例 ID，不代表经过认证的人。审计事件只追加，无任何修改/删除 API。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { badRequest, HttpApiError, notFound, payloadTooLarge } from "./errors.ts";
import {
  envPrefilterModel,
  getPrefilterModelConfig,
  validatePrefilterResponse,
  type PrefilterModel,
  type PrefilterValidationResult,
} from "./prefilterModel.ts";
import {
  assertId,
  AUDIT_EVENTS_DEFAULT_LIMIT,
  AUDIT_EVENTS_MAX_LIMIT,
  SqliteProjectStore,
  type AuditClientContext,
  type CreateProjectPayload,
  type PrefilterRunSummary,
} from "./sqliteStore.ts";

const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export interface ApiHandlerContext {
  store: SqliteProjectStore;
  /** 测试注入的预筛模型；缺省用服务端环境配置（OpenAI-compatible）。 */
  prefilterModel?: PrefilterModel;
}

/** 客户端来源请求头（PRD V1.1.1 §4.4.6 二）。 */
const CLIENT_ID_HEADER = "x-tingproof-client-id";
const SOURCE_HEADER = "x-tingproof-source";
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const UNKNOWN_CLIENT_ID = "unknown";
const API_SOURCE = "api";

/**
 * 解析并严格校验客户端来源：非法长度/字符 → 400（不得静默落库伪造来源）；
 * 缺失 header → 诚实的 unknown/api 回退。多个同名 header 视为非法。
 */
function clientContextOf(req: IncomingMessage): AuditClientContext {
  const rawClientId = req.headers[CLIENT_ID_HEADER];
  const rawSource = req.headers[SOURCE_HEADER];
  const clientId =
    rawClientId === undefined ? null : Array.isArray(rawClientId) ? null : String(rawClientId).trim();
  const source =
    rawSource === undefined ? null : Array.isArray(rawSource) ? null : String(rawSource).trim();
  if (clientId !== null && !CLIENT_ID_PATTERN.test(clientId)) {
    throw badRequest(
      `${CLIENT_ID_HEADER} 必须是 1-80 位 [A-Za-z0-9_-] 字符串（客户端实例 ID，非实名）`,
    );
  }
  if (source !== null && !SOURCE_PATTERN.test(source)) {
    throw badRequest(`${SOURCE_HEADER} 必须是 1-32 位 [A-Za-z0-9_-] 字符串`);
  }
  return {
    clientId: clientId && clientId.length > 0 ? clientId : UNKNOWN_CLIENT_ID,
    source: source && source.length > 0 ? source : API_SOURCE,
  };
}

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(payloadTooLarge(BODY_LIMIT_BYTES));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const raw = await readBody(req);
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("请求体必须是 JSON 对象");
    }
    return parsed as Json;
  } catch (err) {
    throw badRequest(`请求体不是有效 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** expectedRevision（body）与 If-Match（header）等价处理（PRD 4.4.4 写入约定 3）。 */
function extractExpectedRevision(body: Json, req: IncomingMessage): number | undefined {
  const fromHeader = req.headers["if-match"];
  if (typeof fromHeader === "string" && fromHeader.trim().length > 0) {
    const n = Number.parseInt(fromHeader.trim().replace(/^W\//, "").replace(/"/g, ""), 10);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw badRequest(`If-Match 不是合法版本号：${fromHeader}`);
    }
    return n;
  }
  const v = body.expectedRevision;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw badRequest("expectedRevision 必须是非负整数");
  }
  return v;
}

function rejectUnknownFields(body: Json, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k) && k !== "expectedRevision");
  if (unknown.length > 0) {
    throw badRequest(`${label} 包含未知字段：${unknown.join(", ")}（未知字段不会静默落库）`);
  }
}

/**
 * P0-2（第 6 轮）：严格空对象校验——任何键（包括 expectedRevision）都 400。
 * 用于预筛操作性端点（create run / next / retry / cancel）：
 * run/batch 是操作性恢复元数据，body 只允许 {}，不接受版本化写接口的 expectedRevision。
 */
function rejectAnyFields(body: Json, label: string): void {
  const keys = Object.keys(body);
  if (keys.length > 0) {
    throw badRequest(`${label} 只接受空对象 {}（含 expectedRevision 在内的任何字段都不被接受）`);
  }
}

function validateCreatePayload(body: Json): CreateProjectPayload {
  rejectUnknownFields(body, ["meta", "srtSource", "segments", "issues"], "项目创建载荷");
  const meta = body.meta as Json | undefined;
  const srtSource = body.srtSource as Json | undefined;
  if (typeof meta !== "object" || meta === null) throw badRequest("meta 缺失");
  if (typeof srtSource !== "object" || srtSource === null) throw badRequest("srtSource 缺失");
  rejectUnknownFields(meta, ["projectId", "name", "normalizedStem", "media", "playback"], "meta");
  rejectUnknownFields(
    srtSource,
    ["rawContent", "sha256", "sourceFilename", "cueCount"],
    "srtSource",
  );
  const projectId = assertId(meta.projectId, "meta.projectId");
  const name = meta.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 80) {
    throw badRequest("meta.name 必须是 1-80 字符");
  }
  const normalizedStem = meta.normalizedStem;
  if (typeof normalizedStem !== "string" || normalizedStem.length === 0) {
    throw badRequest("meta.normalizedStem 缺失");
  }
  if (typeof meta.media !== "object" || meta.media === null) throw badRequest("meta.media 缺失");
  if (
    meta.playback !== undefined &&
    (typeof meta.playback !== "object" || meta.playback === null)
  ) {
    throw badRequest("meta.playback 必须是对象");
  }
  const rawContent = srtSource.rawContent;
  if (typeof rawContent !== "string" || rawContent.length === 0) throw badRequest("srtSource.rawContent 缺失");
  if (typeof srtSource.sha256 !== "string" || srtSource.sha256.length === 0) throw badRequest("srtSource.sha256 缺失");
  if (typeof srtSource.sourceFilename !== "string") throw badRequest("srtSource.sourceFilename 缺失");
  if (typeof srtSource.cueCount !== "number" || !Number.isSafeInteger(srtSource.cueCount)) {
    throw badRequest("srtSource.cueCount 必须是整数");
  }
  if (!Array.isArray(body.segments)) throw badRequest("segments 必须是数组");
  const issues = body.issues;
  if (issues !== undefined && !Array.isArray(issues)) throw badRequest("issues 必须是数组");
  return {
    meta: {
      projectId,
      name,
      normalizedStem,
      // 服务端白名单化 media：句柄与音频正文永不落库（PRD 数据边界）。
      media: meta.media as Record<string, unknown>,
      playback: meta.playback as Record<string, unknown> | undefined,
    },
    srtSource: {
      rawContent,
      sha256: srtSource.sha256 as string,
      sourceFilename: srtSource.sourceFilename as string,
      cueCount: srtSource.cueCount as number,
    },
    segments: body.segments as CreateProjectPayload["segments"],
    issues: (issues ?? []) as CreateProjectPayload["issues"],
  };
}

/** connect 风格中间件：处理 /api/*，否则放行 next()（静态资源/Vite 接管）。 */
export function createApiMiddleware(ctx: ApiHandlerContext) {
  const { store } = ctx;
  return async function apiMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://tingproof.local");
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      next();
      return;
    }
    try {
      await route(req, res, url.pathname, url.searchParams, store, ctx.prefilterModel);
    } catch (err) {
      if (err instanceof HttpApiError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
        return;
      }
      if (err instanceof TypeError) {
        sendJson(res, 400, { error: "bad_request", message: err.message });
        return;
      }
      sendJson(res, 500, {
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  store: SqliteProjectStore,
  injectedModel: PrefilterModel | undefined,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  const client = clientContextOf(req);

  // ---- /api/text-prefilter/config（V1.1.4：只暴露 available/provider/model/promptVersion） ----
  if (parts[1] === "text-prefilter" && parts.length === 3 && parts[2] === "config") {
    if (method !== "GET") throw badRequest(`不支持的方法：${method} /api/text-prefilter/config`);
    const model = injectedModel ?? envPrefilterModel();
    if (model) {
      sendJson(res, 200, {
        available: true,
        provider: model.provider,
        model: model.model,
        promptVersion: model.promptVersion,
      });
    } else {
      sendJson(res, 200, getPrefilterModelConfig());
    }
    return;
  }

  // ---- /api/projects ----
  if (parts[1] === "projects" && parts.length === 2) {
    if (method === "GET") {
      sendJson(res, 200, { projects: store.listProjectSummaries() });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      const payload = validateCreatePayload(body);
      const result = store.createProject(payload, client);
      sendJson(res, result.created ? 201 : 200, result);
      return;
    }
    throw badRequest(`不支持的方法：${method} /api/projects`);
  }

  if (parts[1] === "projects" && parts.length >= 3) {
    const projectId = assertId(parts[2], "projectId");

    if (parts.length === 3) {
      if (method === "GET") {
        sendJson(res, 200, store.getProjectDetail(projectId));
        return;
      }
      if (method === "DELETE") {
        const body = await readJsonBody(req).catch(() => ({}) as Json);
        const expected =
          extractExpectedRevision(body, req) ??
          parseRevisionParam(query.get("expectedRevision"));
        const result = store.deleteProject(projectId, expected, client);
        sendJson(res, 200, result);
        return;
      }
      throw badRequest(`不支持的方法：${method} /api/projects/:id`);
    }

    if (parts.length === 4) {
      const sub = parts[3];
      if (sub === "segments" && method === "PATCH") {
        // 兼容别名：/api/projects/:id/segments/:segmentId —— 但这里缺 segmentId，应为 5 段。
        throw notFound("缺少 segmentId");
      }
      // 只读审计查询（V1.1.1 §4.4.6）：不提供任何修改/删除审计事件的 API。
      if (sub === "audit-events") {
        if (method !== "GET") {
          throw badRequest(`审计事件为只读资源，不支持方法：${method} /api/projects/:id/audit-events`);
        }
        const afterId = parseNonNegativeIntParam(query.get("afterId"), "afterId", 0);
        const limit = parseNonNegativeIntParam(query.get("limit"), "limit", AUDIT_EVENTS_DEFAULT_LIMIT);
        if (limit < 1 || limit > AUDIT_EVENTS_MAX_LIMIT) {
          throw badRequest(`limit 必须在 1-${AUDIT_EVENTS_MAX_LIMIT} 之间（当前值：${limit}）`);
        }
        sendJson(res, 200, store.listAuditEvents(projectId, afterId, limit));
        return;
      }
      const body = await readJsonBody(req);
      const expected = extractExpectedRevision(body, req);
      if (sub === "playback" && method === "PATCH") {
        rejectUnknownFields(body, ["playback"], "playback 载荷");
        if (typeof body.playback !== "object" || body.playback === null) {
          throw badRequest("playback 缺失");
        }
        const result = store.updatePlayback(projectId, body.playback, expected, client);
        sendJson(res, 200, result);
        return;
      }
      if (sub === "media" && method === "PATCH") {
        rejectUnknownFields(body, ["durationMs", "relink"], "media 载荷");
        const result = store.updateMedia(
          projectId,
          { durationMs: body.durationMs, relink: body.relink },
          expected,
          client,
        );
        sendJson(res, 200, result);
        return;
      }
      if (sub === "touch" && method === "POST") {
        const result = store.touchProject(projectId, expected, client);
        sendJson(res, 200, result);
        return;
      }
      if (sub === "migrate" && method === "POST") {
        const payload = validateCreatePayload(body);
        if (payload.meta.projectId !== projectId) {
          throw badRequest("meta.projectId 与路径 projectId 不一致");
        }
        const result = store.migrateProject(payload, client);
        sendJson(res, result.created ? 201 : 200, result);
        return;
      }
      if (sub === "segments" && method === "GET") {
        sendJson(res, 200, {
          segments: store.listSegments(projectId),
          revision: store.currentRevision(projectId),
        });
        return;
      }
      if (sub === "issues" && method === "GET") {
        sendJson(res, 200, {
          issues: store.listIssues(projectId),
          revision: store.currentRevision(projectId),
        });
        return;
      }
      if (sub === "srt" && method === "GET") {
        sendJson(res, 200, { srtSource: store.getSrtSource(projectId) });
        return;
      }
      // ---- V1.1.4 文本预筛 run（PRD §4.4.4）----
      // P0-3：GET 最近 run（只读发现；无 run 返回 null，不创建、不触发模型）。
      if (sub === "text-prefilter-runs" && method === "GET") {
        sendJson(res, 200, { run: store.getLatestPrefilterRun(projectId) });
        return;
      }
      if (sub === "text-prefilter-runs" && method === "POST") {
        // body 已由本块顶部统一读取（重复读取已消费流会挂起）。
        rejectAnyFields(body, "预筛 run 创建载荷");
        const model = injectedModel ?? envPrefilterModel();
        if (!model) {
          throw new HttpApiError(
            503,
            "prefilter_unavailable",
            "机器预筛未配置：请在服务端环境设置 TINGPROOF_LLM_BASE_URL 与 TINGPROOF_LLM_MODEL（API key 只从环境变量 TINGPROOF_LLM_API_KEY 读取，不会返回给浏览器）。",
          );
        }
        const { run, created } = store.createPrefilterRun(projectId, {
          provider: model.provider,
          model: model.model,
          promptVersion: model.promptVersion,
        });
        sendJson(res, created ? 201 : 200, { run, created });
        return;
      }
      throw notFound(`未知子资源：${sub}`);
    }

    // /api/projects/:id/segments/:segmentId（PRD 规范路由）
    if (parts.length === 5 && parts[3] === "segments" && method === "PATCH") {
      const segmentId = assertId(parts[4], "segmentId");
      const body = await readJsonBody(req);
      const expected = extractExpectedRevision(body, req);
      rejectUnknownFields(body, ["patch"], "segment 载荷");
      if (typeof body.patch !== "object" || body.patch === null) throw badRequest("patch 缺失");
      const result = store.updateSegment(projectId, segmentId, body.patch as Json, expected, client);
      sendJson(res, 200, result);
      return;
    }

    // /api/projects/:id/segments/:segmentId/confirm（V1.1.4 原子确认，PRD §4.4.4）
    if (parts.length === 5 && parts[3] === "segments" && parts[4] === "confirm" && method === "POST") {
      throw notFound("缺少 segmentId（confirm 需为 /segments/:segmentId/confirm）");
    }
    if (parts.length === 6 && parts[3] === "segments" && parts[5] === "confirm" && method === "POST") {
      const segmentId = assertId(parts[4], "segmentId");
      const body = await readJsonBody(req);
      const expected = extractExpectedRevision(body, req);
      rejectUnknownFields(body, ["correctedText"], "confirm 载荷");
      const result = store.confirmSegmentAndResolve(
        projectId,
        segmentId,
        { correctedText: body.correctedText },
        expected,
        client,
      );
      sendJson(res, 200, result);
      return;
    }

    // /api/projects/:id/issues/:issueId（PUT/DELETE，PRD 规范路由）
    if (parts.length === 5 && parts[3] === "issues") {
      const issueId = assertId(parts[4], "issueId");
      if (method === "PUT") {
        const body = await readJsonBody(req);
        const expected = extractExpectedRevision(body, req);
        rejectUnknownFields(body, ["issue"], "issue 载荷");
        if (typeof body.issue !== "object" || body.issue === null) throw badRequest("issue 缺失");
        const result = store.putIssue(projectId, issueId, body.issue as Json, expected, client);
        sendJson(res, 200, result);
        return;
      }
      if (method === "DELETE") {
        const body = await readJsonBody(req).catch(() => ({}) as Json);
        const expected =
          extractExpectedRevision(body, req) ??
          parseRevisionParam(query.get("expectedRevision"));
        const result = store.deleteIssue(projectId, issueId, expected, client);
        sendJson(res, 200, result);
        return;
      }
      throw badRequest(`不支持的方法：${method} /api/projects/:id/issues/:issueId`);
    }

    // /api/projects/:id/text-prefilter-runs/:runId（V1.1.4：进度/恢复查询）
    if (parts.length === 5 && parts[3] === "text-prefilter-runs") {
      const runId = assertId(parts[4], "runId");
      if (method === "GET") {
        sendJson(res, 200, { run: store.getPrefilterRun(projectId, runId) });
        return;
      }
      throw badRequest(`不支持的方法：${method} /api/projects/:id/text-prefilter-runs/:runId`);
    }

    // /api/projects/:id/text-prefilter-runs/:runId/next|retry|cancel（V1.1.4）
    if (parts.length === 6 && parts[3] === "text-prefilter-runs") {
      const runId = assertId(parts[4], "runId");
      const action = parts[5];
      if (action === "next" || action === "retry") {
        if (method !== "POST") {
          throw badRequest(`不支持的方法：${method} /api/projects/:id/text-prefilter-runs/:runId/${action}`);
        }
        // P1-4（第 5 轮）：读取并校验请求体（只接受空对象；未知字段 400、超限 413）。
        // 在校验通过前不得 claim、调模型或改变 run。
        const actionBody = await readJsonBody(req);
        rejectAnyFields(actionBody, `预筛 ${action} 载荷`);
        const model = injectedModel ?? envPrefilterModel();
        if (!model) {
          throw new HttpApiError(
            503,
            "prefilter_unavailable",
            "机器预筛未配置：请在服务端环境设置 TINGPROOF_LLM_BASE_URL 与 TINGPROOF_LLM_MODEL。",
          );
        }
        const result = await processPrefilterBatch(store, model, projectId, runId, action, client);
        sendJson(res, 200, result);
        return;
      }
      if (action === "cancel") {
        if (method !== "POST") {
          throw badRequest(`不支持的方法：${method} /api/projects/:id/text-prefilter-runs/:runId/cancel`);
        }
        // P1-4（第 5 轮）：读取并校验请求体（只接受空对象）。
        const cancelBody = await readJsonBody(req);
        rejectAnyFields(cancelBody, "预筛 cancel 载荷");
        sendJson(res, 200, { run: store.cancelPrefilterRun(projectId, runId) });
        return;
      }
      throw notFound(`未知预筛动作：${action}`);
    }

    throw notFound("未知 API 路径");
  }

  // ---- /api/segments/:segmentId（兼容路由：内部解析归属） ----
  if (parts[1] === "segments" && parts.length === 3 && method === "PATCH") {
    const segmentId = assertId(parts[2], "segmentId");
    const body = await readJsonBody(req);
    const expected = extractExpectedRevision(body, req);
    rejectUnknownFields(body, ["patch", "projectId"], "segment 载荷");
    if (typeof body.patch !== "object" || body.patch === null) throw badRequest("patch 缺失");
    const projectId =
      typeof body.projectId === "string" && body.projectId.length > 0
        ? assertId(body.projectId, "projectId")
        : store.resolveProjectIdForSegment(segmentId);
    const result = store.updateSegment(projectId, segmentId, body.patch as Json, expected, client);
    sendJson(res, 200, result);
    return;
  }

  // ---- /api/issues/:issueId（兼容路由：内部解析归属） ----
  if (parts[1] === "issues" && parts.length === 3 && method === "DELETE") {
    const issueId = assertId(parts[2], "issueId");
    const body = await readJsonBody(req).catch(() => ({}) as Json);
    const expected =
      extractExpectedRevision(body, req) ?? parseRevisionParam(query.get("expectedRevision"));
    const projectId =
      typeof body.projectId === "string" && body.projectId.length > 0
        ? assertId(body.projectId, "projectId")
        : store.resolveProjectIdForIssue(issueId);
    if (!projectId) throw notFound(`疑点不存在：${issueId}`);
    const result = store.deleteIssue(projectId, issueId, expected, client);
    sendJson(res, 200, result);
    return;
  }

  throw notFound(`未知 API 路径：${pathname}`);
}

/**
 * P1-3 错误脱敏：截断长度、移除 URL/凭据/Authorization/API key 等敏感模式。
 * 模型适配器已尽量脱敏；这里是纵深防御——任何 Error.message 入库/回传前都经过此处。
 */
function sanitizePrefilterError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let message = raw.slice(0, 500);
  // 移除常见敏感模式：完整/部分 URL、Bearer token、长随机 key。
  message = message.replace(/https?:\/\/[^\s"']+/g, "[URL已脱敏]");
  message = message.replace(/[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [已脱敏]");
  message = message.replace(/sk-[A-Za-z0-9]{16,}/g, "sk-[已脱敏]");
  return message;
}

/**
 * V1.1.4 预筛批处理（PRD §4.4.4 写入约定 8）：
 * 1. 短事务原子 claim（并发第二请求不调用模型）；2. inputHash 幂等复用（不调用模型）；
 * 3. 模型调用不持有数据库事务；4. 返回后严格校验，再以短事务 materialize；
 * 5. 模型/校验失败 → 批次 failed（脱敏错误），不产生 issue/revision/审计污染，可重试。
 */
async function processPrefilterBatch(
  store: SqliteProjectStore,
  model: PrefilterModel,
  projectId: string,
  runId: string,
  mode: "next" | "retry",
  client: AuditClientContext,
): Promise<{
  run: PrefilterRunSummary;
  processed: boolean;
  error: { code: string; message: string } | null;
  revision: number;
}> {
  // P0-6：run 冻结的 provider/model/promptVersion 不可漂移——
  // 服务重启或配置变更后，旧 run 不得用新模型继续处理（破坏可复现/幂等/审计）。
  // 处理前比较当前 adapter 与 run 冻结值；任一不一致 → 不 claim、不调模型、零副作用，
  // 返回明确的配置不匹配状态（用户显式以当前配置新建 run）。
  const runBefore = store.getPrefilterRun(projectId, runId);
  const configMismatch =
    runBefore.provider !== model.provider ||
    runBefore.model !== model.model ||
    runBefore.promptVersion !== model.promptVersion;
  if (configMismatch) {
    return {
      run: runBefore,
      processed: false,
      error: {
        code: "config_mismatch",
        message:
          `预筛 run 创建时的模型配置（${runBefore.provider}/${runBefore.model}/${runBefore.promptVersion}）` +
          `与当前配置（${model.provider}/${model.model}/${model.promptVersion}）不一致。` +
          "为保持可复现与幂等，该 run 不会继续处理；请用当前配置开始新的预筛。",
      },
      revision: store.currentRevision(projectId),
    };
  }
  const claimed = store.claimPrefilterBatch(projectId, runId, mode);
  const modelInputs = claimed
    ? claimed.inputs.map((i) => ({ segmentId: i.segmentId, cueNo: i.cueNo, originalText: i.originalText }))
    : [];
  if (!claimed) {
    // 无可认领批次（全部成功/取消，或首个未完成批正被其他调用持有且未超租约）。
    return {
      run: store.getPrefilterRun(projectId, runId),
      processed: false,
      error: null,
      revision: store.currentRevision(projectId),
    };
  }
  // P1-3：模型/校验/复制/落库的可恢复失败统一收尾为 batch failed（结束 claim），
  // 绝不让批次滞留 running 等租约超时；错误一律经 sanitizePrefilterError 脱敏。
  const failBatch = (errorCode: string, err: unknown) => {
    const message = sanitizePrefilterError(err);
    store.markPrefilterBatchFailed(claimed.batchId, errorCode, message);
    return {
      run: store.getPrefilterRun(projectId, runId),
      processed: true,
      error: { code: errorCode, message },
      revision: store.currentRevision(projectId),
    };
  };
  // inputHash 幂等：同项目已有成功批次 → 直接复制结果，不再次调用模型、不重复收费。
  const reusable = store.findReusableBatch(projectId, claimed.inputHash, claimed.batchId);
  if (reusable) {
    try {
      store.copyBatchResults(claimed.batchId, reusable);
    } catch (err) {
      return failBatch("copy_error", err);
    }
    return {
      run: store.getPrefilterRun(projectId, runId),
      processed: true,
      error: null,
      revision: store.currentRevision(projectId),
    };
  }
  // 模型调用（不持有数据库写事务）。
  let response: unknown;
  try {
    response = await model.complete(modelInputs);
  } catch (err) {
    return failBatch("model_error", err);
  }
  let validated: PrefilterValidationResult;
  try {
    validated = validatePrefilterResponse(response, modelInputs);
  } catch (err) {
    return failBatch("invalid_response", err);
  }
  try {
    const result = store.materializePrefilterBatch(
      claimed.batchId,
      validated.valid,
      { provider: model.provider, model: model.model, promptVersion: model.promptVersion, runId },
      client,
      validated.rejected,
    );
    return {
      run: store.getPrefilterRun(projectId, runId),
      processed: true,
      error: null,
      revision: result.revision,
    };
  } catch (err) {
    // materialize 失败（如项目被并发删除）：批次收尾为 failed，claim 不滞留。
    return failBatch("materialize_error", err);
  }
}

function parseRevisionParam(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n < 0) throw badRequest(`expectedRevision 不合法：${value}`);
  return n;
}

/** 分页参数严格校验：缺失用默认值；存在时必须是十进制非负整数（不接受小数/前缀解析）。 */
function parseNonNegativeIntParam(value: string | null, name: string, fallback: number): number {
  if (value === null || value.trim().length === 0) return fallback;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} 必须是非负整数（当前值：${raw}）`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 0) throw badRequest(`${name} 必须是非负整数（当前值：${raw}）`);
  return n;
}
