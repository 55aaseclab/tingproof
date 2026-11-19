/**
 * V1.1.4 机器文本可疑点预筛——模型适配器与候选严格校验（PRD §3.4.9 / AC-069、AC-071）。
 *
 * 安全边界：
 * - 适配器只运行在服务端；输入只含冻结的 segmentId/cueNo/originalText，
 *   绝不发送音频、播放片段、correctedText 或文件路径；
 * - API key 只从服务端环境变量读取，绝不入库、回传浏览器或进入日志/审计；
 * - 模型响应必须是通过白名单校验的结构化 JSON；非法输出一律拒绝，不猜着落库；
 * - 未配置模型时 available=false，人工链路完全不受影响。
 */
import { createHash } from "node:crypto";

/** 提示词版本（PRD §3.4.9：任何提示词文字/字段/映射变化都必须提升此版本）。 */
export const PROMPT_VERSION = "text-suspicion-v1";

/**
 * 版本化系统提示词：语义骨架（PRD §3.4.9）+ 与 validatePrefilterResponse 完全一致的
 * 精确输出契约（顶层仅 items、六个字段、枚举与长度、单段上限、纯 JSON 无 Markdown），
 * 避免真实模型因结构歧义整批失败；始终明确只基于原始文本、没有听音频。
 */
export const PREFILTER_SYSTEM_PROMPT = `你是语音转写质检助手。下面是 ASR 机器转写的若干连续字幕段。只基于文本通顺度和常识找可能转错的地方，不要假装听过音频。重点检查：1）语义不通、疑似同音错词；2）数字、日期、时间读着别扭；3）疑似人名、地名、机构、品牌或其他专有名词；4）明显断句或标点问题。只返回可疑项，通顺的不要动；建议写法只是待人工听核的候选，不能当成事实。

输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要 Markdown 代码块、注释或任何其他文字；
- 顶层只有一个字段 items（数组）；没有可疑项时输出 {"items":[]}；
- 每个元素必须且只能包含字段：segmentId、suspiciousText、type、suggestion、confidence、reason；
- segmentId 必须原样取自输入的 segments 列表，不得新造；
- suspiciousText：1-200 字，必须是对应段 originalText 的逐字子串；
- type 只允许：homophone、number、proper_noun、segmentation、fact；
- suggestion：0-200 字，可以为空字符串（表示只标记问题、无法猜写法）；
- confidence 只允许：high、medium、low；
- reason：1-500 字，说明文本依据，不得声称“听到”或引用未提供的信息；
- 每个段最多返回 3 条候选，完全重复的候选只返回一次。`;

/** 单批输入段（冻结清单条目；不含 correctedText 与任何音频信息）。 */
export interface PrefilterModelInput {
  segmentId: string;
  cueNo: number | null;
  originalText: string;
}

/** 适配器统一接口：测试注入假模型，生产用 OpenAI-compatible 环境配置。 */
export interface PrefilterModel {
  provider: string;
  model: string;
  promptVersion: string;
  /** 返回模型原始响应（未校验的 unknown）；调用方负责严格校验。 */
  complete(inputs: PrefilterModelInput[]): Promise<unknown>;
}

/** 服务端环境配置键（浏览器不得接触；config 接口只回 available/provider/model/promptVersion）。 */
export const ENV_LLM_BASE_URL = "TINGPROOF_LLM_BASE_URL";
export const ENV_LLM_MODEL = "TINGPROOF_LLM_MODEL";
export const ENV_LLM_API_KEY = "TINGPROOF_LLM_API_KEY";

export interface PrefilterModelConfig {
  available: boolean;
  provider: string;
  model: string;
  promptVersion: string;
}

