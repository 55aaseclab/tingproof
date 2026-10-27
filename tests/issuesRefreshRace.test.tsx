// @vitest-environment jsdom
/**
 * P0-1（第 9 轮重做）：issues refresh 并发保护——真实 deferred 时序测试。
 * 所有 getProjectIssues promise 真实 pending；本地 mutation / confirm 在 GET 在途期间
 * 或前后发生；旧响应释放后验证不回滚/不复活/不误删，并精确断言
 * upsertIssue/deleteIssue/confirmSegment 参数。合并与保护语义见 src/store/issueSync.ts。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../src/store/db.js";
import {
  confirmSegment,
  createPrefilterRun,
  deleteIssue,
  getLatestPrefilterRun,
  getPrefilterConfig,
  getProjectIssues,
  updateSegment,
  upsertIssue,
} from "../src/store/repo.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "../src/store/types.js";

vi.mock("../src/store/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/repo.js")>();
  return {
    ...actual,
    confirmSegment: vi.fn(actual.confirmSegment),
    updateSegment: vi.fn(actual.updateSegment),
    upsertIssue: vi.fn(actual.upsertIssue),
    deleteIssue: vi.fn(actual.deleteIssue),
    getProjectIssues: vi.fn(actual.getProjectIssues),
    getPrefilterConfig: vi.fn(actual.getPrefilterConfig),
    getLatestPrefilterRun: vi.fn(actual.getLatestPrefilterRun),
    createPrefilterRun: vi.fn(actual.createPrefilterRun),
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
    projectId: "tp-r9",
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

function makeIssue(issueId: string, segmentId: string, overrides: Record<string, unknown> = {}): IssueRecord {
  return {
    issueId,
    projectId: "tp-r9",
    segmentId,
    startMs: 1000,
    endMs: 2000,
    type: "proper_noun",
    severity: "blocking",
    note: `疑点 ${issueId}`,
    status: "open",
    createdAt: 5,
    resolvedAt: null,
    ...overrides,
  };
}

function makeMeta(): ProjectMeta {
  return {
    projectId: "tp-r9",
    name: "R9 并发测试",
    normalizedStem: "R9 并发测试",
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

/** 手动释放的 deferred promise（模拟在途请求的真实时序）。 */
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function makeCompletedRun(runId: string) {
  return {
    runId,
    projectId: "tp-r9",
    status: "completed",
    provider: "fake",
    model: "fake-model",
    promptVersion: "text-suspicion-v1",
    total: 2,
    processed: 2,
    created: 0,
    reused: 0,
    rejected: 0,
    failedBatches: 0,
    startedAt: 1,
    completedAt: 2,
    batches: [],
  };
}

function setup(initialIssues: IssueRecord[] = []) {
  const utils = render(
    <Workbench
      meta={makeMeta()}
      audioFile={null}
      audioNotice={null}
      initialSegments={SEGMENTS}
      initialIssues={initialIssues}
      onBack={vi.fn()}
      onRelocated={vi.fn()}
    />,
  );
  const row = (id: string) =>
    utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
  return { utils, row };
}

/** 打开预筛面板并等待「开始预筛」可用（config/latest 均已 mock）。 */
async function openPrefilterPanel() {
  fireEvent.click(screen.getByRole("button", { name: "机器预筛" }));
  await screen.findByRole("button", { name: "开始预筛" });
}

/** 点击「开始预筛」——create 返回 completed run，onIssuesChanged 即批次刷新 GET。 */
function startPrefilter() {
  fireEvent.click(screen.getByRole("button", { name: "开始预筛" }));
}

