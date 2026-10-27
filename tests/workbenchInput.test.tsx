// @vitest-environment jsdom
/**
 * 草稿管道与安全语义回归（第 12 轮审计 / V1.0.5 AC-048）：
 * - 连续输入最终持久化（500ms 防抖后 DB = 最终文本，刷新/重启可恢复）；
 * - 中文 IME：组合中间态绝不落盘（无半字），提交后约 500ms 落盘完整文本；
 * - 页面隐藏（visibilitychange hidden）：立即 flush，不丢字；
 * - 未修改行零渲染在 Workbench 级同样成立（探针）。
 */
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Workbench } from "../src/ui/Workbench.js";
import { getProjectSegments } from "../src/store/repo.js";
import { resetDbForTests } from "../src/store/db.js";
import type { ProjectMeta, SegmentRecord } from "../src/store/types.js";

afterEach(() => {
  document.body.innerHTML = "";
});
beforeEach(() => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
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

const META: ProjectMeta = {
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

/** 建库（通过 Workbench 外部直接构造项目数据）。 */
async function seedProject(segments: SegmentRecord[]) {
  const { createProject } = await import("../src/store/repo.js");
  await createProject({
    meta: { ...META },
    srtSource: {
      rawContent: "seed",
      sha256: "x", // 与 META.media.srtSha256 一致（完整性自检）
      sourceFilename: "a.srt",
      cueCount: segments.length,
    },
    // DB 行使用与 props 相同的 segmentId（否则草稿持久化无法命中）。
    segments: segments.map((s: SegmentRecord) => ({
      segmentId: s.segmentId,
      cueNo: null,
      startMs: s.startMs,
      endMs: s.endMs,
      originalText: s.correctedText,
      correctedText: s.correctedText,
      status: "unreviewed" as const,
    })),
  });
}

/** React 兼容输入：通过原型 value setter 绕过 value tracker，再派发 input 事件。 */
function typeInto(el: HTMLTextAreaElement, text: string, isComposing = false) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
}

async function dbTexts() {
  const segs = await getProjectSegments(META.projectId);
  return segs.map((s) => s.correctedText);
}

describe("草稿管道与安全语义（第 12 轮）", () => {
  it("连续输入：DB 在防抖后 = 最终文本；重启可恢复", async () => {
    await seedProject([makeSeg("seg-a", 1000, 2000, "原文")]);
    const probe = vi.fn();
    const { container } = render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[makeSeg("seg-a", 1000, 2000, "原文")]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
        segmentRenderProbe={probe}
      />,
    );
    const editor = within(container).getByRole("textbox") as HTMLTextAreaElement;
    // 连续输入（Workbench 需要先从 DB 载入段；此处用 props 初始段，重开连接模拟刷新前先 flush）。
    for (const text of ["新", "新增", "新增内容"]) {
      typeInto(editor, text);
    }
    // 500ms 防抖：真实定时器 + 等待。
    await waitFor(
      async () => {
        await new Promise((r) => setTimeout(r, 700));
        const texts = await dbTexts();
        expect(texts[0]).toBe("新增内容");
      },
      { timeout: 3000 },
    );
    // 重启（新连接）后仍在。
    resetDbForTests();
    expect((await dbTexts())[0]).toBe("新增内容");
    void probe;
  });

  it("IME：组合中间态不落盘；提交后落盘完整文本", async () => {
    await seedProject([makeSeg("seg-a", 1000, 2000, "原文")]);
    const { container } = render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[makeSeg("seg-a", 1000, 2000, "原文")]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const editor = within(container).getByRole("textbox") as HTMLTextAreaElement;
    // 危险窗口全序列：普通输入（产生 500ms 待保存 op）→ compositionstart →
    // isComposing=true 组合草稿 → 越过 500ms 防抖 → DB 必须仍是上一完整文本（无半字）。
    typeInto(editor, "新增", false); // 普通输入：进入待保存队列
    fireEvent.compositionStart(editor); // 真实 compositionstart（进入 composingSegmentsRef）
    typeInto(editor, "新增半", true); // 组合中间草稿
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700)); // 越过原 500ms 防抖窗口
    });
    expect((await dbTexts())[0]).toBe("原文"); // 不得是“新增半”
    // 提交（isComposing=false 的 input + compositionend）→ 落盘完整文本。
    typeInto(editor, "新增内容", false);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await waitFor(
      async () => {
        await new Promise((r) => setTimeout(r, 700));
        expect((await dbTexts())[0]).toBe("新增内容");
      },
      { timeout: 3000 },
    );
  });

  it("页面隐藏（visibilitychange hidden）：立即 flush 不丢字", async () => {
    await seedProject([makeSeg("seg-a", 1000, 2000, "原文")]);
    const { container } = render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[makeSeg("seg-a", 1000, 2000, "原文")]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const editor = within(container).getByRole("textbox") as HTMLTextAreaElement;
    typeInto(editor, "隐藏前输入");
    // 未等防抖：直接隐藏页面。
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(async () => {
      expect((await dbTexts())[0]).toBe("隐藏前输入");
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("确认读取最新草稿（正反场景）：清空后阻止、输入后放行；行内与 Ctrl+Enter 一致", () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    // 场景 1：原非空段被草稿清空 → 行内确认被阻止，状态保持 unreviewed。
    const { container, unmount } = render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[makeSeg("seg-a", 1000, 2000, "有内容")]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const editor = within(row("seg-a")).getByRole("textbox") as HTMLTextAreaElement;
    typeInto(editor, ""); // 清空（草稿为空字符串）
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "确认本段" }));
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("文本为空"));
    expect(within(row("seg-a")).getByRole("button", { name: "确认本段" })).toBeTruthy(); // 仍未确认
    unmount();
    alertSpy.mockRestore();
  });

  it("确认读取最新草稿：原空段输入非空草稿 → 行内确认与 Ctrl+Enter 均放行", async () => {
    // 场景 2：原空段（correctedText=""）输入非空草稿。
    // V1.1.4 原子确认经真实持久层：先播种同 segmentId（DB 原文/校对稿与 props 一致）。
    await seedProject([makeSeg("seg-a", 1000, 2000, "")]);
    const { container } = render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[makeSeg("seg-a", 1000, 2000, "")]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const editor = within(row("seg-a")).getByRole("textbox") as HTMLTextAreaElement;
    typeInto(editor, "新内容");
    // 行内确认放行。
    fireEvent.click(within(row("seg-a")).getByRole("button", { name: "确认本段" }));
    await waitFor(() => {
      expect(within(row("seg-a")).getByRole("button", { name: "取消确认" })).toBeTruthy();
    });
  });

  it("Ctrl+Enter 同样遵守最新草稿：原空段输入后直接确认并前进", async () => {
    await seedProject([makeSeg("seg-a", 1000, 2000, ""), makeSeg("seg-b", 2000, 3000, "已校对")]);
    const { container } = render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[
          makeSeg("seg-a", 1000, 2000, ""),
          makeSeg("seg-b", 2000, 3000, "已校对"),
        ]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
      />,
    );
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-segment-id="${id}"]`)!;
    const editor = within(row("seg-a")).getByRole("textbox") as HTMLTextAreaElement;
    typeInto(editor, "Ctrl 草稿");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true }); // 无草稿时会被空文本阻止
    await waitFor(() => {
      expect(within(row("seg-a")).getByRole("button", { name: "取消确认" })).toBeTruthy(); // 放行并确认
    });
    expect(within(row("seg-b")).getByRole("button", { name: "确认本段" })).toBeTruthy(); // 前进到 B
  });

  it("Workbench 级：首键仅一次状态迁移渲染，后续键零渲染（探针）", () => {
    const probe = vi.fn();
    render(
      <Workbench
        meta={META}
        audioFile={null}
        audioNotice={null}
        initialSegments={[makeSeg("seg-a", 1000, 2000, "原文")]}
        initialIssues={[]}
        onBack={vi.fn()}
        onRelocated={vi.fn()}
        segmentRenderProbe={probe}
      />,
    );
    const editor = document.querySelector("textarea")!;
    const count = () => probe.mock.calls.filter(([id]) => id === "seg-a").length;
    const before = count();
    typeInto(editor, "草稿一");
    expect(count()).toBe(before + 1); // 首键：未校对→校对中（状态迁移，一次渲染）
    typeInto(editor, "草稿一二");
    typeInto(editor, "草稿一二三");
    expect(count()).toBe(before + 1); // 后续键：零渲染（纯草稿）
  });
});