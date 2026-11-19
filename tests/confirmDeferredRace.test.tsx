// @vitest-environment jsdom
/**
 * P0-3（第 4 轮）+ P0-2（第 5 轮）：确认前置保存失败不偷偷确认 + 队列项身份保护。
 * - 前置 op 失败 → confirm 尚未执行 → 通用重试只保存草稿（confirmSegment=0）；
 * - T1 确认→前置失败→用户继续输入 T2→通用重试只保存 T2（不丢新文字）且 confirmSegment=0；
 * - confirm 已成功→后续另一 label 失败→不显示"确认被阻止"、不重新入队已确认段；
 * - 只有用户再次显式点击确认才调 confirmSegment。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../src/store/db.js";
import { confirmSegment, updateSegment } from "../src/store/repo.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "../src/store/types.js";

vi.mock("../src/store/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/repo.js")>();
  return {
    ...actual,
    confirmSegment: vi.fn(actual.confirmSegment),
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
    projectId: "tp-p05r5",
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
    projectId: "tp-p05r5",
    name: "P0-2 R5 测试",
    normalizedStem: "P0-2 R5 测试",
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
});

afterEach(() => cleanup());

function setup() {
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
  const row = (id: string) =>
    utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
  const confirmBtn = (id: string) => within(row(id)).getByRole("button", { name: "确认本段" });
  const editor = (id: string) => within(row(id)).getByRole("textbox") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  return { utils, row, confirmBtn, editor, setter };
}

describe("P0-2（第 5 轮）：确认意图用队列项身份保护", () => {
  it("前置失败后通用重试只保存草稿（confirmSegment=0）；再次显式确认才调 confirmSegment", async () => {
    const { confirmBtn, editor, setter } = setup();

    // 1. seg-a 输入草稿（将失败的 op）。
    setter.call(editor("seg-a"), "seg-a 会失败的草稿");
    fireEvent.input(editor("seg-a"), { target: { value: "seg-a 会失败的草稿" } });

    // 2. updateSegment 挂起。
    let releaseUpdate!: () => void;
    vi.mocked(updateSegment).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          releaseUpdate = () => reject(new Error("保存失败（网络不可达）"));
        }),
    );

    // 3. 在 seg-b 点确认（不同 label，confirm op 入队）。
    fireEvent.click(confirmBtn("seg-b"));

    // 等 updateSegment 被调用。
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalled();
    }, { timeout: 3000 });

    // 4. seg-a 失败 → flush catch → state=failed。
    releaseUpdate();
    await waitFor(() => {
      expect(screen.getByText(/保存失败|✖/)).toBeTruthy();
    }, { timeout: 3000 });
    // confirmSegment=0（confirm op 因 flush 中断未执行）。
    expect(confirmSegment).toHaveBeenCalledTimes(0);

    // 5. 通用重试（导航 flush）→ confirm 仍=0。
    fireEvent.click(screen.getByRole("button", { name: "← 项目" }));
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });
    expect(confirmSegment).toHaveBeenCalledTimes(0);

    // 6. 再次显式点击确认 → confirmSegment 被调用。
    vi.mocked(confirmSegment).mockResolvedValueOnce({
      segment: { ...SEGMENTS[1], status: "confirmed", revisionNo: 2 },
      resolvedIssues: [],
    });
    fireEvent.click(confirmBtn("seg-b"));
    await waitFor(() => {
      expect(confirmSegment).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });
  }, 15000);

  it("T1 确认→前置失败→用户继续输入 T2→通用重试只保存 T2（不丢新文字）且 confirmSegment=0", async () => {
    const { confirmBtn, editor, setter } = setup();

    // 1. seg-a 输入草稿。
    setter.call(editor("seg-a"), "seg-a 会失败的草稿");
    fireEvent.input(editor("seg-a"), { target: { value: "seg-a 会失败的草稿" } });

    // 2. updateSegment 挂起。
    let releaseUpdate!: () => void;
    vi.mocked(updateSegment).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          releaseUpdate = () => reject(new Error("保存失败（网络不可达）"));
        }),
    );

    // 3. seg-b 输入 T1 并点确认（confirm op 捕获 T1）。
    setter.call(editor("seg-b"), "T1 确认时文字");
    fireEvent.input(editor("seg-b"), { target: { value: "T1 确认时文字" } });
    fireEvent.click(confirmBtn("seg-b"));

    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalled();
    }, { timeout: 3000 });

    // 4. 在 seg-a 失败前，用户继续输入 seg-b 为 T2（persistSegment 替换 confirm op）。
    setter.call(editor("seg-b"), "T2 更新的文字");
    fireEvent.input(editor("seg-b"), { target: { value: "T2 更新的文字" } });

    // 5. seg-a 失败。
    releaseUpdate();
    await waitFor(() => {
      expect(screen.getByText(/保存失败|✖/)).toBeTruthy();
    }, { timeout: 3000 });
    expect(confirmSegment).toHaveBeenCalledTimes(0);

    // 6. 通用重试 → 保存 T2 草稿（不是旧 confirm 的 T1）。
    fireEvent.click(screen.getByRole("button", { name: "← 项目" }));
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });
    expect(confirmSegment).toHaveBeenCalledTimes(0);
  }, 15000);

  it("confirm 已成功→后续不显示'确认被阻止'、不重新入队已确认段", async () => {
    const { confirmBtn, row } = setup();

    // 1. 确认 seg-b 成功。
    vi.mocked(confirmSegment).mockResolvedValueOnce({
      segment: { ...SEGMENTS[1], status: "confirmed", revisionNo: 2 },
      resolvedIssues: [],
    });
    fireEvent.click(confirmBtn("seg-b"));
    await waitFor(() => {
      expect(confirmSegment).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();
    });

    // 2. 关键断言：不显示"确认已被阻止"。
    expect(screen.queryByText(/确认已被阻止/)).toBeNull();
    // confirmSegment 仍只调了 1 次。
    expect(confirmSegment).toHaveBeenCalledTimes(1);
    // seg-b 仍显示已确认。
    expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();
  });
});

describe("P0-2（第 7 轮）：confirm 在途 T1→T2 竞态不丢稿", () => {
  it("行内按钮路径（advance:false）：confirm T1 in-flight 时输入 T2，释放后 updateSegment 精确保存 T2、文本 T2、B 未确认、选中行不被旧确认切换", async () => {
    const { confirmBtn, editor, setter, row } = setup();

    // 1. 在 seg-b 输入 T1 并点确认（选中行保持 seg-a——按钮点击不改选中）。
    setter.call(editor("seg-b"), "T1 确认文字");
    fireEvent.input(editor("seg-b"), { target: { value: "T1 确认文字" } });
    expect(row("seg-a").className).toContain("active");

    // confirmSegment deferred（模拟网络延迟）。
    let releaseConfirm!: (value: { segment: SegmentRecord; resolvedIssues: IssueRecord[] }) => void;
    vi.mocked(confirmSegment).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConfirm = () =>
            resolve({
              segment: { ...SEGMENTS[1], status: "confirmed", correctedText: "T1 确认文字", revisionNo: 2 },
              resolvedIssues: [],
            });
        }),
    );

    fireEvent.click(confirmBtn("seg-b"));

    // 等 confirmSegment 被调用（in-flight）。
    await waitFor(() => {
      expect(confirmSegment).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    // 精确断言 confirm 参数：confirmSegment 收到 T1 草稿。
    expect(confirmSegment).toHaveBeenCalledWith("seg-b", { correctedText: "T1 确认文字" });

    // 2. confirmSegment pending 时，用户继续输入 T2（persistSegment 替换 confirm token）。
    setter.call(editor("seg-b"), "T2 后续输入");
    fireEvent.input(editor("seg-b"), { target: { value: "T2 后续输入" } });

    // 3. confirm 成功返回（T1 的 canonical segment）。
    releaseConfirm({ segment: { ...SEGMENTS[1], status: "confirmed", correctedText: "T1 确认文字", revisionNo: 2 }, resolvedIssues: [] });

    // 4. 关键断言：
    await waitFor(() => {
      // 段未被确认（confirm token 已被替换 → 不覆盖段级状态）。
      expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy();
    });
    // confirmSegment 只调了 1 次。
    expect(confirmSegment).toHaveBeenCalledTimes(1);
    // 文本仍是 T2（最新输入）——不被 T1 canonical 覆盖。
    expect((editor("seg-b") as HTMLTextAreaElement).value).toBe("T2 后续输入");
    // 释放 confirm 后，替换 confirm 的草稿保存 op 执行：精确断言参数。
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledWith("seg-b", {
        correctedText: "T2 后续输入",
        status: "editing",
      });
    }, { timeout: 3000 });
    // 选中行未因旧确认自动前进/切换：仍是 seg-a。
    expect(row("seg-a").className).toContain("active");
    expect(row("seg-b").className).not.toContain("active");
  });

  it("Ctrl+Enter 路径（advance:true）：选中段 confirm(T1) 挂起→同段输入 T2 替换 token→旧 confirm 返回后不得选中/定位/聚焦下一段；T2 精确落盘、目标段未 confirmed、confirm 参数为 T1", async () => {
    const { editor, setter, row } = setup();
    // 初始选中段为 seg-a；在 seg-a 输入 T1。
    expect(row("seg-a").className).toContain("active");
    setter.call(editor("seg-a"), "T1 确认文字");
    fireEvent.input(editor("seg-a"), { target: { value: "T1 确认文字" } });

    // Ctrl+Enter：对当前选中段 seg-a 发起 advance:true 确认（挂起）。
    let releaseConfirm!: (value: { segment: SegmentRecord; resolvedIssues: IssueRecord[] }) => void;
    vi.mocked(confirmSegment).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConfirm = () =>
            resolve({
              segment: { ...SEGMENTS[0], status: "confirmed", correctedText: "T1 确认文字", revisionNo: 2 },
              resolvedIssues: [],
            });
        }),
    );
    fireEvent.keyDown(editor("seg-a"), { key: "Enter", ctrlKey: true });
    await waitFor(() => {
      expect(confirmSegment).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    // 精确断言 confirm 参数为 T1（选中段 seg-a）。
    expect(confirmSegment).toHaveBeenCalledWith("seg-a", { correctedText: "T1 确认文字" });
    expect(row("seg-a").className).toContain("active"); // 确认在途，未前进

    // confirm 在途时同段输入 T2（persistSegment 替换 confirm 队列项 token）。
    setter.call(editor("seg-a"), "T2 后续输入");
    fireEvent.input(editor("seg-a"), { target: { value: "T2 后续输入" } });

    // 旧 confirm 返回（T1 的 canonical segment，advance 语义本应前进到 seg-b）。
    releaseConfirm({ segment: { ...SEGMENTS[0], status: "confirmed", correctedText: "T1 确认文字", revisionNo: 2 }, resolvedIssues: [] });

    // 关键断言：不选中/定位/聚焦下一段——选中仍是 seg-a。
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledWith("seg-a", {
        correctedText: "T2 后续输入",
        status: "editing",
      });
    }, { timeout: 3000 });
    expect(row("seg-a").className).toContain("active");
    expect(row("seg-b").className).not.toContain("active");
    expect(row("seg-b").contains(document.activeElement)).toBe(false); // 未聚焦下一段
    // 目标段未 confirmed（旧确认的段级结果被 token 保护丢弃）。
    expect(within(row("seg-a")).getByRole("button", { name: "确认本段" })).toBeTruthy();
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy();
    // 文本仍是 T2；confirmSegment 只调了 1 次。
    expect((editor("seg-a") as HTMLTextAreaElement).value).toBe("T2 后续输入");
    expect(confirmSegment).toHaveBeenCalledTimes(1);
  });

  it("snapshot 场景 2：A save pending、B-old confirm 位于 flush snapshot、B 输入 T2、释放 A：updateSegment 精确保存 T2、confirmSegment=0、B 仍未确认", async () => {
    const { confirmBtn, editor, setter, row } = setup();

    // 1. seg-a 输入草稿（A op deferred 成功）。
    setter.call(editor("seg-a"), "seg-a 草稿");
    fireEvent.input(editor("seg-a"), { target: { value: "seg-a 草稿" } });

    let releaseA!: () => void;
    vi.mocked(updateSegment).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseA = () => resolve(undefined);
        }),
    );

    // 2. 在 seg-b 输入 T1 并点确认（confirm op 入队 label=segment:seg-b，进入 flush snapshot）。
    setter.call(editor("seg-b"), "T1 确认文字");
    fireEvent.input(editor("seg-b"), { target: { value: "T1 确认文字" } });
    fireEvent.click(confirmBtn("seg-b"));

    // 等 updateSegment 被调用（A op 开始执行）。
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalled();
    }, { timeout: 3000 });

    // 3. A pending 时，B 输入 T2（persistSegment 替换 confirm）。
    setter.call(editor("seg-b"), "T2 更新");
    fireEvent.input(editor("seg-b"), { target: { value: "T2 更新" } });

    // 4. 释放 A（成功）→ flush 继续执行快照里的下一个 op。
    releaseA();
    await new Promise((r) => setTimeout(r, 100));

    // 5. 关键断言：confirmSegment=0（B-old 被跳过）。
    expect(confirmSegment).toHaveBeenCalledTimes(0);
    // updateSegment 精确保存 T2 草稿（不是旧 confirm 的 T1）。
    await waitFor(() => {
      expect(updateSegment).toHaveBeenCalledWith("seg-b", {
        correctedText: "T2 更新",
        status: "editing",
      });
    }, { timeout: 3000 });
    // B 仍未确认。
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy();
    expect(within(row("seg-b")).queryByRole("button", { name: "取消确认" })).toBeNull();
  });
});
