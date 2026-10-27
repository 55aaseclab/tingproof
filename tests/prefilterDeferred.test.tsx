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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import type { IssueRecord, PrefilterRunDto, ProjectMeta, SegmentRecord } from "../src/store/types.js";

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


describe("P0-2（第 4 轮）：取消精确指向活动 run", () => {
  it("旧 run 存在时开始新预筛 → 新 runId 未得到前取消按钮不可见；得到后取消指向新 runId", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    // 面板恢复一个旧 run。
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", runId: "pfr-old", processed: 10 }),
    );
    vi.mocked(prefilterCancel).mockClear();
    vi.mocked(prefilterCancel).mockResolvedValue(
      makeRun({ status: "cancelled", runId: "pfr-new", processed: 20 }),
    );

    // 新 run 创建挂起（模拟网络延迟，让 busy=true 但 activeRunId 尚未设置）。
    let releaseCreate!: (value: PrefilterRunDto) => void;
    vi.mocked(createPrefilterRun).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCreate = resolve; }),
    );
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "running", runId: "pfr-new", processed: 20 }),
      revision: 2,
      error: null,
      processed: true,
    });

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    // 等 config 就绪。
    await screen.findByRole("button", { name: "开始预筛" });
    // 旧 run 显示为 running。
    await waitFor(() => {
      expect(screen.getAllByText(/运行中 已处理 10/).length).toBeGreaterThan(0);
    });

    // 开始新预筛——新 runId 未得到（createPrefilterRun 挂起）。
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    // 等 createPrefilterRun 被调用（flush 完成后），此时 busy=true 且 releaseCreate 已赋值。
    await waitFor(() => {
      expect(createPrefilterRun).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText("预筛中…")).toBeTruthy();
    });
    // P0-2（第 4 轮）：取消按钮不可见（activeRunId=null，不会取消旧 pfr-old）。
    expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();

    // 释放 createPrefilterRun → 新 run 得到 → 取消按钮出现。
    releaseCreate(makeRun({ status: "running", runId: "pfr-new", processed: 20 }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /取消（批次边界生效）/ })).toBeTruthy();
    });

    // 点击取消 → prefilterCancel 精确指向新 runId "pfr-new"（不是旧 "pfr-old"）。
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(prefilterCancel).toHaveBeenCalledWith("tp-pf-ui", "pfr-new");
    });
    expect(prefilterCancel).not.toHaveBeenCalledWith("tp-pf-ui", "pfr-old");
    // 最终 UI 显示 cancelled。
    await waitFor(() => {
      expect(screen.getAllByText(/已取消/).length).toBeGreaterThan(0);
    });
  });

  it("迟到 mutation 不覆盖取消：取消后 release 的 next 不把 UI 拉回 running", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    vi.mocked(createPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", runId: "pfr-cancel-race" }),
    );
    // next 挂起。
    let releaseNext!: (value: { run: PrefilterRunDto; revision: number; error: null; processed: boolean }) => void;
    vi.mocked(prefilterNext).mockImplementationOnce(
      () => new Promise((resolve) => { releaseNext = resolve; }),
    );
    vi.mocked(prefilterCancel).mockResolvedValue(
      makeRun({ status: "cancelled", runId: "pfr-cancel-race", processed: 20 }),
    );

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    // 等 next 被调用（批次处理中）。
    await waitFor(() => expect(prefilterNext).toHaveBeenCalled());
    // 取消按钮出现（activeRunId 已设置）。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /取消（批次边界生效）/ })).toBeTruthy();
    });

    // 取消按钮可见且点击。
    const cancelBtn = screen.getByRole("button", { name: /取消（批次边界生效）/ });
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(prefilterCancel).toHaveBeenCalledWith("tp-pf-ui", "pfr-cancel-race");
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getAllByText(/已取消/).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // 迟到的 next 返回 running——不得覆盖 cancelled 状态。
    releaseNext({ run: makeRun({ status: "running", runId: "pfr-cancel-race", processed: 20 }), revision: 2, error: null, processed: true });
    await new Promise((r) => setTimeout(r, 50));
    // 仍显示 cancelled（非 running）。
    expect(screen.getAllByText(/已取消/).length).toBeGreaterThan(0);
    const statusText = document.querySelector(".prefilter-entry > .hint")?.textContent;
    expect(statusText).not.toContain("运行中 已处理");
  });
});

