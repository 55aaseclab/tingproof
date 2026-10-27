// @vitest-environment jsdom
/**
 * V1.1.4 机器文本预筛客户端 UI（PRD §3.4.9 / AC-069~071）：
 * - 未配置：入口显示“机器预筛未配置”与服务端环境变量名；开始按钮不发起 run 请求；
 * - 已配置：显式点击“开始预筛”才创建 run（先刷新保存队列）；批次循环至完成，
 *   每批刷新疑点；完成显示 新增/复用/拒绝；
 * - 批次失败：显示“重试失败批次”→ prefilterRetry；取消 → prefilterCancel（批次边界）；
 * - 机器建议展示：字幕行“机器建议 ×N”、疑点卡“机器建议 · 高/中/低”+ 可疑片段/建议/理由；
 * - 未显式点击开始时无 createPrefilterRun 调用。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../src/store/db.js";
import {
  createPrefilterRun,
  getLatestPrefilterRun,
  getPrefilterConfig,
  getProjectIssues,
  prefilterCancel,
  prefilterNext,
  prefilterRetry,
} from "../src/store/repo.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { IssueRecord, PrefilterConfigDto, PrefilterRunDto, ProjectMeta, SegmentRecord } from "../src/store/types.js";

vi.mock("../src/store/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/repo.js")>();
  return {
    ...actual,
    getPrefilterConfig: vi.fn(actual.getPrefilterConfig),
    createPrefilterRun: vi.fn(actual.createPrefilterRun),
    prefilterNext: vi.fn(actual.prefilterNext),
    prefilterRetry: vi.fn(actual.prefilterRetry),
    prefilterCancel: vi.fn(actual.prefilterCancel),
    getProjectIssues: vi.fn(actual.getProjectIssues),
    getLatestPrefilterRun: vi.fn(actual.getLatestPrefilterRun),
    updateSegment: vi.fn(actual.updateSegment),
  };
});

const { TimelineSpy } = vi.hoisted(() => ({
  TimelineSpy: vi.fn((_props: { segments: unknown }) => <div data-testid="timeline" />),
}));
vi.mock("../src/ui/Timeline.js", async () => {
  const { memo } = await import("react");
  return { Timeline: memo(TimelineSpy) };
});

function makeSeg(id: string, startMs: number, endMs: number): SegmentRecord {
  return {
    segmentId: id,
    projectId: "tp-pf-ui",
    cueNo: null,
    startMs,
    endMs,
    originalText: `原文${id}`,
    correctedText: `校对${id}`,
    status: "unreviewed",
    revisionNo: 1,
    updatedAt: 0,
  };
}

const SEGMENTS = [makeSeg("seg-a", 1000, 2000), makeSeg("seg-b", 2000, 3000)];

const MACHINE_ISSUE: IssueRecord = {
  issueId: "mp-issue-1",
  projectId: "tp-pf-ui",
  segmentId: "seg-a",
  startMs: 1000,
  endMs: 2000,
  type: "proper_noun",
  severity: "warning",
  note: "疑似书名",
  status: "open",
  createdAt: 5,
  resolvedAt: null,
  origin: "machine_prefilter",
  machineMetadata: {
    provider: "fake",
    model: "fake-model",
    promptVersion: "text-suspicion-v1",
    confidence: "high",
    suspiciousText: "原文环境画卷",
    suggestion: "环境画卷（书名）",
    reason: "疑似书名专名",
  },
};

function makeMeta(): ProjectMeta {
  return {
    projectId: "tp-pf-ui",
    name: "预筛 UI 测试",
    normalizedStem: "预筛 UI 测试",
    createdAt: 1,
    updatedAt: 1,
    media: {
      audioName: "a.mp3",
      audioSize: 1,
      audioLastModified: 1,
      audioFingerprint: "fp",
      srtFileName: "a.srt",
      srtSha256: "x",
      mediaKey: "k",
      durationMs: null,
      srtHandle: null,
      audioHandle: null,
    },
    playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
  };
}

function makeRun(overrides: Partial<PrefilterRunDto> = {}): PrefilterRunDto {
  return {
    runId: "pfr-ui-1",
    projectId: "tp-pf-ui",
    status: "queued",
    provider: "fake",
    model: "fake-model",
    promptVersion: "text-suspicion-v1",
    total: 4,
    processed: 0,
    created: 0,
    reused: 0,
    rejected: 0,
    failedBatches: 0,
    startedAt: null,
    completedAt: null,
    batches: [],
    ...overrides,
  };
}

function renderWorkbench(issues: IssueRecord[] = []) {
  return render(
    <Workbench
      meta={makeMeta()}
      audioFile={null}
      audioNotice={null}
      initialSegments={SEGMENTS}
      initialIssues={issues}
      onBack={vi.fn()}
      onRelocated={vi.fn()}
    />,
  );
}

beforeAll(() => {
  // jsdom 媒体/滚动桩（与其他 Workbench 测试一致）。
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    void this;
  });
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.requestAnimationFrame = vi.fn(() => 1 as unknown as number);
  globalThis.cancelAnimationFrame = vi.fn();
});

beforeEach(() => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
  vi.mocked(getPrefilterConfig).mockClear();
  vi.mocked(createPrefilterRun).mockClear();
  vi.mocked(prefilterNext).mockClear();
  vi.mocked(prefilterRetry).mockClear();
  vi.mocked(prefilterCancel).mockClear();
  vi.mocked(getProjectIssues).mockClear();
  vi.mocked(getLatestPrefilterRun).mockClear();
});

afterEach(() => cleanup());

describe("PrefilterPanel 入口与降级（AC-071）", () => {
  it("未配置：显示配置提示与服务端环境变量名；无“开始预筛”run 请求", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: false,
      provider: "openai-compatible",
      model: "(未配置)",
      promptVersion: "text-suspicion-v1",
    });
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    expect(await screen.findByText("机器预筛未配置。")).toBeTruthy();
    expect(screen.getByText(/TINGPROOF_LLM_BASE_URL/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始预筛" })).toBeNull();
    expect(createPrefilterRun).not.toHaveBeenCalled();
  });

  it("已配置：说明发送范围；未点击开始前无 run 创建请求", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    expect(
      await screen.findByText(/只发送原始机器转写文本，不发送音频和人工校对稿/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始预筛" })).toBeTruthy();
    expect(createPrefilterRun).not.toHaveBeenCalled(); // 未显式点击 → 零请求
  });
});

describe("PrefilterPanel 运行循环（AC-070）", () => {
  it("开始 → 批次循环至完成：每批刷新疑点、显示 新增/复用/拒绝", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running", processed: 0 }));
    vi.mocked(prefilterNext)
      .mockResolvedValueOnce({
        run: makeRun({ status: "running", processed: 2, created: 2 }),
        revision: 2,
        error: null,
        processed: true,
      })
      .mockResolvedValueOnce({
        run: makeRun({ status: "completed", processed: 4, created: 3, reused: 1, rejected: 2 }),
        revision: 3,
        error: null,
        processed: true,
      });

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 3 · 复用 1 · 拒绝 2/).length).toBeGreaterThan(0);
    });
    expect(createPrefilterRun).toHaveBeenCalledTimes(1);
    expect(prefilterNext).toHaveBeenCalledTimes(2);
    // 每批刷新疑点（创建 + 每批各一次，共 3 次）。
    expect(getProjectIssues).toHaveBeenCalledTimes(3);
  });

  it("批次失败 → 显示失败信息与“重试失败批次”；重试后完成", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running" }));
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "partial", processed: 2, failedBatches: 1 }),
      revision: 2,
      error: { code: "model_error", message: "模型服务暂时不可用（HTTP 503）" },
      processed: true,
    });
    vi.mocked(prefilterRetry).mockResolvedValue({
      run: makeRun({ status: "completed", processed: 4, created: 1 }),
      revision: 3,
      error: null,
      processed: true,
    });

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    await waitFor(() => {
      expect(screen.getByText(/批次失败：模型服务暂时不可用/)).toBeTruthy();
    });
    const retryBtn = await screen.findByRole("button", { name: "重试失败批次" });
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 1/).length).toBeGreaterThan(0);
    });
    expect(prefilterRetry).toHaveBeenCalledTimes(1);
  });

  it("运行中取消：调用 prefilterCancel，状态显示已取消", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running" }));
    let releaseNext!: () => void;
    vi.mocked(prefilterNext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNext = () =>
            resolve({ run: makeRun({ status: "running", processed: 2 }), revision: 2, error: null, processed: true });
        }),
    );
    vi.mocked(prefilterCancel).mockResolvedValue(
      makeRun({ status: "cancelled", processed: 2 }),
    );

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    // 等首个批次真正开始（prefilterNext 被调用、releaseNext 已赋值）再取消。
    await waitFor(() => expect(prefilterNext).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    releaseNext(); // 当前批次完成（批次边界）后循环停止
    await waitFor(() => {
      expect(prefilterCancel).toHaveBeenCalledWith("tp-pf-ui", "pfr-ui-1");
    });
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 2\/4）/).length).toBeGreaterThan(0);
    });
  });
});

describe("P0-2：processed=false 不忙轮询", () => {
  it("连续 processed=false → 停止循环（不产生无界同步调用），显示「继续」按钮", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running" }));
    // processed=false：批次被其他客户端持有。
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "running", processed: 2 }),
      revision: 2,
      error: null,
      processed: false,
    });

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    // 显示"另一客户端正在处理"提示 + 继续按钮。
    await waitFor(() => {
      expect(screen.getByText(/另一客户端正在处理当前批次/)).toBeTruthy();
    });
    // 关键断言：next 只被调了 1 次（不忙轮询）。
    expect(prefilterNext).toHaveBeenCalledTimes(1);
    // 继续按钮存在（可恢复）。
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
  });

  it("持有者完成后可继续：继续按钮 → next 成功 → 完成", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running" }));
    vi.mocked(prefilterNext)
      .mockResolvedValueOnce({
        run: makeRun({ status: "running", processed: 2 }),
        revision: 2,
        error: null,
        processed: false,
      })
      .mockResolvedValueOnce({
        run: makeRun({ status: "completed", processed: 4, created: 2 }),
        revision: 3,
        error: null,
        processed: true,
      });

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 2/).length).toBeGreaterThan(0);
    });
    expect(prefilterNext).toHaveBeenCalledTimes(2);
  });
});

describe("P0-3：刷新恢复最近 run", () => {
  it("打开面板 → getLatestPrefilterRun 恢复状态；继续按钮可用", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "partial", processed: 20, failedBatches: 1 }),
    );

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    // 入口状态恢复为"失败可重试"（非"未运行"）。
    await waitFor(() => {
      expect(screen.getAllByText(/失败可重试/).length).toBeGreaterThan(0);
    });
    // 继续预筛/重试失败批次按钮可见（恢复路径）。
    expect(screen.getByRole("button", { name: "重试失败批次" })).toBeTruthy();
    // 未显式点击前零模型请求。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).not.toHaveBeenCalled();
  });

  it("无 run → 诚实显示『未运行』，不创建", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    expect(screen.getByText("未运行")).toBeTruthy();
    expect(createPrefilterRun).not.toHaveBeenCalled();
  });
});

describe("P1-1：配置读取失败显示", () => {
  it("getPrefilterConfig reject → 显示可重试错误（不卡在『正在读取』）", async () => {
    vi.mocked(getPrefilterConfig).mockRejectedValue(new Error("暂时无法连接服务"));
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("读取预筛配置失败");
      expect(screen.getByRole("alert").textContent).toContain("暂时无法连接服务");
    });
    // 重试按钮存在。
    expect(screen.getByRole("button", { name: "重试读取配置" })).toBeTruthy();
    // 不卡在"正在读取"。
    expect(screen.queryByText("正在读取预筛配置…")).toBeNull();
  });
});

describe("P0-2（第 2 轮）：面板每次打开都刷新 latest；latest 失败显错", () => {
  it("首次 latest reject → 显示读取失败 + 重试按钮（不冒充无 run）", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockRejectedValueOnce(new Error("网络不可达"));
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/读取预筛状态失败/)).toBeTruthy();
    });
    // P0-1（第 3 轮）：入口 hint 也必须显示"状态读取失败"（不冒充"未运行"）。
    expect(screen.getByText(/读取预筛状态失败/)).toBeTruthy();
    const statusHint = document.querySelector(".prefilter-entry > .hint");
    expect(statusHint?.textContent?.trim()).toBe("状态读取失败");
    // 零模型/create 调用。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).not.toHaveBeenCalled();
  });

  it("关闭后另一端状态变化，重新打开会刷新 latest", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    // 首次打开：无 run。
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(null);
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => expect(screen.getByText("未运行")).toBeTruthy());

    // 关闭面板。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    // 另一端创建了 run → 重新打开 → latest 刷新为 partial。
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "partial", processed: 20, failedBatches: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getAllByText(/失败可重试/).length).toBeGreaterThan(0);
    });
    // 仍然零模型/create 调用（只读 GET）。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).not.toHaveBeenCalled();
  });
});

describe("P0-3（第 2 轮）：配置三元比较（provider+model+promptVersion）", () => {
  it("仅 provider 变化 → 配置不匹配语义 + 禁止继续旧 run + 用当前配置开始新预筛", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "new-provider", // ← provider 变了
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", provider: "old-provider", model: "fake-model", promptVersion: "text-suspicion-v1" }),
    );
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/用当前配置开始新预筛/)).toBeTruthy();
    });
    // 继续预筛按钮不可见（配置不匹配）。
    expect(screen.queryByRole("button", { name: "继续预筛" })).toBeNull();
    // 未显式操作前零模型请求。
    expect(prefilterNext).not.toHaveBeenCalled();
  });

  it("仅 promptVersion 变化 → 配置不匹配语义", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v2", // ← promptVersion 变了
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "partial", provider: "fake", model: "fake-model", promptVersion: "text-suspicion-v1" }),
    );
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/用当前配置开始新预筛/)).toBeTruthy();
    });
    // 重试失败批次按钮不可见（配置不匹配）。
    expect(screen.queryByRole("button", { name: "重试失败批次" })).toBeNull();
  });

  it("三元全匹配 → 继续预筛按钮可见", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", provider: "fake", model: "fake-model", promptVersion: "text-suspicion-v1" }),
    );
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续预筛" })).toBeTruthy();
    });
  });
});

describe("P1-2（第 2 轮）：机器疑点刷新失败诚实反馈", () => {
  it("最终批刷新失败 → 显示读取错误 + 重试按钮（不回滚 run、不触发模型重跑）", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running" }));
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "completed", processed: 4, created: 2 }),
      revision: 2,
      error: null,
      processed: true,
    });
    // 最终批后 getProjectIssues 失败。
    const { getProjectIssues } = await import("../src/store/repo.js");
    vi.mocked(getProjectIssues).mockRejectedValue(new Error("读取疑点失败"));

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    // run 完成显示，但读取疑点失败错误也可见。
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 2/).length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByText(/读取最新疑点失败/)).toBeTruthy();
    });
    // 重试读取疑点按钮存在。
    expect(screen.getByRole("button", { name: "重试读取疑点" })).toBeTruthy();
    // 不触发模型重跑。
    expect(prefilterNext).toHaveBeenCalledTimes(1); // 只处理了一批
  });
});

describe("机器建议展示（AC-069/071）", () => {
  it("字幕行显示“机器建议 ×N”；疑点卡显示机器建议、置信度、可疑片段、建议写法与理由", async () => {
    const utils = renderWorkbench([MACHINE_ISSUE]);
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    expect(within(row("seg-a")).getByText("机器建议 ×1")).toBeTruthy();
    expect(within(row("seg-a")).getByText("⚑ 疑点 ×1")).toBeTruthy();

    // 疑点卡：机器建议徽标 + 元数据展示。
    expect(screen.getByText("机器建议 · 高")).toBeTruthy();
    expect(screen.getByText(/可疑片段：/)).toBeTruthy();
    expect(screen.getByText(/原文环境画卷/)).toBeTruthy();
    expect(screen.getByText(/建议写法：环境画卷（书名）/)).toBeTruthy();
    expect(screen.getByText(/机器理由：疑似书名专名/)).toBeTruthy();
  });
});

describe("P0-2（第 3 轮）：flush 后检查 save.state，失败拒绝创建 run", () => {
  it("flush 内写失败但 promise resolve → createPrefilterRun/prefilterNext 均 0 次", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    vi.mocked(createPrefilterRun).mockClear();
    vi.mocked(prefilterNext).mockClear();

    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });

    // 模拟 flush 失败：直接 mock repo 中 updateSegment 失败使 SaveCoordinator 进 failed。
    const { updateSegment } = await import("../src/store/repo.js");
    vi.mocked(updateSegment).mockRejectedValueOnce(new Error("保存失败"));

    // 先输入文字（产生 pending 草稿）。
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const editor = within(row("seg-b")).getByRole("textbox") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(editor, "保存会失败的草稿");
    fireEvent.input(editor, { target: { value: "保存会失败的草稿" } });

    // 点击开始预筛——flush 内部写失败但 promise resolve（SaveCoordinator 的行为）。
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("保存队列尚未成功");
    });
    // 关键断言：createPrefilterRun 和 prefilterNext 均未被调用。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).not.toHaveBeenCalled();
  });
});

describe("P0-3（第 3 轮）：latest 竞态不覆盖新 run", () => {
  it("打开面板 latest 挂起 → 开始新 run → 释放旧 latest=null → 仍保持新 run", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    // latest 挂起（不 resolve）。
    let releaseLatest!: (value: PrefilterRunDto | null) => void;
    vi.mocked(getLatestPrefilterRun).mockImplementationOnce(
      () => new Promise((resolve) => { releaseLatest = resolve; }),
    );
    vi.mocked(createPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", runId: "pfr-new-run" }),
    );
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "completed", runId: "pfr-new-run", processed: 4, created: 2 }),
      revision: 2,
      error: null,
      processed: true,
    });

    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    void utils;
    // 打开面板——latest 挂起。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });

    // 开始新 run（递增代次）→ 拿到新 run。
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 2/).length).toBeGreaterThan(0);
    });

    // 现在释放旧 latest=null——不得覆盖新 run 的完成状态。
    releaseLatest(null);
    await new Promise((r) => setTimeout(r, 50));
    // 界面仍保持新 run 的完成状态（不回到未运行/旧状态）。
    expect(screen.getAllByText(/已完成 新增 2/).length).toBeGreaterThan(0);
  });
});

describe("P1-1（第 3 轮）：每次打开都刷新 config", () => {
  it("关闭→服务端配置变化→重开 → 读取新三元配置且零 create/next", async () => {
    // 首次打开：旧配置。
    vi.mocked(getPrefilterConfig).mockResolvedValueOnce({
      available: true,
      provider: "old-provider",
      model: "old-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/old-model/)).toBeTruthy();
    });

    // 关闭面板。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));

    // 服务端配置变化。
    vi.mocked(getPrefilterConfig).mockResolvedValueOnce({
      available: true,
      provider: "new-provider",
      model: "new-model",
      promptVersion: "text-suspicion-v2",
    });

    // 重新打开 → 刷新为新配置。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/new-model/)).toBeTruthy();
      expect(screen.getByText(/new-provider/)).toBeTruthy();
    });
    // 零 create/next（只读刷新）。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).not.toHaveBeenCalled();
  });
});

describe("P1-2（第 3 轮）：waiting + 配置漂移 → 继续按钮受三元门禁", () => {
  it("waitingForOtherClient 且 provider 漂移 → 继续按钮不可见，只有新预筛", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "new-provider",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", provider: "old-provider", model: "fake-model", promptVersion: "text-suspicion-v1" }),
    );
    vi.mocked(createPrefilterRun).mockResolvedValue(makeRun({ status: "running" }));
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "running", processed: 2, provider: "old-provider" }),
      revision: 2,
      error: null,
      processed: false,
    });

    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={SEGMENTS}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    // latest 已有旧 run（provider 漂移）→ 按钮显示"用当前配置开始新预筛"。
    await screen.findByText(/用当前配置开始新预筛/);
    fireEvent.click(screen.getByRole("button", { name: "用当前配置开始新预筛" }));

    // waiting 状态出现。
    await waitFor(() => {
      expect(screen.getByText(/另一客户端正在处理/)).toBeTruthy();
    });
    // P1-2：配置不匹配时"继续"按钮不可见。
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续预筛" })).toBeNull();
    // 但"用当前配置开始新预筛"按钮可见。
    expect(screen.getByText(/用当前配置开始新预筛/)).toBeTruthy();
  });
});

describe("P0-1（第 4 轮）：重开期间旧配置不可用 + latest 独立代次", () => {
  it("重开后新 config 未决时：旧配置/开始按钮不可用、零 create/next", async () => {
    // 首次打开：旧配置。
    vi.mocked(getPrefilterConfig).mockResolvedValueOnce({
      available: true,
      provider: "old-provider",
      model: "old-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    const utils = renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => expect(screen.getByText(/old-model/)).toBeTruthy());

    // 关闭面板。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));

    // 第二次打开：config 挂起（未决）。
    let releaseConfig!: (value: PrefilterConfigDto) => void;
    vi.mocked(getPrefilterConfig).mockImplementationOnce(
      () => new Promise((resolve) => { releaseConfig = resolve; }),
    );
    vi.mocked(createPrefilterRun).mockClear();
    vi.mocked(prefilterNext).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    // P0-1（第 4 轮）：config 立即置 null → 显示"正在读取"（旧配置不可见）。
    await waitFor(() => {
      expect(screen.getByText("正在读取预筛配置…")).toBeTruthy();
    });
    // 旧配置不可见。
    expect(screen.queryByText(/old-model/)).toBeNull();
    // 开始按钮不可见（config=null 走 loading 分支）。
    expect(screen.queryByRole("button", { name: "开始预筛" })).toBeNull();
    // 零 create/next。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).not.toHaveBeenCalled();

    // 释放新 config → 可用。
    releaseConfig({ available: true, provider: "new-provider", model: "new-model", promptVersion: "text-suspicion-v1" });
    await waitFor(() => {
      expect(screen.getByText(/new-model/)).toBeTruthy();
    });
    void utils;
  });

  it("第一次 open 的旧 latest 在第二次 open 后迟到不覆盖第二次状态", async () => {
    // 首次打开：latest 挂起。
    let releaseFirstLatest!: (value: PrefilterRunDto | null) => void;
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirstLatest = resolve; }),
    );
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByText("正在读取预筛配置…");
    // config 就绪 → fetchLatestRun（第一次 latest 发出）。
    await waitFor(() => expect(getLatestPrefilterRun).toHaveBeenCalledTimes(1));

    // 关闭面板（第一次 latest 仍挂起）。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));

    // 第二次打开：config 重新读取 → 第二次 latest 返回新 run。
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "completed", runId: "pfr-second", created: 5 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 5/).length).toBeGreaterThan(0);
    });

    // 第一次 latest 迟到返回 null——不得覆盖第二次的 completed 状态。
    releaseFirstLatest(null);
    await new Promise((r) => setTimeout(r, 50));
    // 界面仍保持第二次的完成状态。
    expect(screen.getAllByText(/已完成 新增 5/).length).toBeGreaterThan(0);
  });
});