beforeAll(() => {
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
  vi.mocked(confirmSegment).mockClear();
  vi.mocked(updateSegment).mockClear();
  vi.mocked(upsertIssue).mockClear();
  vi.mocked(deleteIssue).mockClear();
  vi.mocked(getProjectIssues).mockReset();
  vi.mocked(getProjectIssues).mockImplementation(async () => []);
  vi.mocked(getPrefilterConfig).mockResolvedValue({
    available: true, provider: "fake", model: "fake-model", promptVersion: "text-suspicion-v1",
  });
  vi.mocked(getLatestPrefilterRun).mockResolvedValue(null);
  vi.mocked(createPrefilterRun).mockResolvedValue(makeCompletedRun("pfr-r9"));
});

afterEach(() => cleanup());

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("P0-1（第 9 轮）：issues refresh 并发保护", () => {
  it("A. 两个 getProjectIssues 同时 pending（断言调用=2）：先释放 #2 新快照再释放 #1 旧快照，最终仍新", async () => {
    // 第一次预筛的 GET 失败 → 顶栏出现「重试读取疑点」入口（第二个并发 GET 的触发器）。
    vi.mocked(getProjectIssues).mockRejectedValueOnce(new Error("第一次读取失败"));
    setup();
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试读取疑点" })).toBeTruthy();
    });

    // 并发窗口：GET#1（重试按钮）与 GET#2（第二次预筛的批次刷新）同时在途。
    vi.mocked(getProjectIssues).mockClear();
    const get1 = deferred<IssueRecord[]>();
    const get2 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues)
      .mockImplementationOnce(() => get1.promise)
      .mockImplementationOnce(() => get2.promise);
    fireEvent.click(screen.getByRole("button", { name: "重试读取疑点" }));
    startPrefilter();
    // 明确断言：两个 promise 同时 pending（调用=2，均未释放）。
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(2));
    expect(get1.promise).toBeInstanceOf(Promise);

    // 先释放 #2（新快照，含新疑点）→ 应用。
    const newIssue = makeIssue("srv-new", "seg-a");
    get2.release([newIssue]);
    await waitFor(() => {
      expect(screen.getByText("疑点 srv-new")).toBeTruthy();
    });

    // 再释放 #1（旧快照=空数组；若被错误应用会删掉 srv-new）→ 旧读丢弃，最终仍新。
    get1.release([]);
    await settle();
    expect(screen.getByText("疑点 srv-new")).toBeTruthy();
    expect(getProjectIssues).toHaveBeenCalledTimes(2);
  });

  it("B. GET pending 中本地解决：等 upsertIssue 真正成功（deferred 完成信号）后再释放旧 GET，最终不回滚；upsertIssue 收到 resolved", async () => {
    const openIssue = makeIssue("issue-res", "seg-a");
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);
    // upsertIssue 挂起：保存成功由 deferred release 显式给出（可观测完成信号）。
    const save = deferred<undefined>();
    vi.mocked(upsertIssue).mockImplementationOnce(() => save.promise);

    setup([openIssue]);
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));

    // GET 在途期间点击「已解决」（本地 mutation）；保存 op 开始执行（upsert 在途）。
    fireEvent.click(await screen.findByRole("button", { name: "✔ 已解决" }));
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-res")).toBeNull();
    });
    await waitFor(() => {
      expect(upsertIssue).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: "issue-res", status: "resolved" }),
      );
    });

    // 先等保存真正成功（释放 deferred → ack 在微任务内完成）再释放旧 GET。
    save.release(undefined);
    await new Promise((r) => setTimeout(r, 0));

    // 释放旧 GET（open 快照）→ 不回滚为 open。
    get1.release([{ ...openIssue, status: "open" }]);
    await settle();
    expect(screen.queryByText("疑点 issue-res")).toBeNull();

    // 精确断言：upsertIssue 收到完整 resolved 记录（resolvedAt 非 null）。
    expect(upsertIssue).toHaveBeenCalledTimes(1);
    expect(upsertIssue).toHaveBeenCalledWith({
      ...openIssue,
      status: "resolved",
      resolvedAt: expect.any(Number),
    });
  });

  it("C. mutation 在 GET 发起前、save 仍 pending：旧 GET 不覆盖；保存成功后仍是最终本地状态", async () => {
    const openIssue = makeIssue("issue-early", "seg-a");
    // 先制造一次失败的刷新 → 出现「重试读取疑点」按钮（重试路径不经过 flushSaves，
    // 否则预筛启动会 join 卡在 deferred upsert 上的 flush）。
    vi.mocked(getProjectIssues).mockRejectedValueOnce(new Error("第一次读取失败"));
    setup([openIssue]);
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试读取疑点" })).toBeTruthy();
    });
    vi.mocked(getProjectIssues).mockClear(); // 后文只统计重试触发的这一个 GET

    // 本地解决（mutation 早于下一个 GET 发起）；upsertIssue 挂起 → save 仍 pending。
    const save = deferred<undefined>();
    vi.mocked(upsertIssue).mockImplementationOnce(() => save.promise);
    fireEvent.click(await screen.findByRole("button", { name: "✔ 已解决" }));
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-early")).toBeNull();
    });
    await waitFor(() => {
      expect(upsertIssue).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: "issue-early", status: "resolved" }),
      );
    });

    // GET 发起（此时 mutation 已发生、保存仍 pending）。
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);
    fireEvent.click(screen.getByRole("button", { name: "重试读取疑点" }));
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));

    // 旧 GET 返回 open 快照 → pending 保护，不覆盖本地 resolved。
    get1.release([{ ...openIssue, status: "open" }]);
    await settle();
    expect(screen.queryByText("疑点 issue-early")).toBeNull();

    // 保存成功（ack）→ 最终保存的就是本地最新（resolved）状态。
    save.release(undefined);
    await settle();
    expect(screen.queryByText("疑点 issue-early")).toBeNull();
    expect(upsertIssue).toHaveBeenCalledTimes(1);
    expect(upsertIssue).toHaveBeenCalledWith({
      ...openIssue,
      status: "resolved",
      resolvedAt: expect.any(Number),
    });
  });

  it("D. 同 issue 旧 save 在途→新 mutation→旧 save 成功：新 pending 不被旧 ack 清掉，最终保存最新状态", async () => {
    vi.mocked(getProjectIssues).mockRejectedValueOnce(new Error("第一次读取失败"));
    const { row } = setup();
    void row;
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试读取疑点" })).toBeTruthy();
    });
    vi.mocked(getProjectIssues).mockClear();

    // 创建疑点 X（mutation #1）；500ms 防抖后保存 op 开始执行，upsert#1 挂起（旧 save 在途）。
    const save1 = deferred<undefined>();
    const save2 = deferred<undefined>();
    vi.mocked(upsertIssue)
      .mockImplementationOnce(() => save1.promise)
      .mockImplementationOnce(() => save2.promise);
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "⚑ 疑点" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "专名" }));
    await waitFor(() => {
      expect(upsertIssue).toHaveBeenCalledTimes(1);
    });
    const createdId = vi.mocked(upsertIssue).mock.calls[0][0].issueId;
    // 精确断言 create：upsertIssue 收到 open 的完整新疑点记录。
    expect(vi.mocked(upsertIssue).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        issueId: createdId,
        projectId: "tp-r9",
        segmentId: "seg-a",
        startMs: 1000,
        endMs: 2000,
        type: "proper_noun",
        severity: "blocking",
        note: "",
        status: "open",
        resolvedAt: null,
      }),
    );

    // 旧保存在途时对同一 issue 发生新 mutation（本地解决）→ pending token 被替换。
    fireEvent.click(await screen.findByRole("button", { name: "✔ 已解决" }));
    await waitFor(() => {
      expect(screen.queryByText(`疑点 ${createdId}`)).toBeNull();
    });

    // 旧 save 成功（token 已被替换 → 不能 ack 新 mutation）→ 新保存 op 开始，upsert#2 挂起。
    save1.release(undefined);
    await waitFor(() => {
      expect(upsertIssue).toHaveBeenCalledTimes(2);
    });

    // 关键断言：新 mutation 的 pending 未被旧 ack 清掉——
    // 此时发起的 GET 返回 open 旧快照，不得把本地 resolved 回滚成 open。
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);
    fireEvent.click(screen.getByRole("button", { name: "重试读取疑点" }));
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));
    get1.release([makeIssue(createdId, "seg-a", { status: "open" })]);
    await settle();
    expect(screen.queryByText(`疑点 ${createdId}`)).toBeNull();

    // 新保存成功 → 最终保存的就是最新状态（resolved）。
    save2.release(undefined);
    await settle();
    expect(upsertIssue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(upsertIssue).mock.calls[1][0]).toEqual(
      expect.objectContaining({ issueId: createdId, status: "resolved", resolvedAt: expect.any(Number) }),
    );
    expect(screen.queryByText(`疑点 ${createdId}`)).toBeNull();
  });

  it("E. pending GET 中原子确认自动解决受保护；confirm 后启动的新 GET 可正常删除该 issue（不永久 pending）", async () => {
    const openIssue = makeIssue("issue-cfm", "seg-b");
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);

    const { row } = setup([openIssue]);
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));

    // GET 在途期间确认 seg-b → confirmSegment 原子返回 resolvedIssues。
    vi.mocked(confirmSegment).mockResolvedValueOnce({
      segment: { ...SEGMENTS[1], status: "confirmed", revisionNo: 2 },
      resolvedIssues: [{ ...openIssue, status: "resolved", resolvedAt: 123456 }],
    });
    fireEvent.click(within(row("seg-b")).getByRole("button", { name: "确认本段" }));
    await waitFor(() => {
      expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-cfm")).toBeNull();
    });
    // 精确断言 confirm：confirmSegment 收到 (seg-b, { correctedText: 校对seg-b })。
    expect(confirmSegment).toHaveBeenCalledTimes(1);
    expect(confirmSegment).toHaveBeenCalledWith("seg-b", { correctedText: "校对seg-b" });

    // 释放旧 GET（open 快照）→ confirm-resolved 只保护在它之前发起的旧读：不重开。
    get1.release([{ ...openIssue, status: "open" }]);
    await settle();
    expect(screen.queryByText("疑点 issue-cfm")).toBeNull();
    expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();

    // 不永久 pending：confirm 之后启动的新 GET（服务端缺失 = 跨设备删除）正常删除本地。
    startPrefilter();
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-cfm")).toBeNull();
    });
    // 关闭「只看未解决」后全量视图也没有该 issue（确实从 UI 删除，而非仅被过滤）。
    fireEvent.click(screen.getByLabelText("只看未解决"));
    await waitFor(() => {
      expect(screen.getByText("还没有任何疑点记录。")).toBeTruthy();
    });
    expect(screen.queryByText("疑点 issue-cfm")).toBeNull();
  });

  it("F. pending GET 中本地删除：旧快照返回后不复活；deleteIssue 精确断言", async () => {
    const openIssue = makeIssue("issue-del", "seg-a");
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);
    vi.mocked(deleteIssue).mockResolvedValue(undefined);

    setup([openIssue]);
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));

    // GET 在途期间删除。
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-del")).toBeNull();
    });

    // 释放旧 GET（含已删除 issue 的旧快照）→ 不复活。
    get1.release([openIssue]);
    await settle();
    expect(screen.queryByText("疑点 issue-del")).toBeNull();

    // 精确断言：deleteIssue 收到该 issueId（单参数）——保存 op 防抖后执行。
    await waitFor(() => {
      expect(deleteIssue).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(deleteIssue).toHaveBeenCalledWith("issue-del");
  });

  it("G. 无本地 mutation 时 server 缺失 initialIssue：从 UI 删除（跨设备删除同步）", async () => {
    const openIssue = makeIssue("issue-xdev", "seg-a");
    setup([openIssue]);
    expect(screen.getByText("疑点 issue-xdev")).toBeTruthy();

    await openPrefilterPanel();
    startPrefilter();
    // 基线 mock 返回 []（服务端已无该 issue）→ 本地删除。
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-xdev")).toBeNull();
    });
    // 顶栏未解决计数同步归零。
    await waitFor(() => {
      expect(screen.getByText("未解决疑点 0")).toBeTruthy();
    });
    // 全量视图也没有（确为删除，不是过滤）。
    fireEvent.click(screen.getByLabelText("只看未解决"));
    await waitFor(() => {
      expect(screen.getByText("还没有任何疑点记录。")).toBeTruthy();
    });
  });

  it("H. confirm 在途→同 issue 本地删除（deleteIssue 挂起→失败→重试成功）→confirm 返回 resolvedIssues→GET 返回服务端旧行：保存成功前/失败时不复活；最终保存后新 GET 按服务端事实删除", async () => {
    const openIssue = makeIssue("issue-cfm-del", "seg-b");
    // 第一次预筛的 GET 失败 → 出现「重试读取疑点」入口（后续 GET 不经 flushSaves，
    // 避免预筛启动 join 卡在挂起/失败的 issue 保存上）。
    vi.mocked(getProjectIssues).mockRejectedValueOnce(new Error("第一次读取失败"));
    const { row } = setup([openIssue]);
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试读取疑点" })).toBeTruthy();
    });
    vi.mocked(getProjectIssues).mockClear();

    // 1) confirm 请求挂起（真实在途：只被调用一次且未释放）。
    const confirm = deferred<{ segment: SegmentRecord; resolvedIssues: IssueRecord[] }>();
    vi.mocked(confirmSegment).mockImplementationOnce(() => confirm.promise);
    fireEvent.click(within(row("seg-b")).getByRole("button", { name: "确认本段" }));
    await waitFor(() => expect(confirmSegment).toHaveBeenCalledTimes(1));
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy(); // 未确认

    // 2) 同 issue 本地删除（删除 op 排在 confirm op 之后——SaveCoordinator 顺序执行；
    //    本地状态与 per-ID pending token 在点击时已生效）。
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-cfm-del")).toBeNull();
    });

    // 3) confirm 返回 resolvedIssues（服务端已原子解决该 issue）。
    //    第 10 轮 P0-1：不得覆盖/ack/删除较新的本地 pending delete token。
    confirm.release({
      segment: { ...SEGMENTS[1], status: "confirmed", revisionNo: 2 },
      resolvedIssues: [{ ...openIssue, status: "resolved", resolvedAt: 123456 }],
    });
    // 确认的段级结果不覆盖较新本地编辑（confirm token 已被删除路径的 segment 保存替换）。
    await waitFor(() => {
      expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy();
    });

    // 4) confirm op 完成后删除 op 开始执行：deleteIssue 挂起（真实在途）。
    let delFail!: () => void;
    vi.mocked(deleteIssue).mockImplementationOnce(
      () => new Promise<undefined>((_res, rej) => { delFail = () => rej(new Error("删除失败（网络不可达）")); }),
    );
    await waitFor(() => expect(deleteIssue).toHaveBeenCalledTimes(1));

    // 5) 删除保存在途期间发起 GET（confirm 响应之后、delete 成功之前）——
    //    deleteIssue 与 getProjectIssues 两请求真正同时在途（均已调用且未释放）。
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);
    fireEvent.click(screen.getByRole("button", { name: "重试读取疑点" }));
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));
    expect(deleteIssue).toHaveBeenCalledTimes(1); // 同时在途证明

    // 6) 删除保存失败（deleteIssue reject → token 保持 pending）。
    delFail();
    await waitFor(() => {
      expect(screen.getByText(/保存失败/)).toBeTruthy();
    }, { timeout: 3000 });

    // 7) GET 返回服务端旧行（confirm 已解决该 issue，删除尚未落盘）→ 本地删除不复活。
    //    （旧缺陷在此复活：confirm 条目被无条件覆盖后，confirm 后发起的读不再受保护。）
    get1.release([{ ...openIssue, status: "resolved", resolvedAt: 123456 }]);
    await settle();
    expect(screen.queryByText("疑点 issue-cfm-del")).toBeNull();
    fireEvent.click(screen.getByLabelText("只看未解决"));
    await waitFor(() => {
      expect(screen.getByText("还没有任何疑点记录。")).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText("只看未解决"));

    // 8) 显式重试保存（顶栏「重试」）→ 删除以最新 token 成功 ack。
    vi.mocked(deleteIssue).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(deleteIssue).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.queryByText(/保存失败/)).toBeNull();
    }, { timeout: 3000 });

    // 9) 最终保存成功后：新 GET（服务端事实=已删除）正常收敛，不复活。
    startPrefilter();
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByText("疑点 issue-cfm-del")).toBeNull();
    });
    fireEvent.click(screen.getByLabelText("只看未解决"));
    await waitFor(() => {
      expect(screen.getByText("还没有任何疑点记录。")).toBeTruthy();
    });

    // 精确断言：confirmSegment 收到 (seg-b, 校对seg-b)；deleteIssue 两次均收到该 issueId。
    expect(confirmSegment).toHaveBeenCalledTimes(1);
    expect(confirmSegment).toHaveBeenCalledWith("seg-b", { correctedText: "校对seg-b" });
    expect(deleteIssue).toHaveBeenCalledTimes(2);
    expect(deleteIssue).toHaveBeenNthCalledWith(1, "issue-cfm-del");
    expect(deleteIssue).toHaveBeenNthCalledWith(2, "issue-cfm-del");
  });

  it("I. GET pending→本地创建疑点→等 upsertIssue 真正成功（deferred 完成信号）→释放旧 GET（缺新 issue）→不删除；精确断言完整 upsertIssue 参数", async () => {
    const get1 = deferred<IssueRecord[]>();
    vi.mocked(getProjectIssues).mockImplementationOnce(() => get1.promise);
    // 保存成功由 deferred release 显式给出（可观测完成信号，非固定 sleep）。
    const save = deferred<undefined>();
    vi.mocked(upsertIssue).mockImplementationOnce(() => save.promise);

    const { row } = setup();
    await openPrefilterPanel();
    startPrefilter();
    await waitFor(() => expect(getProjectIssues).toHaveBeenCalledTimes(1));

    // GET 在途期间通过类型菜单创建疑点（本地 mutation + per-ID pending token）。
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "⚑ 疑点" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "专名" }));
    // 新疑点以 blocking 疑点出现在未解决列表（行内 ⚑ 计数 + 面板卡）。
    await waitFor(() => {
      expect(within(row("seg-a")).getByText("⚑ 疑点 ×1")).toBeTruthy();
    });

    // 等 upsertIssue 被调用（保存 op 开始执行）并真正成功（释放 deferred）。
    await waitFor(() => {
      expect(upsertIssue).toHaveBeenCalledTimes(1);
    });
    save.release(undefined);
    await new Promise((r) => setTimeout(r, 0));

    // 释放旧 GET（不含新 issue 的旧快照）→ 新建疑点不得被旧快照删除。
    get1.release([]);
    await settle();
    expect(within(row("seg-a")).getByText("⚑ 疑点 ×1")).toBeTruthy();

    // 精确断言完整 upsertIssue 参数（新建的 open 记录全部字段）。
    const created = vi.mocked(upsertIssue).mock.calls[0][0];
    expect(created).toEqual({
      issueId: created.issueId,
      projectId: "tp-r9",
      segmentId: "seg-a",
      startMs: 1000,
      endMs: 2000,
      type: "proper_noun",
      severity: "blocking",
      note: "",
      status: "open",
      createdAt: expect.any(Number),
      resolvedAt: null,
    });
    expect(upsertIssue).toHaveBeenCalledTimes(1);
  });
});