describe("P0-3（第 6 轮）：cancel 失败不永久卡 busy", () => {
  it("cancel deferred reject → busy=false（不锁死）、error 可见、可重试", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    vi.mocked(createPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", runId: "pfr-r6c" }),
    );
    vi.mocked(prefilterNext).mockResolvedValue({
      run: makeRun({ status: "completed", runId: "pfr-r6c", created: 1 }),
      revision: 2,
      error: null,
      processed: true,
    });
    vi.mocked(prefilterCancel).mockRejectedValueOnce(new Error("取消请求失败（网络不可达）"));

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));

    // 等 next 完成（run completed → busy=false）。
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 1/).length).toBeGreaterThan(0);
    });

    // 重新触发 busy：再点"开始预筛"（新 run + deferred next）。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-r6c2" }),
    );
    vi.mocked(prefilterNext).mockImplementationOnce(
      () => new Promise(() => undefined), // 永远挂起
    );
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => expect(prefilterNext).toHaveBeenCalled());

    // busy=true 期间点取消 → cancel 失败。
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("取消请求失败");
    });

    // P0-3 关键：busy=false（不永久锁死）——开始按钮可用。
    expect(screen.getByRole("button", { name: "开始预筛" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "开始预筛" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("P0-3（第 6 轮）：resume/retry 取消按钮立即可见 + 操作代次", () => {
  it("resume 点击后取消按钮立即可见并精确 cancel 该 run（next 永远挂起）", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(
      makeRun({ status: "running", runId: "pfr-r6r", processed: 10 }),
    );
    vi.mocked(prefilterNext).mockImplementation(
      () => new Promise(() => undefined), // 永远挂起
    );
    vi.mocked(prefilterCancel).mockResolvedValue(
      makeRun({ status: "cancelled", runId: "pfr-r6r", processed: 10 }),
    );

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    const resumeBtn = await screen.findByRole("button", { name: "继续预筛" });
    fireEvent.click(resumeBtn);

    // P0-3：取消按钮立即可见（activeRunId 请求前已设置）。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /取消（批次边界生效）/ })).toBeTruthy();
    });

    // 取消 → prefilterCancel 精确指向 pfr-r6r。
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(prefilterCancel).toHaveBeenCalledWith("tp-pf-ui", "pfr-r6r");
    });
    await waitFor(() => {
      expect(screen.getAllByText(/已取消/).length).toBeGreaterThan(0);
    });
  });

  it("取消旧 run 后启动新 run → 新 run 完成后旧 next 永远不覆盖", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    // 第一次 create → next 永远挂起。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-old-r6" }),
    );
    vi.mocked(prefilterNext).mockImplementationOnce(
      () => new Promise(() => undefined), // 永远挂起
    );
    vi.mocked(prefilterCancel).mockResolvedValue(
      makeRun({ status: "cancelled", runId: "pfr-old-r6" }),
    );
    // 第二次 create → next 正常完成。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-new-r6" }),
    );
    vi.mocked(prefilterNext).mockResolvedValueOnce({
      run: makeRun({ status: "completed", runId: "pfr-new-r6", created: 3 }),
      revision: 3,
      error: null,
      processed: true,
    });

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });

    // 第一次开始 → next 挂起 → busy=true。
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => expect(prefilterNext).toHaveBeenCalled());

    // 取消旧 run → cancelled → busy=false。
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/已取消/).length).toBeGreaterThan(0);
    });

    // 启动新 run → 正常完成。
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 3/).length).toBeGreaterThan(0);
    }, { timeout: 5000 });
  });
});

