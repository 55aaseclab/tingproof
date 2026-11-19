// @vitest-environment jsdom
/**
 * V1.1.4 原子确认失败路径（AC-068 客户端口径）：
 * repo.confirmSegment 精确 mock 为一次失败——不自动重试、段与疑点保持原状态、
 * 显示可重试错误；用户再次确认成功后段 confirmed 且疑点 resolved（本地状态原子更新）。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../src/store/db.js";
import { confirmSegment } from "../src/store/repo.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { IssueRecord, ProjectMeta, SegmentRecord } from "../src/store/types.js";

vi.mock("../src/store/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/repo.js")>();
  return { ...actual, confirmSegment: vi.fn(actual.confirmSegment) };
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
    projectId: "tp-cf-fail",
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

const ISSUES: IssueRecord[] = [
  {
    issueId: "issue-f1",
    projectId: "tp-cf-fail",
    segmentId: "seg-b",
    startMs: 2000,
    endMs: 3000,
    type: "proper_noun",
    severity: "blocking",
    note: "专名待查",
    status: "open",
    createdAt: 5,
    resolvedAt: null,
  },
];

function makeMeta(): ProjectMeta {
  return {
    projectId: "tp-cf-fail",
    name: "确认失败测试",
    normalizedStem: "确认失败测试",
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

beforeEach(() => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
  vi.mocked(confirmSegment).mockClear();
});

afterEach(() => cleanup());

describe("Workbench 原子确认失败路径（AC-068）", () => {
  it("失败：不自动重试、段与疑点保持原状态、错误可见可重试；再次确认成功后原子更新", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      void this;
    });
    Element.prototype.scrollIntoView = vi.fn();

    const utils = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={SEGMENTS}
        initialIssues={ISSUES}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) =>
      utils.container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const confirmBtn = (id: string) => within(row(id)).getByRole("button", { name: "确认本段" });

    // 第一次确认失败（如服务不可达）：一次调用，不自动重试。
    vi.mocked(confirmSegment).mockRejectedValueOnce(new Error("暂时无法连接服务（网络不可达）"));
    fireEvent.click(confirmBtn("seg-b"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("确认失败");
      expect(screen.getByRole("alert").textContent).toContain("未变化，可重试");
    });
    expect(confirmSegment).toHaveBeenCalledTimes(1);
    // 段与疑点保持原状态（零半成功的客户端投影）。
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy();
    expect(within(row("seg-b")).getByText("⚑ 疑点 ×1")).toBeTruthy();
    expect(screen.getByText("专名待查")).toBeTruthy();

    // 再次确认（真实实现透传，但目标段未播种 → 返回 undefined？不——精确 mock 成 canonical 结果）。
    vi.mocked(confirmSegment).mockResolvedValueOnce({
      segment: { ...SEGMENTS[1], status: "confirmed", revisionNo: 2 },
      resolvedIssues: [{ ...ISSUES[0], status: "resolved", resolvedAt: 123456 }],
    });
    fireEvent.click(confirmBtn("seg-b"));
    await waitFor(() => {
      expect(within(row("seg-b")).getByRole("button", { name: "取消确认" })).toBeTruthy();
    });
    expect(confirmSegment).toHaveBeenCalledTimes(2);
    // 本地状态原子更新：未解决计数消失、疑点解决、错误清除。
    expect(within(row("seg-b")).queryByText(/⚑ 疑点 ×/)).toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("专名待查")).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