/** 只暴露非敏感配置；绝不返回 base URL、Authorization 或 API key。 */
export function getPrefilterModelConfig(): PrefilterModelConfig {
  const baseUrl = process.env[ENV_LLM_BASE_URL]?.trim() ?? "";
  const model = process.env[ENV_LLM_MODEL]?.trim() ?? "";
  return {
    available: baseUrl.length > 0 && model.length > 0,
    provider: "openai-compatible",
    model: model || "(未配置)",
    promptVersion: PROMPT_VERSION,
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** 有上限的指数退避（PRD：超时/429/5xx/网络错误；达到上限后交给调用方标记 failed）。 */
const RETRY_DELAYS_MS = [500, 1500];

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生产适配器：OpenAI-compatible chat completions（${base}/chat/completions）。
 * - 请求 response_format=json_object + temperature=0，系统提示词为 PROMPT_VERSION 固定版本；
 * - Authorization 只在 key 非空时携带；错误信息脱敏（不含 URL 凭据、请求头或响应正文）；
 * - 超时（AbortSignal）与 429/5xx/网络错误按 RETRY_DELAYS_MS 退避重试。
 */
export function envPrefilterModel(): PrefilterModel | null {
  const baseUrl = process.env[ENV_LLM_BASE_URL]?.trim() ?? "";
  const model = process.env[ENV_LLM_MODEL]?.trim() ?? "";
  if (baseUrl.length === 0 || model.length === 0) return null;
  const apiKey = process.env[ENV_LLM_API_KEY]?.trim() ?? "";
  return {
    provider: "openai-compatible",
    model,
    promptVersion: PROMPT_VERSION,
    async complete(inputs) {
      const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      let lastError = "模型请求失败";
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: PREFILTER_SYSTEM_PROMPT },
                {
                  role: "user",
                  content: JSON.stringify({
                    segments: inputs.map((s) => ({
                      segmentId: s.segmentId,
                      cueNo: s.cueNo,
                      originalText: s.originalText,
                    })),
                  }),
                },
              ],
            }),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          });
          if (isRetryableStatus(res.status)) {
            lastError = `模型服务暂时不可用（HTTP ${res.status}）`;
            continue;
          }
          if (!res.ok) {
            throw new Error(`模型服务返回 HTTP ${res.status}`);
          }
          const body = (await res.json()) as {
            choices?: Array<{ message?: { content?: unknown } }>;
          };
          const content = body.choices?.[0]?.message?.content;
          if (typeof content !== "string" || content.length === 0) {
            throw new Error("模型响应缺少 choices[0].message.content");
          }
          return JSON.parse(content) as unknown;
        } catch (err) {
          // Node 的 AbortSignal.timeout 超时抛 TimeoutError；手动 abort 抛 AbortError——都进入退避重试。
          if (
            err instanceof Error &&
            (err.name === "AbortError" || err.name === "TimeoutError")
          ) {
            lastError = `模型请求超时（上限 ${DEFAULT_TIMEOUT_MS}ms）`;
            continue;
          }
          if (err instanceof SyntaxError) {
            throw new Error("模型响应不是有效 JSON");
          }
          lastError = err instanceof Error ? err.message : String(err);
          // 网络类错误（fetch 抛出）进入退避重试；其余（如 4xx 响应）直接失败。
          if (err instanceof TypeError) continue;
          throw err instanceof Error ? err : new Error(lastError);
        }
      }
      throw new Error(lastError);
    },
  };
}

// ---------- 候选严格校验（AC-069） ----------

/** 模型允许返回的类型（映射现有疑点类型；不得返回 unclear/speaker/timeline）。 */
export const PREFILTER_ALLOWED_TYPES = ["homophone", "number", "proper_noun", "segmentation", "fact"] as const;
export type PrefilterCandidateType = (typeof PREFILTER_ALLOWED_TYPES)[number];
export const PREFILTER_ALLOWED_CONFIDENCE = ["high", "medium", "low"] as const;
export type PrefilterConfidence = (typeof PREFILTER_ALLOWED_CONFIDENCE)[number];

/** 单段最多接受的候选数（超出拒绝并计数）。 */
export const MAX_CANDIDATES_PER_SEGMENT = 3;