describe("P1（第 9 轮）：latest 错误恢复与迟到不清新错误", () => {
  it("latest 首次 reject → 入口『状态读取失败』；同一面板显式 start 成功 completed → 完成态、旧错误块消失", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    // 首次 latest 读取失败 → 入口不冒充"未运行"。
    vi.mocked(getLatestPrefilterRun).mockRejectedValueOnce(new Error("网络不可达"));
    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/读取预筛状态失败/)).toBeTruthy();
    });
    const statusHint = document.querySelector(".prefilter-entry > .hint");
    expect(statusHint?.textContent?.trim()).toBe("状态读取失败");

    // 同一面板（不关闭）显式 start → run 成功 completed。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(makeRun({ status: "running" }));
    vi.mocked(prefilterNext).mockResolvedValueOnce({
      run: makeRun({ status: "completed", processed: 4, created: 1 }),
      revision: 2,
      error: null,
      processed: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 1/).length).toBeGreaterThan(0);
    });

    // 入口为完成态（不再是"状态读取失败"）；旧错误块消失。
    const hintAfter = document.querySelector(".prefilter-entry > .hint");
    expect(hintAfter?.textContent).toContain("已完成 新增 1");
    expect(screen.queryByText(/读取预筛状态失败/)).toBeNull();
  });

  it("旧 GET 迟到 resolve / 旧 operation 迟到落库：均不得清新错误（错误仍在，取消 run 计数照常同步）", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    // 打开面板：latest#1 恢复一个 running run（使「继续预筛」可用）。
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-err-race", processed: 0 }),
    );
    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    const resumeBtn = await screen.findByRole("button", { name: "继续预筛" });

    // 旧 operation：继续预筛 → next 挂起（操作代次 g2）。
    let releaseNext!: (value: PrefilterRunDto) => void;
    vi.mocked(prefilterNext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNext = (run) => resolve({ run, revision: 2, error: null, processed: true });
        }),
    );
    fireEvent.click(resumeBtn);
    await waitFor(() => expect(prefilterNext).toHaveBeenCalledTimes(1));

    // 取消（g3）→ UI cancelled。
    vi.mocked(prefilterCancel).mockResolvedValueOnce(
      makeRun({ status: "cancelled", runId: "pfr-err-race", processed: 0 }),
    );
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 0\/4）/).length).toBeGreaterThan(0);
    });

    // 关闭再打开：latest#2 挂起（将成为"旧 GET"）。
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    let releaseOldLatest!: (value: PrefilterRunDto | null) => void;
    vi.mocked(getLatestPrefilterRun).mockImplementationOnce(
      () => new Promise((resolve) => { releaseOldLatest = resolve; }),
    );
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => expect(getLatestPrefilterRun).toHaveBeenCalledTimes(2));

    // 关闭再打开：latest#3 失败 → 新错误（状态读取失败 + 错误块可见）。
    vi.mocked(getLatestPrefilterRun).mockRejectedValueOnce(new Error("第二次读取失败"));
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await waitFor(() => {
      expect(screen.getByText(/读取预筛状态失败：第二次读取失败/)).toBeTruthy();
    });

    // 旧 GET（latest#2）迟到 resolve null → 代次不匹配丢弃 → 新错误不清。
    releaseOldLatest(null);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/读取预筛状态失败：第二次读取失败/)).toBeTruthy();
    expect(document.querySelector(".prefilter-entry > .hint")?.textContent?.trim()).toBe("状态读取失败");

    // 旧 operation（g2 的 next）迟到落库：issues 刷新 + 只读同步 latest 最终计数，
    // 但不得清掉新错误。
    const latestCallsBefore = vi.mocked(getLatestPrefilterRun).mock.calls.length;
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "cancelled", runId: "pfr-err-race", processed: 4, created: 2 }),
    );
    releaseNext(makeRun({ status: "cancelled", runId: "pfr-err-race", processed: 4, created: 2 }));
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 4\/4）/).length).toBeGreaterThan(0);
    });
    // 只读 latest 恰好一次（迟到批次触发的同步）。
    expect(vi.mocked(getLatestPrefilterRun).mock.calls.length).toBe(latestCallsBefore + 1);
    // 新错误仍在（未被旧 operation 的迟到完成清除）。
    expect(screen.getByText(/读取预筛状态失败：第二次读取失败/)).toBeTruthy();
    expect(document.querySelector(".prefilter-entry > .hint")?.textContent?.trim()).toBe("状态读取失败");
    // 不轮询、不 create、不额外 next。
    expect(createPrefilterRun).not.toHaveBeenCalled();
    expect(prefilterNext).toHaveBeenCalledTimes(1);
    expect(prefilterCancel).toHaveBeenCalledTimes(1);
  });
});

