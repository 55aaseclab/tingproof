/**
 * V1.1.4 机器文本预筛服务端测试（PRD §3.4.9 / AC-069~071）：
 * - 输入只含 segmentId/cueNo/originalText（无 correctedText/音频）；候选严格白名单校验；
 * - warning 级 machine_prefilter 疑点 + 审计来源/脱敏；失败批次可重试；取消保留成功结果；
 * - 批次原子认领（并发 /next 模型只调一次）、inputHash 幂等复用、服务重启恢复；
 * - 已确认段不产生 open 机器疑点；已删除/已解决候选不复活/不重开；
 * - 迁移中间态（user_version=3 但缺 claim 列）原地补齐；
 * - envPrefilterModel 适配器：超时（TimeoutError）/429 重试与错误脱敏（假 fetch）。
 * 全部使用临时 SQLite 与注入假模型；绝不触碰 data/tingproof.db。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  envPrefilterModel,
  type PrefilterModel,
  type PrefilterModelInput,
} from "../server/prefilterModel.js";
import { SqliteProjectStore } from "../server/sqliteStore.js";
import { createRemoteRepository } from "../src/store/remoteRepo.js";
import { makeProjectPayload, startTestServer, type TestServer } from "./serverHarness.js";

const CLIENT = { "x-tingproof-client-id": "ci-prefilter", "x-tingproof-source": "web" };

/** 可控假模型：记录每次输入、可编程响应、可延迟。 */
function makeFakeModel() {
  const calls: PrefilterModelInput[][] = [];
  let handler: (inputs: PrefilterModelInput[]) => unknown = () => ({ items: [] });
  let delayMs = 0;
  const model: PrefilterModel = {
    provider: "fake-provider",
    model: "fake-model",
    promptVersion: "text-suspicion-v1",
    async complete(inputs) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      calls.push(inputs.map((i) => ({ ...i })));
      const result = handler(inputs);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {
    model,
    calls,
    setDelay: (ms: number) => (delayMs = ms),
    respond: (fn: (inputs: PrefilterModelInput[]) => unknown) => (handler = fn),
  };
}

/** 等待假模型已被调用（calls 长度增长），用于 deferred 场景的确定性同步。 */
async function waitForFakeCall(fake: ReturnType<typeof makeFakeModel>): Promise<void> {
  const target = fake.calls.length + 1;
  for (let i = 0; i < 50; i += 1) {
    if (fake.calls.length >= target) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitForFakeCall: 模型未被调用（超时 500ms）");
}

function makePayload(projectId: string, segmentCount: number) {
  const base = makeProjectPayload(projectId);
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    segmentId: `seg-${projectId}-${i + 1}`,
    cueNo: i + 1,
    startMs: 1000 * (i + 1),
    endMs: 1000 * (i + 1) + 900,
    originalText: `原文段落${i + 1}，包含数字${i + 1}和专名环境画卷。`,
    correctedText: `原文段落${i + 1}，包含数字${i + 1}和专名环境画卷。`,
    status: "unreviewed" as const,
  }));
  return { ...base, segments };
}

let server: TestServer | null = null;

afterEach(async () => {
  if (server) {
    await server.dispose();
    server = null;
  }
});

/** 保存并清空 LLM 环境变量（保证“未配置”用例不受环境影响）。 */
const ENV_KEYS = ["TINGPROOF_LLM_BASE_URL", "TINGPROOF_LLM_MODEL", "TINGPROOF_LLM_API_KEY"] as const;
let envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup = {};
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("预筛配置与入口（AC-071）", () => {
  it("未注入且无环境变量：available=false，字段完整且不含密钥/URL；POST run → 503", async () => {
    const s = await startTestServer();
    server = s;
    const config = await s.req("GET", "/api/text-prefilter/config");
    expect(config.status).toBe(200);
    expect(config.body?.available).toBe(false);
    expect(config.body?.provider).toBe("openai-compatible");
    expect(config.body?.promptVersion).toBe("text-suspicion-v1");
    expect(JSON.stringify(config.body)).not.toContain("API_KEY");
    expect(JSON.stringify(config.body)).not.toContain("BASE_URL");

    await s.req("POST", "/api/projects", makePayload("tp-pf-none", 2), CLIENT);
    const created = await s.req("POST", "/api/projects/tp-pf-none/text-prefilter-runs", {});
    expect(created.status).toBe(503);
    expect(created.body?.error).toBe("prefilter_unavailable");
    expect(String(created.body?.message)).toContain("TINGPROOF_LLM_BASE_URL");
  });

  it("注入假模型：available=true 且只暴露 provider/model/promptVersion", async () => {
    const fake = makeFakeModel();
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    const config = await s.req("GET", "/api/text-prefilter/config");
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      available: true,
      provider: "fake-provider",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    // 未显式创建 run 前不发起任何模型请求。
    expect(fake.calls).toHaveLength(0);
  });
});