/** 通过全部白名单校验的结构化候选。 */
export interface ValidPrefilterCandidate {
  segmentId: string;
  suspiciousText: string;
  type: PrefilterCandidateType;
  suggestion: string;
  confidence: PrefilterConfidence;
  reason: string;
  sourceTextHash: string;
}

/** 可安全结构化的被拒候选（PRD 数据字典 disposition=rejected；issueId 必须为空）。 */
export interface RejectedPrefilterCandidate {
  segmentId: string;
  suspiciousText: string;
  type: string;
  suggestion: string;
  confidence: string;
  reason: string;
  sourceTextHash: string;
  why: string;
}

export interface PrefilterValidationResult {
  valid: ValidPrefilterCandidate[];
  rejected: RejectedPrefilterCandidate[];
  rejectedCount: number;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function boundedString(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

/**
 * 严格校验模型响应（PRD §3.4.9 字段约束表）：
 * - 顶层必须是只含 items 的 { items: [...] }（未知顶层字段 → 整批拒绝）；
 * - 字段类型/取值范围逐一白名单校验；segmentId 必须属于本批输入；
 *   suspiciousText 必须是该段 originalText 的逐字子串；
 * - 同一批内完全重复的候选（candidateKey 相同）按重复拒绝并计数，绝不撞唯一约束；
 * - 未知字段、非法类型、超长输出、单段候选超限 → 拒绝对应候选并计数，绝不猜着落库；
 * - 整体无法解析时抛错（调用方将该批标记 failed，可重试）。
 */
export function validatePrefilterResponse(
  response: unknown,
  inputs: PrefilterModelInput[],
): PrefilterValidationResult {
  if (!isPlainObject(response) || !Array.isArray(response.items)) {
    throw new Error("模型响应必须是包含 items 数组的 JSON 对象");
  }
  const unknownTop = Object.keys(response).filter((k) => k !== "items");
  if (unknownTop.length > 0) {
    throw new Error(`模型响应包含未知顶层字段：${unknownTop.join(", ")}`);
  }
  const bySegment = new Map(inputs.map((i) => [i.segmentId, i]));
  const perSegmentCount = new Map<string, number>();
  const seenCandidateKeys = new Set<string>();
  const valid: ValidPrefilterCandidate[] = [];
  const rejected: RejectedPrefilterCandidate[] = [];
  const errors: string[] = [];
  let rejectedCount = 0;
  /** 把被拒候选拍成可安全持久化的形状（字段截断；未知段记空哈希）。 */
  const toRejected = (raw: Record<string, unknown>, why: string): RejectedPrefilterCandidate => {
    const str = (v: unknown, max: number): string =>
      typeof v === "string" ? v.trim().slice(0, max) : "";
    const segmentId = str(raw.segmentId, 80);
    return {
      segmentId,
      suspiciousText: str(raw.suspiciousText, 200),
      type: str(raw.type, 32),
      suggestion: str(raw.suggestion, 200),
      confidence: str(raw.confidence, 16),
      reason: str(raw.reason, 500),
      sourceTextHash: bySegment.get(segmentId)
        ? sha256Hex(bySegment.get(segmentId)!.originalText)
        : "",
      why,
    };
  };

  const items = response.items as unknown[];
  if (items.length > 500) {
    throw new Error(`模型响应候选数超限（${items.length} > 500）`);
  }
  for (const [index, raw] of items.entries()) {
    if (!isPlainObject(raw)) {
      rejectedCount += 1;
      errors.push(`items[${index}] 不是 JSON 对象`);
      // P1-2：非对象项也持久化 rejected 行（无法结构化的字段记空串），保证计数不丢。
      rejected.push({
        segmentId: "",
        suspiciousText: "",
        type: "",
        suggestion: "",
        confidence: "",
        reason: "",
        sourceTextHash: "",
        why: `items[${index}] 不是 JSON 对象`,
      });
      continue;
    }
    const reject = (why: string) => {
      rejectedCount += 1;
      errors.push(`items[${index}]: ${why}`);
      rejected.push(toRejected(raw, why));
    };
    // 未知字段导致歧义 → 拒绝（PRD：不得用模糊解析猜着落库）。
    const allowedKeys = new Set([
      "segmentId",
      "suspiciousText",
      "type",
      "suggestion",
      "confidence",
      "reason",
    ]);
    if (Object.keys(raw).some((k) => !allowedKeys.has(k))) {
      reject("包含未知字段");
      continue;
    }
    const segmentId = typeof raw.segmentId === "string" ? raw.segmentId : null;
    if (!segmentId || !bySegment.has(segmentId)) {
      reject(`未知 segmentId：${String(raw.segmentId)}`);
      continue;
    }
    const suspiciousText = boundedString(raw.suspiciousText, 1, 200);
    if (!suspiciousText) {
      reject("suspiciousText 必须是 1-200 字");
      continue;
    }
    const originalText = bySegment.get(segmentId)!.originalText;
    // 逐字子串校验：可疑片段必须来自该段原文（不得取自相邻段或模型编造）。
    if (!originalText.includes(suspiciousText)) {
      reject("suspiciousText 不是该段 originalText 的子串");
      continue;
    }
    const type = PREFILTER_ALLOWED_TYPES.includes(raw.type as PrefilterCandidateType)
      ? (raw.type as PrefilterCandidateType)
      : null;
    if (!type) {
      reject(`非法类型：${String(raw.type)}`);
      continue;
    }
    // P1-2：suggestion 必须是显式 string（空串可）；缺失/null → 拒绝（提示词要求六字段齐全）。
    if (typeof raw.suggestion !== "string") {
      reject("suggestion 缺失或不是字符串（必须显式提供，可为空串）");
      continue;
    }
    const suggestion = raw.suggestion.trim().length > 200 ? null : raw.suggestion.trim();
    if (suggestion === null) {
      reject("suggestion 必须是 0-200 字");
      continue;
    }
    const confidence = PREFILTER_ALLOWED_CONFIDENCE.includes(raw.confidence as PrefilterConfidence)
      ? (raw.confidence as PrefilterConfidence)
      : null;
    if (!confidence) {
      reject(`非法 confidence：${String(raw.confidence)}`);
      continue;
    }
    const reason = boundedString(raw.reason, 1, 500);
    if (!reason) {
      reject("reason 必须是 1-500 字");
      continue;
    }
    // 同批重复候选（同段+类型+片段+建议 → 同 candidateKey）：拒绝并计数，绝不撞唯一约束。
    const candidateKey = candidateKeyOf({ segmentId, type, suspiciousText, suggestion });
    if (seenCandidateKeys.has(candidateKey)) {
      reject("重复候选（同段同类型同片段同建议）");
      continue;
    }
    seenCandidateKeys.add(candidateKey);
    const count = perSegmentCount.get(segmentId) ?? 0;
    if (count >= MAX_CANDIDATES_PER_SEGMENT) {
      reject(`单段候选超限（> ${MAX_CANDIDATES_PER_SEGMENT}）`);
      continue;
    }
    perSegmentCount.set(segmentId, count + 1);
    valid.push({
      segmentId,
      suspiciousText,
      type,
      suggestion,
      confidence,
      reason,
      sourceTextHash: sha256Hex(originalText),
    });
  }
  return { valid, rejected, rejectedCount, errors };
}

/** SHA-256（十六进制小写）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 候选稳定去重键：段 + 类型 + 可疑片段 + 建议写法。 */
export function candidateKeyOf(candidate: {
  segmentId: string;
  type: string;
  suspiciousText: string;
  suggestion: string;
}): string {
  return sha256Hex(`${candidate.segmentId}|${candidate.type}|${candidate.suspiciousText}|${candidate.suggestion}`);
}