describe("P1（第 9/10 轮）：cancel 后迟到已落库 batch 的疑点与最终计数同步", () => {
  it("响应反序：cancel 请求挂起→迟到 next processed=true 先返回→cancel stale 快照后返回：恰好补一次 latest 恢复最终计数且保持 cancelled", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    // 开始预筛：create 返回 running run，首个 next 挂起。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-cxl-order", processed: 0 }),
    );
    let releaseNext!: (value: PrefilterRunDto) => void;
    vi.mocked(prefilterNext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNext = (run) => resolve({ run, revision: 2, error: null, processed: true });
        }),
    );
    // cancel 请求挂起（响应未返回——迟到批次将先于它到达）。
    let releaseCancel!: (value: PrefilterRunDto) => void;
    vi.mocked(prefilterCancel).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCancel = resolve; }),
    );

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => expect(prefilterNext).toHaveBeenCalledTimes(1));

    // cancel 已发出但响应挂起。
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => expect(prefilterCancel).toHaveBeenCalledTimes(1));

    const issuesCallsBefore = vi.mocked(getProjectIssues).mock.calls.length;
    const latestCallsBefore = vi.mocked(getLatestPrefilterRun).mock.calls.length;

    // 迟到 next processed=true 先返回：issues 只读刷新一次；cancel 响应未落地 →
    // 不得提前拉 latest（挂起同步，等 cancel 响应返回后补做）。
    releaseNext(makeRun({ status: "cancelled", runId: "pfr-cxl-order", processed: 4, created: 2 }));
    await waitFor(() => {
      expect(vi.mocked(getProjectIssues).mock.calls.length).toBe(issuesCallsBefore + 1);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(getLatestPrefilterRun).mock.calls.length).toBe(latestCallsBefore);

    // cancel 响应后返回，携带 materialize 前旧快照（0/4）——不得停留在旧计数：
    // 响应落地后补做恰好一次只读 latest，恢复最终计数且 status 保持 cancelled。
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "cancelled", runId: "pfr-cxl-order", processed: 4, created: 2, reused: 1, rejected: 1 }),
    );
    releaseCancel(makeRun({ status: "cancelled", runId: "pfr-cxl-order", processed: 0 }));
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 4\/4）/).length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(screen.queryByText(/已取消（已处理 0\/4）/)).toBeNull();

    // 恰好一次 latest；issues 恰好一次增量；不轮询、不 create、不额外 next。
    expect(vi.mocked(getLatestPrefilterRun).mock.calls.length).toBe(latestCallsBefore + 1);
    expect(vi.mocked(getProjectIssues).mock.calls.length).toBe(issuesCallsBefore + 1);
    expect(prefilterNext).toHaveBeenCalledTimes(1);
    expect(createPrefilterRun).toHaveBeenCalledTimes(1);
    expect(prefilterCancel).toHaveBeenCalledTimes(1);
    expect(prefilterRetry).not.toHaveBeenCalled();
  });

  it("next 在途→cancel 成功 UI cancelled→迟到 next processed=true：issues 只读刷新一次 + latest 只读一次，最终计数同步且 status 保持 cancelled", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    // 开始预筛：create 返回 running run，首个 next 挂起（真 pending）。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-late-batch", processed: 0 }),
    );
    let releaseNext!: (value: PrefilterRunDto) => void;
    vi.mocked(prefilterNext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNext = (run) => resolve({ run, revision: 2, error: null, processed: true });
        }),
    );
    vi.mocked(prefilterCancel).mockResolvedValueOnce(
      makeRun({ status: "cancelled", runId: "pfr-late-batch", processed: 0 }),
    );

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => expect(prefilterNext).toHaveBeenCalledTimes(1));

    // 取消成功 → UI cancelled（计数为取消时刻快照 0/4）。
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 0\/4）/).length).toBeGreaterThan(0);
    });

    const issuesCallsBefore = vi.mocked(getProjectIssues).mock.calls.length;
    const latestCallsBefore = vi.mocked(getLatestPrefilterRun).mock.calls.length;

    // 迟到 next：批次实际落库（processed=true），服务端 run 保持 cancelled 但计数为最终值。
    vi.mocked(getLatestPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "cancelled", runId: "pfr-late-batch", processed: 4, created: 2, reused: 1, rejected: 1 }),
    );
    releaseNext(makeRun({ status: "cancelled", runId: "pfr-late-batch", processed: 4, created: 2, reused: 1, rejected: 1 }));

    // 最终状态：仍 cancelled，但计数已同步为服务端最终值。
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 4\/4）/).length).toBeGreaterThan(0);
    });
    // issues 只读刷新恰好一次；latest 只读恰好一次。
    expect(vi.mocked(getProjectIssues).mock.calls.length).toBe(issuesCallsBefore + 1);
    expect(vi.mocked(getLatestPrefilterRun).mock.calls.length).toBe(latestCallsBefore + 1);
    // 不轮询、不 create、不额外 next/模型调用。
    expect(prefilterNext).toHaveBeenCalledTimes(1);
    expect(createPrefilterRun).toHaveBeenCalledTimes(1);
    expect(prefilterCancel).toHaveBeenCalledTimes(1);
    expect(prefilterRetry).not.toHaveBeenCalled();
  });

  it("取消后已启动新 run：旧迟到批次仍刷新 issues，但不得用 latest 覆盖新 run", async () => {
    vi.mocked(getPrefilterConfig).mockResolvedValue({
      available: true,
      provider: "fake",
      model: "fake-model",
      promptVersion: "text-suspicion-v1",
    });
    vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
    // 第一次 run：next 永远挂起 → 取消。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-old-late", processed: 0 }),
    );
    let releaseOldNext!: (value: PrefilterRunDto) => void;
    vi.mocked(prefilterNext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOldNext = (run) => resolve({ run, revision: 2, error: null, processed: true });
        }),
    );
    vi.mocked(prefilterCancel).mockResolvedValueOnce(
      makeRun({ status: "cancelled", runId: "pfr-old-late", processed: 0 }),
    );
    // 第二次 run：正常完成。
    vi.mocked(createPrefilterRun).mockResolvedValueOnce(
      makeRun({ status: "running", runId: "pfr-new-late", processed: 0 }),
    );
    vi.mocked(prefilterNext).mockResolvedValueOnce({
      run: makeRun({ status: "completed", runId: "pfr-new-late", processed: 4, created: 3 }),
      revision: 3,
      error: null,
      processed: true,
    });

    const utils = renderWorkbench();
    void utils;
    fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
    await screen.findByRole("button", { name: "开始预筛" });
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => expect(prefilterNext).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /取消（批次边界生效）/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/已取消（已处理 0\/4）/).length).toBeGreaterThan(0);
    });

    // 取消后启动新 run → 正常完成（UI 已完成 新增 3）。
    fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
    await waitFor(() => {
      expect(screen.getAllByText(/已完成 新增 3/).length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const issuesCallsBefore = vi.mocked(getProjectIssues).mock.calls.length;
    const latestCallsBefore = vi.mocked(getLatestPrefilterRun).mock.calls.length;

    // 旧 run 的迟到批次落库：issues 仍刷新一次，但不得用 latest 覆盖新 run 的完成态。
    releaseOldNext(makeRun({ status: "cancelled", runId: "pfr-old-late", processed: 4, created: 9 }));
    await waitFor(() => {
      expect(vi.mocked(getProjectIssues).mock.calls.length).toBe(issuesCallsBefore + 1);
    });
    await new Promise((r) => setTimeout(r, 100));
    // latest 没有被调用（新操作已接管，旧迟到批次不得触发 latest 覆盖）。
    expect(vi.mocked(getLatestPrefilterRun).mock.calls.length).toBe(latestCallsBefore);
    // UI 仍是新 run 的完成态。
    expect(screen.getAllByText(/已完成 新增 3/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/已取消（已处理 4\/4）/)).toBeNull();
  });
});