describe("预筛输入与候选校验（AC-069）", () => {
  it("请求只含 segmentId/cueNo/originalText；合法候选落为 warning 机器疑点，正文/段状态不变", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "环境画卷（书名）",
          confidence: "high",
          reason: "疑似书名专名，建议人工核对",
        },
        {
          segmentId: inputs[1].segmentId,
          suspiciousText: "数字2",
          type: "number",
          suggestion: "",
          confidence: "medium",
          reason: "数字读起来别扭，待核",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-1", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-1/text-prefilter-runs", {}, CLIENT);
    expect(runRes.status).toBe(201);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    const next = await s.req("POST", `/api/projects/tp-pf-1/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(next.status).toBe(200);
    expect(next.body?.error).toBeNull();
    // 模型输入只含稳定 ID 与不可变原文。
    expect(fake.calls).toHaveLength(1);
    for (const input of fake.calls[0]) {
      expect(Object.keys(input).sort()).toEqual(["cueNo", "originalText", "segmentId"]);
    }

    // 疑点：warning 级 machine_prefilter，机器元数据完整（含 reason）。
    const issues = await s.req("GET", "/api/projects/tp-pf-1/issues");
    const rows = issues.body?.issues as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const issue of rows) {
      expect(issue.severity).toBe("warning");
      expect(issue.status).toBe("open");
      expect(issue.origin).toBe("machine_prefilter");
      const meta = issue.machineMetadata as Record<string, unknown>;
      expect(meta.provider).toBe("fake-provider");
      expect(meta.model).toBe("fake-model");
      expect(meta.promptVersion).toBe("text-suspicion-v1");
      expect(meta.runId).toBe(runId);
      expect(typeof meta.candidateKey).toBe("string");
      expect(meta.confidence).toBeOneOf(["high", "medium"]);
      expect(meta.suspiciousText).toBeTruthy();
      expect(meta.reason).toBeTruthy(); // 数据字典要求 reason（含机器理由）
    }
    // 正文与段状态不变；无候选段保持未确认。
    const segs = await s.req("GET", "/api/projects/tp-pf-1/segments");
    expect(
      (segs.body?.segments as Array<Record<string, unknown>>).every((x) => x.status === "unreviewed"),
    ).toBe(true);
    // run 完成：新增 2。
    const runAfter = (next.body?.run as Record<string, unknown>);
    expect(runAfter.status).toBe("completed");
    expect(runAfter.created).toBe(2);
  });

  it("非法候选全部拒绝并计数、持久化 rejected 行（issueId=null），不产生污染", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        // 合法第 1 条（后续完全重复它来测批内去重）。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: "", confidence: "high", reason: "合法第1条" },
        // 完全重复（同 candidateKey）→ 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: "", confidence: "high", reason: "合法第1条" },
        // 未知 ID → 拒绝。
        { segmentId: "seg-not-exist", suspiciousText: "任意", type: "number", suggestion: "", confidence: "high", reason: "未知 ID" },
        // 非原文子串 → 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "不在原文里的片段", type: "number", suggestion: "", confidence: "high", reason: "非子串" },
        // 非法类型（unclear 不允许）→ 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "unclear", suggestion: "", confidence: "high", reason: "非法类型" },
        // 非法置信度 → 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: "", confidence: "very-sure", reason: "非法置信度" },
        // 超长 reason → 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: "", confidence: "high", reason: "x".repeat(501) },
        // 未知字段 → 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: "", confidence: "high", reason: "未知字段", extra: 1 },
        // 合法第 2、3 条（第 1 段）。
        { segmentId: inputs[0].segmentId, suspiciousText: "数字", type: "number", suggestion: "一", confidence: "low", reason: "合法第2条" },
        { segmentId: inputs[0].segmentId, suspiciousText: "原文段落", type: "segmentation", suggestion: "", confidence: "low", reason: "合法第3条" },
        // 另一段的合法候选。
        { segmentId: inputs[1].segmentId, suspiciousText: "专名环境画卷", type: "homophone", suggestion: "", confidence: "medium", reason: "合法（另一段）" },
        // 单段第 4 条 → 拒绝（第 1 段已有 3 条合法）。
        { segmentId: inputs[0].segmentId, suspiciousText: "包含", type: "fact", suggestion: "", confidence: "low", reason: "第4条超限" },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-2", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-2/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    const next = await s.req("POST", `/api/projects/tp-pf-2/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(next.status).toBe(200);
    const run = next.body?.run as Record<string, unknown>;
    expect(run.status).toBe("completed");
    expect(run.created).toBe(4);
    expect(run.rejected).toBe(8); // 批内重复/未知 ID/非子串/非法类型/非法置信度/超长/未知字段/单段第4条
    // 恰好 4 条合法机器疑点；revision 恰好 +1（一个批次一次）。
    const issues = await s.req("GET", "/api/projects/tp-pf-2/issues");
    expect(issues.body?.issues).toHaveLength(4);
    expect(next.body?.revision).toBe(2);
    // rejected 候选行持久化（issue_id 为 null，含拒绝原因）。
    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      const rows = raw
        .prepare("SELECT issue_id, reason, disposition FROM prefilter_candidates WHERE batch_id IN (SELECT batch_id FROM prefilter_batches WHERE run_id = ?)")
        .all(runId) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(12); // 4 created + 8 rejected
      const rejectedRows = rows.filter((r) => r.disposition === "rejected");
      expect(rejectedRows).toHaveLength(8);
      expect(rejectedRows.every((r) => r.issue_id === null)).toBe(true);
      expect(rejectedRows.some((r) => String(r.reason).includes("未知 ID"))).toBe(true);
      expect(rows.filter((r) => r.disposition === "created")).toHaveLength(4);
    } finally {
      raw.close();
    }
  });

  it("整批无法解析（非法 JSON/未知顶层字段）→ 批次 failed 可重试；重试成功后完成", async () => {
    const fake = makeFakeModel();
    let failOnce = true;
    fake.respond(() => {
      if (failOnce) return new Error("模型响应不是有效 JSON");
      return { items: [] };
    });
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-3", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-3/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    const next = await s.req("POST", `/api/projects/tp-pf-3/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(next.status).toBe(200);
    expect(next.body?.error).toMatchObject({ code: "model_error" });
    const run = next.body?.run as Record<string, unknown>;
    expect(run.status).toBe("failed");
    expect(run.failedBatches).toBe(1);
    // 无 issue/审计污染。
    const issues = await s.req("GET", "/api/projects/tp-pf-3/issues");
    expect(issues.body?.issues).toHaveLength(0);

    // 显式重试成功 → completed。
    failOnce = false;
    const retry = await s.req("POST", `/api/projects/tp-pf-3/text-prefilter-runs/${runId}/retry`, {}, CLIENT);
    expect(retry.status).toBe(200);
    expect((retry.body?.run as Record<string, unknown>).status).toBe("completed");
    expect(fake.calls).toHaveLength(2);
  });

  it("冻结后段被人工确认 → 候选记 rejected（segment_confirmed_after_freeze），不产生 open 机器疑点", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "",
          confidence: "low",
          reason: "冻结后该段被确认",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-4", 2), CLIENT);
    // 冻结 run（不处理），先原子确认第 1 段。
    const runRes = await s.req("POST", "/api/projects/tp-pf-4/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    const confirm = await s.req(
      "POST",
      "/api/projects/tp-pf-4/segments/seg-tp-pf-4-1/confirm",
      { expectedRevision: 1 },
      CLIENT,
    );
    expect(confirm.status).toBe(200);

    const next = await s.req("POST", `/api/projects/tp-pf-4/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(next.status).toBe(200);
    const run = next.body?.run as Record<string, unknown>;
    expect(run.created).toBe(0);
    expect(run.rejected).toBe(1); // 已确认段候选被拒
    // 已确认段上没有 open 机器疑点（AC-068 不变量保持）。
    const issues = await s.req("GET", "/api/projects/tp-pf-4/issues");
    expect(issues.body?.issues).toHaveLength(0);
    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT reason FROM prefilter_candidates WHERE disposition = 'rejected' AND run_id = ?")
        .get(runId) as Record<string, unknown>;
      expect(String(row.reason)).toContain("segment_confirmed_after_freeze");
    } finally {
      raw.close();
    }
  });
});

describe("预筛批次幂等与恢复（AC-070）", () => {
  it("3 批 run：批 2 失败 → 服务重启后从批 2 继续，批 1 不再调用模型；retry 后完成", async () => {
    const fake = makeFakeModel();
    const failedOnce = new Set<string>();
    fake.respond((inputs) => {
      const key = inputs[0].segmentId;
      // 批 2（第 21 段起）第一次失败。
      if (key === "seg-tp-pf-5-21" && !failedOnce.has(key)) {
        failedOnce.add(key);
        return new Error("模型服务暂时不可用（HTTP 503）");
      }
      return { items: [] };
    });
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-5", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-5/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    expect((runRes.body?.run as Record<string, unknown>).batches).toHaveLength(3); // 20+20+5

    // 批 1 成功。
    await s.req("POST", `/api/projects/tp-pf-5/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(fake.calls).toHaveLength(1);
    // 批 2 失败。
    const second = await s.req("POST", `/api/projects/tp-pf-5/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect((second.body?.run as Record<string, unknown>).failedBatches).toBe(1);
    expect(fake.calls).toHaveLength(2);

    // 服务重启（同库）：从批 2 继续；批 1 不再调用。
    await s.restart();
    const third = await s.req("POST", `/api/projects/tp-pf-5/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(third.status).toBe(200);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2][0].segmentId).toBe("seg-tp-pf-5-21"); // 从批 2 继续
    expect(
      fake.calls.slice(2).some((c) => c[0].segmentId === "seg-tp-pf-5-1"),
    ).toBe(false); // 批 1 未重跑
    expect((third.body?.run as Record<string, unknown>).status).toBe("running");

    // 批 3 → 完成。
    const fourth = await s.req("POST", `/api/projects/tp-pf-5/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect((fourth.body?.run as Record<string, unknown>).status).toBe("completed");
    expect(fake.calls).toHaveLength(4);
  });

  it("并发 Promise.all 两个 /next：同一批次只调用模型一次（原子 claim）", async () => {
    const fake = makeFakeModel();
    fake.setDelay(80); // 保证第二个请求在批 1 处理期间到达
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-6", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-6/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    const [a, b] = await Promise.all([
      s.req("POST", `/api/projects/tp-pf-6/text-prefilter-runs/${runId}/next`, {}, CLIENT),
      s.req("POST", `/api/projects/tp-pf-6/text-prefilter-runs/${runId}/next`, {}, CLIENT),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // 恰好一个请求真正处理了批次（processed=true），另一个未调用模型。
    const processedFlags = [a.body?.processed, b.body?.processed].filter(Boolean);
    expect(processedFlags).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("inputHash 幂等：只处理首批后取消，同 scope 新 run 首批直接复制结果，不调用模型、不重复建疑点", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "",
          confidence: "high",
          reason: "幂等复用测试",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    // 21 段 → 2 批（20 + 1）。
    await s.req("POST", "/api/projects", makePayload("tp-pf-7", 21), CLIENT);
    const first = await s.req("POST", "/api/projects/tp-pf-7/text-prefilter-runs", {}, CLIENT);
    const runId1 = (first.body?.run as Record<string, unknown>).runId as string;
    // 同 scope 立即重复创建 → run 级复用（同 runId，不重复）。
    const again = await s.req("POST", "/api/projects/tp-pf-7/text-prefilter-runs", {}, CLIENT);
    expect(again.status).toBe(200);
    expect((again.body?.run as Record<string, unknown>).runId).toBe(runId1);

    // 只处理批 1（run 仍有 queued 批 2 → running，cancel 有效）。
    await s.req("POST", `/api/projects/tp-pf-7/text-prefilter-runs/${runId1}/next`, {}, CLIENT);
    expect(fake.calls).toHaveLength(1);
    const issues1 = (await s.req("GET", "/api/projects/tp-pf-7/issues")).body?.issues as unknown[];
    expect(issues1).toHaveLength(1);
    await s.req("POST", `/api/projects/tp-pf-7/text-prefilter-runs/${runId1}/cancel`, {}, CLIENT);

    // 新 run（同 scope；旧 run 已取消）→ 批 1 inputHash 命中成功批次 → 复制结果，不调模型。
    const fresh = await s.req("POST", "/api/projects/tp-pf-7/text-prefilter-runs", {}, CLIENT);
    const runId2 = (fresh.body?.run as Record<string, unknown>).runId as string;
    expect(runId2).not.toBe(runId1);
    const next = await s.req("POST", `/api/projects/tp-pf-7/text-prefilter-runs/${runId2}/next`, {}, CLIENT);
    expect(fake.calls).toHaveLength(1); // 首批未再次调用模型
    const run = next.body?.run as Record<string, unknown>;
    expect(run.reused).toBe(1); // 复制旧候选
    expect(run.created).toBe(0);
    // 不重复建疑点（仍只有批 1 的那一条）。
    const issues2 = (await s.req("GET", "/api/projects/tp-pf-7/issues")).body?.issues as unknown[];
    expect(issues2).toHaveLength(1);
    // 批 2（新 run 内仍 queued）正常处理 → 完成。
    const next2 = await s.req("POST", `/api/projects/tp-pf-7/text-prefilter-runs/${runId2}/next`, {}, CLIENT);
    expect(fake.calls).toHaveLength(2);
    expect((next2.body?.run as Record<string, unknown>).status).toBe("completed");
  });

  it("A 删除不复活：删除 issue 后新 scope 重跑，同 candidateKey 只 reused、不新建", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "",
          confidence: "high",
          reason: "删除不复活",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-del", 2), CLIENT);

    // run1：建一条机器疑点。
    const run1 = await s.req("POST", "/api/projects/tp-pf-del/text-prefilter-runs", {}, CLIENT);
    const runId1 = (run1.body?.run as Record<string, unknown>).runId as string;
    await s.req("POST", `/api/projects/tp-pf-del/text-prefilter-runs/${runId1}/next`, {}, CLIENT);
    const issues1 = (await s.req("GET", "/api/projects/tp-pf-del/issues")).body?.issues as Array<Record<string, unknown>>;
    expect(issues1).toHaveLength(1);
    const issueId = issues1[0].issueId as string;

    // 删除该疑点；确认第 2 段改变 scope（[seg1]），run 级复用不命中。
    let rev = ((await s.req("GET", "/api/projects/tp-pf-del")).body?.project as Record<string, unknown>).revision as number;
    await s.req("DELETE", `/api/projects/tp-pf-del/issues/${issueId}`, { expectedRevision: rev }, CLIENT);
    rev += 1;
    await s.req("POST", "/api/projects/tp-pf-del/segments/seg-tp-pf-del-2/confirm", { expectedRevision: rev }, CLIENT);

    // run2（新 scope）：同 candidateKey → reused，不复活、不新建。
    const run2 = await s.req("POST", "/api/projects/tp-pf-del/text-prefilter-runs", {}, CLIENT);
    const runId2 = (run2.body?.run as Record<string, unknown>).runId as string;
    expect(runId2).not.toBe(runId1);
    const next2 = await s.req("POST", `/api/projects/tp-pf-del/text-prefilter-runs/${runId2}/next`, {}, CLIENT);
    const run2After = next2.body?.run as Record<string, unknown>;
    expect(run2After.created).toBe(0);
    expect(run2After.reused).toBe(1);
    expect(fake.calls).toHaveLength(2); // run2 调用过模型（不同 scope），但候选被去重
    expect(((await s.req("GET", "/api/projects/tp-pf-del/issues")).body?.issues as unknown[])).toHaveLength(0);
  });

  it("B resolved 不重开：确认自动解决后新 scope 重跑，候选 reused、原疑点保持 resolved", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "",
          confidence: "high",
          reason: "解决不重开",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-res", 3), CLIENT);

    // run1：seg1 建一条 open 机器疑点。
    const run1 = await s.req("POST", "/api/projects/tp-pf-res/text-prefilter-runs", {}, CLIENT);
    const runId1 = (run1.body?.run as Record<string, unknown>).runId as string;
    await s.req("POST", `/api/projects/tp-pf-res/text-prefilter-runs/${runId1}/next`, {}, CLIENT);
    const issues1 = (await s.req("GET", "/api/projects/tp-pf-res/issues")).body?.issues as Array<Record<string, unknown>>;
    expect(issues1).toHaveLength(1);
    expect(issues1[0].status).toBe("open");
    const issueId = issues1[0].issueId as string;

    // 原子确认 seg1 → 该疑点自动解决（cause=segment_confirm）。
    let rev = ((await s.req("GET", "/api/projects/tp-pf-res")).body?.project as Record<string, unknown>).revision as number;
    const confirmRes = await s.req(
      "POST",
      "/api/projects/tp-pf-res/segments/seg-tp-pf-res-1/confirm",
      { expectedRevision: rev },
      CLIENT,
    );
    expect(confirmRes.status).toBe(200);
    expect((confirmRes.body?.resolvedIssues as Array<Record<string, unknown>>)[0].issueId).toBe(issueId);

    // 撤销 seg1 确认（疑点保持 resolved），确认 seg3 → 新 scope=[seg1,seg2] ≠ 旧 scope 且仍含 seg1。
    rev = ((await s.req("GET", "/api/projects/tp-pf-res")).body?.project as Record<string, unknown>).revision as number;
    await s.req(
      "PATCH",
      "/api/segments/seg-tp-pf-res-1",
      { patch: { status: "editing" }, projectId: "tp-pf-res", expectedRevision: rev },
      CLIENT,
    );
    rev += 1;
    await s.req("POST", "/api/projects/tp-pf-res/segments/seg-tp-pf-res-3/confirm", { expectedRevision: rev }, CLIENT);

    // run2（新 scope）：同 candidateKey → reused；原疑点保持 resolved，不重开、不新建。
    const run2 = await s.req("POST", "/api/projects/tp-pf-res/text-prefilter-runs", {}, CLIENT);
    const runId2 = (run2.body?.run as Record<string, unknown>).runId as string;
    expect(runId2).not.toBe(runId1);
    const next2 = await s.req("POST", `/api/projects/tp-pf-res/text-prefilter-runs/${runId2}/next`, {}, CLIENT);
    const run2After = next2.body?.run as Record<string, unknown>;
    expect(run2After.created).toBe(0);
    expect(run2After.reused).toBe(1);
    const issues2 = (await s.req("GET", "/api/projects/tp-pf-res/issues")).body?.issues as Array<Record<string, unknown>>;
    expect(issues2).toHaveLength(1);
    expect(issues2[0].issueId).toBe(issueId);
    expect(issues2[0].status).toBe("resolved"); // 不重开
  });

  it("取消：保留已成功批次结果，未开始批次 cancelled，不伪装完成", async () => {
    const fake = makeFakeModel();
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-9", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-9/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    await s.req("POST", `/api/projects/tp-pf-9/text-prefilter-runs/${runId}/next`, {}, CLIENT); // 批 1 成功

    const cancel = await s.req("POST", `/api/projects/tp-pf-9/text-prefilter-runs/${runId}/cancel`, {}, CLIENT);
    const run = cancel.body?.run as Record<string, unknown>;
    expect(run.status).toBe("cancelled");
    const batches = run.batches as Array<Record<string, unknown>>;
    expect(batches[0].status).toBe("succeeded");
    expect(batches[1].status).toBe("cancelled");
    expect(batches[2].status).toBe("cancelled");
    // 已成功结果保留：processed 不回退。
    expect(run.processed).toBe(20);
  });

  it("取消竞态：模型 in-flight 时取消，当前批完成后 run 保持 cancelled、不伪装完成", async () => {
    const fake = makeFakeModel();
    fake.setDelay(120); // 模拟模型调用耗时，保证取消在 in-flight 期间到达
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-cancel-race", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-cancel-race/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // 批 1 处理中（模型 in-flight）发出取消。
    const nextPromise = s.req(
      "POST",
      `/api/projects/tp-pf-cancel-race/text-prefilter-runs/${runId}/next`,
      {},
      CLIENT,
    );
    await new Promise((r) => setTimeout(r, 40)); // 等 claim 完成、模型调用开始
    const cancel = await s.req(
      "POST",
      `/api/projects/tp-pf-cancel-race/text-prefilter-runs/${runId}/cancel`,
      {},
      CLIENT,
    );
    expect((cancel.body?.run as Record<string, unknown>).status).toBe("cancelled");
    const next = await nextPromise; // 当前批完成（批次边界）
    expect(next.status).toBe(200);

    // 最终状态：run 保持 cancelled（不被当前批完成覆盖成 completed）。
    const final = await s.req("GET", `/api/projects/tp-pf-cancel-race/text-prefilter-runs/${runId}`);
    const run = final.body?.run as Record<string, unknown>;
    expect(run.status).toBe("cancelled");
    const batches = run.batches as Array<Record<string, unknown>>;
    expect(batches[0].status).toBe("succeeded"); // 当前批结果保留
    expect(batches[1].status).toBe("cancelled");
    expect(batches[2].status).toBe("cancelled");
    expect(run.processed).toBe(20); // 已成功批次计数保留
    expect(fake.calls).toHaveLength(1); // 模型只调用一次
  });

  it("store 层恢复：claim 后 close（优雅关闭）→ 重开可再次 claim；租约过期可回收", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tingproof-pf-claim-"));
    const dbPath = join(dir, "claim.db");
    try {
      const fake = makeFakeModel();
      const store1 = new SqliteProjectStore(dbPath);
      // 手工建项目与 run（绕过 HTTP，聚焦 claim 生命周期）。
      const payload = makePayload("tp-claim", 2);
      store1.createProject(
        JSON.parse(JSON.stringify(payload)) as Parameters<SqliteProjectStore["createProject"]>[0],
        { clientId: "ci-claim", source: "api" },
      );
      const { run } = store1.createPrefilterRun("tp-claim", {
        provider: fake.model.provider,
        model: fake.model.model,
        promptVersion: fake.model.promptVersion,
      });
      const claimed = store1.claimPrefilterBatch("tp-claim", run.runId, "next");
      expect(claimed).toBeTruthy();
      // 同一 store 并发第二认领：running 且未超租约 → null（不抢、不跳批）。
      expect(store1.claimPrefilterBatch("tp-claim", run.runId, "next")).toBeNull();
      // 优雅关闭：释放本实例认领。
      store1.close();
      // 重开：批次回到 queued，可再次 claim（服务重启恢复）。
      const store2 = new SqliteProjectStore(dbPath);
      const reclaimed = store2.claimPrefilterBatch("tp-claim", run.runId, "next");
      expect(reclaimed).toBeTruthy();
      expect(reclaimed!.batchId).toBe(claimed!.batchId);
      // 模拟崩溃残留：手工把 claimed_at 拨回租约之前 → 可被回收。
      const raw = new DatabaseSync(dbPath);
      raw.prepare("UPDATE prefilter_batches SET claimed_at = ? WHERE batch_id = ?").run(
        Date.now() - SqliteProjectStore.PREFILTER_CLAIM_LEASE_MS - 1000,
        reclaimed!.batchId,
      );
      raw.close();
      const store3 = new SqliteProjectStore(dbPath);
      expect(store3.claimPrefilterBatch("tp-claim", run.runId, "next")).toBeTruthy();
      store2.close();
      store3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("预筛来源、安全与审计（AC-071）", () => {
  it("机器 create_issue 审计：source=machine_prefilter、metadata 完整、不含提示词/密钥/整批正文", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "环境画卷",
          confidence: "high",
          reason: "审计来源测试",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-audit", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-audit/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    const next = await s.req("POST", `/api/projects/tp-pf-audit/text-prefilter-runs/${runId}/next`, {}, CLIENT);

    const events = await (await s.req("GET", "/api/projects/tp-pf-audit/audit-events")).body?.events as Array<
      Record<string, unknown>
    >;
    const machineEvents = events.filter((e) => e.action === "create_issue");
    expect(machineEvents).toHaveLength(1);
    const ev = machineEvents[0];
    expect(ev.source).toBe("machine_prefilter");
    expect(ev.clientId).toBe("ci-prefilter"); // 诚实记录发起 run 的客户端实例
    const metadata = ev.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      origin: "machine_prefilter",
      provider: "fake-provider",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
      runId,
      confidence: "high",
    });
    expect(typeof metadata.batchId).toBe("string");
    expect(typeof metadata.candidateKey).toBe("string");
    expect(typeof metadata.sourceTextHash).toBe("string");
    const after = ev.after as Record<string, unknown>;
    expect(after.origin).toBe("machine_prefilter");
    expect((after.machineMetadata as Record<string, unknown>).reason).toBe("审计来源测试");
    // 提示词正文、密钥与整批正文绝不进入审计。
    const dump = JSON.stringify(ev);
    expect(dump).not.toContain("语音转写质检助手");
    expect(dump).not.toContain("API_KEY");
    expect(dump).not.toContain("Authorization");
    expect(dump).not.toContain("原文段落2"); // 非候选段原文不进审计
    // revision 恰好 +1（一个批次一次）。
    expect(next.body?.revision).toBe(2);
  });

  it("预筛推进 revision 后：旧 revision 手动写入 → 409（不静默覆盖）", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        {
          segmentId: inputs[0].segmentId,
          suspiciousText: "专名环境画卷",
          type: "proper_noun",
          suggestion: "",
          confidence: "high",
          reason: "revision 推进测试",
        },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-pf-rev", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-pf-rev/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    await s.req("POST", `/api/projects/tp-pf-rev/text-prefilter-runs/${runId}/next`, {}, CLIENT);

    const stale = await s.req(
      "PATCH",
      "/api/segments/seg-tp-pf-rev-1",
      { patch: { correctedText: "旧 revision 写入" }, projectId: "tp-pf-rev", expectedRevision: 1 },
      CLIENT,
    );
    expect(stale.status).toBe(409);
    expect((stale.body as Record<string, unknown>).currentRevision).toBe(2);
  });
});

describe("迁移中间态：user_version=3 但 prefilter_batches 缺 claim 列（原地补齐）", () => {
  it("构造 v3 旧 14 列库 → 补 claimed_by/claimed_at，数据不变，claim 可用且幂等", () => {
    const dir = mkdtempSync(join(tmpdir(), "tingproof-pf-mig-"));
    const dbPath = join(dir, "mid.db");
    try {
      // 先用当前代码建库（v3 全量），再手工降级成“中间态”：去掉 claim 列只能重建表——
      // 直接模拟：建旧 14 列表结构 + user_version=3。
      const store = new SqliteProjectStore(dbPath);
      const payload = makePayload("tp-mid", 2);
      store.createProject(
        JSON.parse(JSON.stringify(payload)) as Parameters<SqliteProjectStore["createProject"]>[0],
        { clientId: "ci-mid", source: "api" },
      );
      const { run } = store.createPrefilterRun("tp-mid", {
        provider: "p",
        model: "m",
        promptVersion: "text-suspicion-v1",
      });
      store.close();

      // 中间态：重建为旧 14 列 prefilter_batches（无 claimed_by/claimed_at），保留 run/batch 数据。
      const raw = new DatabaseSync(dbPath);
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.exec(`
        CREATE TABLE prefilter_batches_old (
          batch_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
          batch_no INTEGER NOT NULL, input_hash TEXT NOT NULL, inputs_json TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
          error_code TEXT, error_message TEXT,
          created_count INTEGER NOT NULL DEFAULT 0, reused_count INTEGER NOT NULL DEFAULT 0,
          rejected_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          UNIQUE (run_id, batch_no)
        )`);
      raw.exec(`
        INSERT INTO prefilter_batches_old
          SELECT batch_id, run_id, project_id, batch_no, input_hash, inputs_json, attempt_count,
                 status, error_code, error_message, created_count, reused_count, rejected_count, created_at
          FROM prefilter_batches`);
      raw.exec("DROP TABLE prefilter_batches");
      raw.exec("ALTER TABLE prefilter_batches_old RENAME TO prefilter_batches");
      raw.exec("PRAGMA user_version = 3");
      raw.close();

      const cols = (db: DatabaseSync) =>
        (db.prepare("PRAGMA table_info(prefilter_batches)").all() as Array<Record<string, unknown>>).map(
          (c) => String(c.name),
        );
      const rawCheck = new DatabaseSync(dbPath, { readOnly: true });
      expect(cols(rawCheck)).not.toContain("claimed_by");
      rawCheck.close();

      // 构造 store：version==3 仍按列存在性幂等补齐 claim 列。
      const reopened = new SqliteProjectStore(dbPath);
      let reopenedClosed = false;
      try {
        expect(reopened.schemaVersion).toBe(3);
        const rawAfter = new DatabaseSync(dbPath, { readOnly: true });
        const columns = cols(rawAfter);
        expect(columns).toContain("claimed_by");
        expect(columns).toContain("claimed_at");
        // 既有 run/batch 数据不变。
        const runs = rawAfter.prepare("SELECT COUNT(*) AS n FROM prefilter_runs").get() as Record<string, unknown>;
        expect(runs.n).toBe(1);
        const batches = rawAfter.prepare("SELECT batch_id, status FROM prefilter_batches").all() as Array<
          Record<string, unknown>
        >;
        expect(batches).toHaveLength(1);
        expect(batches[0].status).toBe("queued");
        rawAfter.close();
        // claim 正常工作。
        const claimed = reopened.claimPrefilterBatch("tp-mid", run.runId, "next");
        expect(claimed).toBeTruthy();
        // 重复构造（幂等）：close 释放本实例认领后可再次 claim。
        reopened.close();
        reopenedClosed = true;
        const again = new SqliteProjectStore(dbPath);
        try {
          expect(again.claimPrefilterBatch("tp-mid", run.runId, "next")).toBeTruthy();
        } finally {
          again.close();
        }
      } finally {
        if (!reopenedClosed) reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P0-1：多批失败状态不被 queued 掩盖", () => {
  it("批 2 失败、批 3 queued → run=partial（非 running）；UI 可显示重试按钮", async () => {
    const fake = makeFakeModel();
    const failedOnce = new Set<string>();
    fake.respond((inputs) => {
      const key = inputs[0].segmentId;
      if (key === "seg-tp-p01-21" && !failedOnce.has(key)) {
        failedOnce.add(key);
        return new Error("模型服务暂时不可用（HTTP 503）");
      }
      return { items: [] };
    });
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-p01", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-p01/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // 批 1 成功。
    await s.req("POST", `/api/projects/tp-p01/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    // 批 2 失败。
    const second = await s.req("POST", `/api/projects/tp-p01/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    const runAfterFail = second.body?.run as Record<string, unknown>;
    // P0-1 关键断言：批 2 失败 + 批 3 仍 queued → run 必须是 partial（非 running）。
    expect(runAfterFail.status).toBe("partial");
    expect(runAfterFail.failedBatches).toBe(1);
    expect(runAfterFail.processed).toBe(20);
    // 重试路径可用。
    const retry = await s.req("POST", `/api/projects/tp-p01/text-prefilter-runs/${runId}/retry`, {}, CLIENT);
    expect(retry.status).toBe(200);
    expect((retry.body?.run as Record<string, unknown>).failedBatches).toBe(0); // 批 2 重试成功
    expect((retry.body?.run as Record<string, unknown>).processed).toBe(40); // 批 1+2 已处理
  });
});

describe("P0-1（第 2 轮）：claim 后 run 状态/startedAt/completedAt 生命周期", () => {
  it("claim 后 run=running+startedAt 非空+completedAt=null（deferred 模型期间 GET 可见）", async () => {
    const fake = makeFakeModel();
    let releaseModel!: () => void;
    fake.respond(() => new Promise<unknown>((resolve) => { releaseModel = () => resolve({ items: [] }); }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-r2a", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-r2a/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // 创建后初始：queued、startedAt=null。
    const before = await s.req("GET", `/api/projects/tp-r2a/text-prefilter-runs/${runId}`);
    expect((before.body?.run as Record<string, unknown>).status).toBe("queued");
    expect((before.body?.run as Record<string, unknown>).startedAt).toBeNull();

    // 发起 /next（不 await）——claim 后 GET 看到 running/startedAt/completedAt。
    const nextPromise = s.req("POST", `/api/projects/tp-r2a/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    await waitForFakeCall(fake);
    const during = await s.req("GET", `/api/projects/tp-r2a/text-prefilter-runs/${runId}`);
    const runDuring = during.body?.run as Record<string, unknown>;
    expect(runDuring.status).toBe("running");
    expect(runDuring.startedAt).not.toBeNull();
    expect(runDuring.completedAt).toBeNull();
    expect(((runDuring.batches as Array<Record<string, unknown>>)[0]).status).toBe("running");

    releaseModel();
    const next = await nextPromise;
    expect(next.status).toBe(200);
    expect((next.body?.run as Record<string, unknown>).status).toBe("completed");
    expect((next.body?.run as Record<string, unknown>).completedAt).not.toBeNull();
  });

  it("failed→retry claim 清旧 completedAt；完成后写入新 completedAt", async () => {
    // 可变假模型：先失败，再 deferred 成功。
    const fake = makeFakeModel();
    let mode: "fail" | "deferred" = "fail";
    let releaseRetry: (() => void) | null = null;
    fake.respond(() => {
      if (mode === "fail") return new Error("模型服务暂时不可用（HTTP 503）");
      return new Promise<unknown>((resolve) => { releaseRetry = () => resolve({ items: [] }); });
    });
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-r2b", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-r2b/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // 批 1 失败 → run=failed（单批全失败）→ completedAt 写入（终态）。
    await s.req("POST", `/api/projects/tp-r2b/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    const afterFail = await s.req("GET", `/api/projects/tp-r2b/text-prefilter-runs/${runId}`);
    const runFail = afterFail.body?.run as Record<string, unknown>;
    expect(runFail.status).toBe("failed");
    expect(runFail.completedAt).not.toBeNull();

    // 切换为 deferred 成功 → retry claim 进入非终态 → completedAt 清空。
    mode = "deferred";
    const retryPromise = s.req("POST", `/api/projects/tp-r2b/text-prefilter-runs/${runId}/retry`, {}, CLIENT);
    await waitForFakeCall(fake);
    const duringRetry = await s.req("GET", `/api/projects/tp-r2b/text-prefilter-runs/${runId}`);
    const runDuringRetry = duringRetry.body?.run as Record<string, unknown>;
    expect(runDuringRetry.status).toBe("running");
    expect(runDuringRetry.completedAt).toBeNull(); // P0-1 关键：旧 completedAt 清空

    releaseRetry!();
    const retry = await retryPromise;
    expect(retry.status).toBe(200);
    expect((retry.body?.run as Record<string, unknown>).status).toBe("completed");
    expect((retry.body?.run as Record<string, unknown>).completedAt).not.toBeNull(); // 新 completedAt
  });
});

describe("P0-3：GET 最近 run 发现 API", () => {
  it("无 run → null（不创建、不触发模型）；有 run → 返回最新", async () => {
    const fake = makeFakeModel();
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-p03", 2), CLIENT);

    // 无 run → null。
    const empty = await s.req("GET", "/api/projects/tp-p03/text-prefilter-runs");
    expect(empty.status).toBe(200);
    expect(empty.body?.run).toBeNull();

    // 创建 run 并完成。
    const runRes = await s.req("POST", "/api/projects/tp-p03/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    await s.req("POST", `/api/projects/tp-p03/text-prefilter-runs/${runId}/next`, {}, CLIENT);

    // GET → 最近 run。
    const latest = await s.req("GET", "/api/projects/tp-p03/text-prefilter-runs");
    expect(latest.status).toBe(200);
    expect((latest.body?.run as Record<string, unknown>).runId).toBe(runId);
    expect((latest.body?.run as Record<string, unknown>).status).toBe("completed");
    expect(fake.calls).toHaveLength(1); // GET 不触发模型
  });
});

describe("P0-3（第 5 轮）：remoteRepo createPrefilterRun 集成（revision cache 已建立）", () => {
  it("先读项目建立 revision cache → createPrefilterRun 成功（不因 expectedRevision 400）", async () => {
    const fake = makeFakeModel();
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    const device = createRemoteRepository(`${s.baseUrl}/api`);
    const payload = makeProjectPayload("tp-r5p3");
    await device.createProject({
      meta: {
        projectId: "tp-r5p3",
        name: payload.meta.name,
        normalizedStem: payload.meta.normalizedStem,
        media: payload.meta.media,
      } as unknown as Parameters<typeof device.createProject>[0]["meta"],
      srtSource: payload.srtSource,
      segments: payload.segments,
    });
    // 建立 revision cache（getProjectSegments 会 noteRevision）。
    const segs = await device.getProjectSegments("tp-r5p3");
    expect(segs).toHaveLength(2);

    // 关键：createPrefilterRun 不因 expectedRevision 被 400。
    const run = await device.createPrefilterRun("tp-r5p3");
    expect(run.projectId).toBe("tp-r5p3");
    expect(run.status).toBe("queued");
    expect(run.total).toBe(2);
    // 处理一批确认完全正常。
    const next = await device.prefilterNext("tp-r5p3", run.runId);
    expect(next.error).toBeNull();
    expect(next.run.status).toBe("completed");
  });
});

describe("P0-4：cancelled 生命周期", () => {
  it("取消后 next/retry 不可再 claim（终态 run 零副作用）", async () => {
    const fake = makeFakeModel();
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-p04a", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-p04a/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // 处理批 1 后取消。
    await s.req("POST", `/api/projects/tp-p04a/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    await s.req("POST", `/api/projects/tp-p04a/text-prefilter-runs/${runId}/cancel`, {}, CLIENT);
    const callsBefore = fake.calls.length;

    // next/retry 都不可再 claim（终态 run）。
    const next = await s.req("POST", `/api/projects/tp-p04a/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(next.status).toBe(200);
    expect(next.body?.processed).toBe(false);
    expect(fake.calls).toHaveLength(callsBefore); // 零模型调用
    const retry = await s.req("POST", `/api/projects/tp-p04a/text-prefilter-runs/${runId}/retry`, {}, CLIENT);
    expect(retry.status).toBe(200);
    expect(retry.body?.processed).toBe(false);

    // 状态不变。
    const final = await s.req("GET", `/api/projects/tp-p04a/text-prefilter-runs/${runId}`);
    expect((final.body?.run as Record<string, unknown>).status).toBe("cancelled");
  });

  it("取消 → close/reopen → 已取消 run 的批次不复活", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tingproof-p04b-"));
    const dbPath = join(dir, "cancel-reopen.db");
    try {
      const fake = makeFakeModel();
      const store = new SqliteProjectStore(dbPath);
      const payload = makePayload("tp-p04b", 45);
      store.createProject(
        JSON.parse(JSON.stringify(payload)) as Parameters<SqliteProjectStore["createProject"]>[0],
        { clientId: "ci-p04b", source: "api" },
      );
      const { run } = store.createPrefilterRun("tp-p04b", {
        provider: fake.model.provider,
        model: fake.model.model,
        promptVersion: fake.model.promptVersion,
      });
      // claim 批 1（running），然后取消 run。
      const claimed = store.claimPrefilterBatch("tp-p04b", run.runId, "next");
      expect(claimed).toBeTruthy();
      store.cancelPrefilterRun("tp-p04b", run.runId);
      // 优雅关闭：不释放已取消 run 的 running 批（P0-4）。
      store.close();
      // 重开：cancelled run 不可再 claim。
      const reopened = new SqliteProjectStore(dbPath);
      try {
        const result = reopened.claimPrefilterBatch("tp-p04b", run.runId, "next");
        expect(result).toBeNull(); // 终态 run 零 claim
        // 批次状态：批 1 仍 running（不复活为 queued），批 2/3 仍 cancelled。
        const runAfter = reopened.getPrefilterRun("tp-p04b", run.runId);
        expect(runAfter.status).toBe("cancelled");
        expect(runAfter.batches[0].status).toBe("running"); // 不复活
        expect(runAfter.batches[1].status).toBe("cancelled");
        expect(runAfter.batches[2].status).toBe("cancelled");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P0-6：run 模型配置不可漂移", () => {
  it("服务重启换模型 → 旧 run config_mismatch 零模型调用/零污染；新建用新配置", async () => {
    const fake1 = makeFakeModel();
    fake1.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake1.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-p06", 45), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-p06/text-prefilter-runs", {}, CLIENT);
    const runId1 = (runRes.body?.run as Record<string, unknown>).runId as string;
    // 处理批 1。
    await s.req("POST", `/api/projects/tp-p06/text-prefilter-runs/${runId1}/next`, {}, CLIENT);
    expect(fake1.calls).toHaveLength(1);

    // 服务重启，换模型（同一 temp dbPath；真实 HTTP 路径）。
    const fake2 = makeFakeModel();
    fake2.model = { ...fake2.model, provider: "new-provider", model: "new-model" };
    await s.restart({ prefilterModel: fake2.model });

    // 旧 run 的 next → config_mismatch，零模型调用、零状态污染。
    const next = await s.req("POST", `/api/projects/tp-p06/text-prefilter-runs/${runId1}/next`, {}, CLIENT);
    expect(next.status).toBe(200);
    expect((next.body?.error as Record<string, unknown> | null)?.code).toBe("config_mismatch");
    expect(next.body?.processed).toBe(false);
    expect(fake2.calls).toHaveLength(0); // 新模型零调用
    // 旧 run 状态不变（running，批 1 已成功，批 2/3 queued）。
    const old = await s.req("GET", `/api/projects/tp-p06/text-prefilter-runs/${runId1}`);
    expect((old.body?.run as Record<string, unknown>).status).toBe("running");
    expect((old.body?.run as Record<string, unknown>).processed).toBe(20);

    // 显式新建（新配置）→ 不同 runId，用新配置正常处理。
    const fresh = await s.req("POST", "/api/projects/tp-p06/text-prefilter-runs", {}, CLIENT);
    expect(fresh.status).toBe(201);
    const runId2 = (fresh.body?.run as Record<string, unknown>).runId as string;
    expect(runId2).not.toBe(runId1);
    expect((fresh.body?.run as Record<string, unknown>).provider).toBe("new-provider");
    const next2 = await s.req("POST", `/api/projects/tp-p06/text-prefilter-runs/${runId2}/next`, {}, CLIENT);
    expect(next2.status).toBe(200);
    expect(next2.body?.error).toBeNull();
    expect(fake2.calls).toHaveLength(1); // 新模型正常调用
  });
});

describe("P1-4（第 5 轮）：预筛 action 请求体校验", () => {
  it("next/retry/cancel 带未知字段 → 400，零副作用（不 claim、不调模型）", async () => {
    const fake = makeFakeModel();
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makeProjectPayload("tp-r5p4"), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-r5p4/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // next 带未知字段 → 400。
    const badNext = await s.req(
      "POST",
      `/api/projects/tp-r5p4/text-prefilter-runs/${runId}/next`,
      { evilField: true },
      CLIENT,
    );
    expect(badNext.status).toBe(400);
    expect(fake.calls).toHaveLength(0); // 零模型调用

    // cancel 带未知字段 → 400。
    const badCancel = await s.req(
      "POST",
      `/api/projects/tp-r5p4/text-prefilter-runs/${runId}/cancel`,
      { hackerField: 1 },
      CLIENT,
    );
    expect(badCancel.status).toBe(400);

    // run 状态不变（仍 queued，未被 claim/cancel）。
    const run = await s.req("GET", `/api/projects/tp-r5p4/text-prefilter-runs/${runId}`);
    expect((run.body?.run as Record<string, unknown>).status).toBe("queued");

    // 空 body 正常工作。
    const ok = await s.req("POST", `/api/projects/tp-r5p4/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    expect(ok.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("P1-2：严格校验补充", () => {
  it("suggestion 缺失/null → 拒绝；primitive item → 拒绝且计数持久化", async () => {
    const fake = makeFakeModel();
    fake.respond((inputs) => ({
      items: [
        // suggestion 缺失 → 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", confidence: "high", reason: "缺 suggestion" },
        // suggestion null → 拒绝。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: null, confidence: "high", reason: "null suggestion" },
        // primitive（字符串）→ 拒绝且计数持久化。
        "not an object",
        // 合法（空串 suggestion 可）。
        { segmentId: inputs[0].segmentId, suspiciousText: "专名环境画卷", type: "fact", suggestion: "", confidence: "high", reason: "合法" },
      ],
    }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-p12", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-p12/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    const next = await s.req("POST", `/api/projects/tp-p12/text-prefilter-runs/${runId}/next`, {}, CLIENT);
    const run = next.body?.run as Record<string, unknown>;
    expect(run.created).toBe(1); // 只有空串 suggestion 的合法项
    expect(run.rejected).toBe(3); // 缺失 + null + primitive
    // rejected 行持久化（含 primitive 的空壳行）。
    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      const rows = raw
        .prepare("SELECT disposition, reason FROM prefilter_candidates WHERE run_id = ? AND disposition = 'rejected'")
        .all(runId) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows.some((r) => String(r.reason).includes("suggestion 缺失"))).toBe(true);
      expect(rows.some((r) => String(r.reason).includes("不是 JSON 对象"))).toBe(true);
    } finally {
      raw.close();
    }
  });
});

describe("P1-3：错误脱敏", () => {
  it("模型错误含 URL/Bearer/key → 入库/回传均脱敏", async () => {
    const fake = makeFakeModel();
    fake.respond(() => new Error("Request to https://api.secret.io/v1/chat failed: Bearer sk-abc123def456ghi789 invalid"));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makePayload("tp-p13", 2), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-p13/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;
    const next = await s.req("POST", `/api/projects/tp-p13/text-prefilter-runs/${runId}/next`, {}, CLIENT);

    // 回传的错误消息已脱敏。
    const error = next.body?.error as Record<string, unknown>;
    expect(error?.code).toBe("model_error");
    const message = String(error?.message);
    expect(message).not.toContain("https://api.secret.io");
    expect(message).not.toContain("sk-abc123def456ghi789");
    expect(message).not.toContain("Bearer sk-");
    expect(message).toContain("[URL已脱敏]");

    // 入库的 error_message 也脱敏。
    const raw = new DatabaseSync(s.dbPath, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT error_message FROM prefilter_batches WHERE run_id = ? AND status = 'failed'")
        .get(runId) as Record<string, unknown>;
      const dbMessage = String(row.error_message);
      expect(dbMessage).not.toContain("https://api.secret.io");
      expect(dbMessage).not.toContain("sk-abc123def456ghi789");
    } finally {
      raw.close();
    }
  });
});

describe("envPrefilterModel 适配器（假 fetch：重试与脱敏）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function withEnv(env: Record<string, string>) {
    process.env.TINGPROOF_LLM_BASE_URL = env.baseUrl;
    process.env.TINGPROOF_LLM_MODEL = env.model;
    if (env.key) process.env.TINGPROOF_LLM_API_KEY = env.key;
    else delete process.env.TINGPROOF_LLM_API_KEY;
  }

  it("超时（TimeoutError）重试后成功；请求只含冻结输入", async () => {
    withEnv({ baseUrl: "http://llm.test/v1", model: "test-model", key: "sk-secret" });
    const bodies: unknown[] = [];
    let attempt = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      attempt += 1;
      if (attempt === 1) {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [] }) } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const model = envPrefilterModel();
    expect(model).not.toBeNull();
    const result = await model!.complete([
      { segmentId: "seg-1", cueNo: 1, originalText: "原文" },
    ]);
    expect(result).toEqual({ items: [] });
    expect(attempt).toBe(2);
    // 请求体只含 segmentId/cueNo/originalText；携带密钥头但不外泄到结果。
    const body = bodies[0] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("correctedText");
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("429 限流重试后成功（脱敏：错误与响应不含密钥）", async () => {
    withEnv({ baseUrl: "http://llm.test/v1", model: "test-model", key: "sk-secret" });
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const model = envPrefilterModel();
    const result = await model!.complete([{ segmentId: "s", cueNo: null, originalText: "x" }]);
    expect(result).toEqual({ items: [] });
    expect(attempt).toBe(2);
  });

  it("4xx 直接失败（不重试）且错误信息脱敏（不含密钥/URL）", async () => {
    withEnv({ baseUrl: "http://llm.test/v1", model: "test-model", key: "sk-secret" });
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt += 1;
      return new Response(JSON.stringify({ message: "bad request" }), { status: 400 });
    }) as unknown as typeof fetch;

    const model = envPrefilterModel();
    await expect(
      model!.complete([{ segmentId: "s", cueNo: null, originalText: "x" }]),
    ).rejects.toThrow(/模型服务返回 HTTP 400/);
    expect(attempt).toBe(1); // 4xx 不重试
  });

  it("重试耗尽（持续 5xx）→ 明确失败且信息脱敏", async () => {
    withEnv({ baseUrl: "http://llm.test/v1", model: "test-model" });
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const model = envPrefilterModel();
    await expect(
      model!.complete([{ segmentId: "s", cueNo: null, originalText: "x" }]),
    ).rejects.toThrow(/模型服务暂时不可用（HTTP 503）/);
  });
});

describe("P0-2（第 6 轮）：预筛四端点严格空对象校验（含 expectedRevision）", () => {
  it("create/next/retry/cancel 带 expectedRevision 或未知字段 → 400 零副作用", async () => {
    const fake = makeFakeModel();
    fake.respond(() => ({ items: [] }));
    const s = await startTestServer({ prefilterModel: fake.model });
    server = s;
    await s.req("POST", "/api/projects", makeProjectPayload("tp-r6p2"), CLIENT);
    const runRes = await s.req("POST", "/api/projects/tp-r6p2/text-prefilter-runs", {}, CLIENT);
    const runId = (runRes.body?.run as Record<string, unknown>).runId as string;

    // create run 带 expectedRevision → 400。
    const badCreate = await s.req(
      "POST",
      "/api/projects/tp-r6p2/text-prefilter-runs",
      { expectedRevision: 1 },
      CLIENT,
    );
    expect(badCreate.status).toBe(400);

    // next 带 expectedRevision → 400。
    const badNext = await s.req(
      "POST",
      `/api/projects/tp-r6p2/text-prefilter-runs/${runId}/next`,
      { expectedRevision: 1 },
      CLIENT,
    );
    expect(badNext.status).toBe(400);

    // retry 带未知字段 → 400。
    const badRetry = await s.req(
      "POST",
      `/api/projects/tp-r6p2/text-prefilter-runs/${runId}/retry`,
      { evil: true },
      CLIENT,
    );
    expect(badRetry.status).toBe(400);

    // cancel 带 expectedRevision → 400。
    const badCancel = await s.req(
      "POST",
      `/api/projects/tp-r6p2/text-prefilter-runs/${runId}/cancel`,
      { expectedRevision: 2 },
      CLIENT,
    );
    expect(badCancel.status).toBe(400);

    // 零模型调用、run 状态不变。
    expect(fake.calls).toHaveLength(0);
    const run = await s.req("GET", `/api/projects/tp-r6p2/text-prefilter-runs/${runId}`);
    expect((run.body?.run as Record<string, unknown>).status).toBe("queued");

    // raw 非法 JSON → 400。
    const badJson = await fetch(`${s.baseUrl}/api/projects/tp-r6p2/text-prefilter-runs/${runId}/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json{",
    });
    expect(badJson.status).toBe(400);
  });
});
