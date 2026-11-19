// @vitest-environment jsdom
/**
 * 导出预览懒计算与新鲜性测试（第 11 轮审计 5 / V1.0.5 AC-048）：
 * - ExportDialog 仅在打开时调用 computePreview 一次并正确呈现统计；
 * - Workbench 真实导出走最新 segments/issues（先编辑后导出，内容必须是编辑后的），
 *   不存在陈旧导出。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "../src/ui/ExportDialog.js";
import { Workbench } from "../src/ui/Workbench.js";
import type { ExportPreview } from "../src/core/exportSrt.js";
import type { ProjectMeta, SegmentRecord } from "../src/store/types.js";

const downloadCaptured: { text: string | null } = { text: null };

vi.mock("../src/core/fileWrite.js", () => ({
  isAbortError: (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  supportsFileSystemAccess: () => false,
  pickSaveTarget: vi.fn(async () => ({ mode: "download" as const, name: "out.srt" })),
  writeToHandle: vi.fn(async () => undefined),
  readHandleText: vi.fn(async () => ""),
  downloadText: vi.fn(async (_name: string, text: string) => {
    downloadCaptured.text = text;
  }),
}));

afterEach(() => cleanup());

beforeEach(() => {
  downloadCaptured.text = null;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    return Promise.resolve();
  });
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.requestAnimationFrame = vi.fn(() => 1 as unknown as number);
  globalThis.cancelAnimationFrame = vi.fn();
});

function makeSeg(id: string, startMs: number, endMs: number, text: string): SegmentRecord {
  return {
    segmentId: id,
    projectId: "tp-t",
    cueNo: null,
    startMs,
    endMs,
    originalText: "原文",
    correctedText: text,
    status: "unreviewed",
    revisionNo: 1,
    updatedAt: 0,
  };
}

function makeMeta(): ProjectMeta {
  return {
    projectId: "tp-t",
    name: "测试项目",
    normalizedStem: "测试项目",
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

describe("ExportDialog 懒预览", () => {
  it("打开时调用 computePreview 恰一次，统计正确呈现", () => {
    const computePreview = vi.fn((): ExportPreview => ({
      cues: [
        { seq: 1, startMs: 1000, endMs: 2000, text: "第一段" },
        { seq: 2, startMs: 3000, endMs: 4000, text: "第二段" },
      ],
      segmentCount: 2,
      unresolvedBlocking: 0,
      unresolvedWarning: 0,
      emptyTextCount: 0,
    }));
    render(
      <ExportDialog
        computePreview={computePreview}
        suggestedName="out.srt"
        fsAccess={false}
        sourceGuardReady={false}
        onExport={vi.fn(async () => "ok")}
        onClose={vi.fn()}
      />,
    );
    expect(computePreview).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/字幕段：2/)).toBeTruthy();
    expect(screen.getByText(/未解决阻塞疑点：0/)).toBeTruthy();
  });
});

describe("Workbench 导出使用最新数据（无陈旧导出）", () => {
  it("先编辑 seg-b 文本再导出：下载内容包含编辑后的文本", async () => {
    const segments = [
      makeSeg("seg-a", 1000, 2000, "第一段原文"),
      makeSeg("seg-b", 2000, 3000, "第二段原文"),
    ];
    const { container } = render(
      <Workbench
        meta={makeMeta()}
        audioFile={null}
        audioNotice={null}
        initialSegments={segments}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    // 编辑 seg-b：正文即时更新（预览不逐键重建）。
    const editor = within(container.querySelector<HTMLElement>("[data-segment-id='seg-b']")!).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "第二段已校对" } });
    // 打开导出对话框并导出（download 模式，mock 捕获内容）。
    fireEvent.click(screen.getByRole("button", { name: /导出 SRT/ }));
    const exportBtn = screen
      .getAllByRole("button", { name: "导出" })
      .find((b) => b.className.includes("primary"))!;
    fireEvent.click(exportBtn);
    await waitFor(() => expect(downloadCaptured.text).not.toBeNull());
    expect(downloadCaptured.text).toContain("第二段已校对"); // 最新 segments
    expect(downloadCaptured.text).not.toContain("第二段原文");
    expect(downloadCaptured.text).toContain("第一段原文");
  });
});
