// @vitest-environment jsdom
/**
 * P0-5 回归：确认失败不得丢保存保护。
 * - 有 pending 草稿 → 确认失败（confirmSegment reject）→ SaveCoordinator failed/pending；
 * - safeNavigate/返回动作只触发保存草稿（updateSegment），绝不造成第二次 confirmSegment 调用或静默 confirmed；
 * - 用户显式再次点击「确认本段」→ confirmSegment 成功 → 段 confirmed。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../src/store/db.js";
import { confirmSegment, updateSegment } from "../src/store/repo.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { ProjectMeta, SegmentRecord } from "../src/store/types.js";

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
    projectId: "tp-p05",
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
    projectId: "tp-p05",
    name: "P0-5 测试",
    normalizedStem: "P0-5 测试",
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

describe("P0-5：确认失败不丢保存保护", () => {
  it("有草稿→确认失败→coordinator failed→导航不重试确认→显式再确认成功", async () => {
    const onBack = vi.fn();
    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={SEGMENTS}
        initialIssues={[]}
        onBack={onBack}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const confirmBtn = (id: string) => within(row(id)).getByRole("button", { name: "确认本段" });

    // 1. 输入草稿（产生 pending 保存）。
    const editor = within(row("seg-b")).getByRole("textbox") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(editor, "确认前最后的草稿");
    fireEvent.input(editor, { target: { value: "确认前最后的草稿" } });

    // 2. 确认失败（网络不可达）。
    vi.mocked(confirmSegment).mockRejectedValueOnce(
      new Error("暂时无法连接服务（网络不可达）"),
    );
    fireEvent.click(confirmBtn("seg-b"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("确认失败");
    });
    // confirmSegment 只被调了 1 次（失败的那次）。
    expect(confirmSegment).toHaveBeenCalledTimes(1);
    // 段未被确认（按钮仍为"确认本段"）。
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy();

    // 3. 导航（点"← 项目"）：safeNavigate flush 只保存草稿，不重试确认。
    fireEvent.click(screen.getByRole("button", { name: "← 项目" }));
    await waitFor(() => {
      // updateSegment 被调用（保存草稿），但 confirmSegment 没有被再次调用。
      expect(updateSegment).toHaveBeenCalled();
    });
    expect(confirmSegment).toHaveBeenCalledTimes(1); // 关键断言：导航不造成第二次确认
    // onBack 被调用（导航放行——草稿已保存，确认未偷偷重试；flush 异步完成后才调用）。
    await waitFor(() => {
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    // 4. 用户显式再次确认 → 成功。
    vi.mocked(confirmSegment).mockResolvedValueOnce({
      segment: { ...SEGMENTS[1], status: "confirmed", correctedText: "确认前最后的草稿", revisionNo: 2 },
      resolvedIssues: [],
    });
    fireEvent.click(confirmBtn("seg-b"));
    await waitFor(() => {
      expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();
    });
    expect(confirmSegment).toHaveBeenCalledTimes(2); // 显式重试
    // 错误清除。
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
