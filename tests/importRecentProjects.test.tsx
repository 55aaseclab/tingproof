// @vitest-environment jsdom
/**
 * AC-052 多项目最近历史（同 origin）：
 * - 项目入口渲染全部最近项目，按 updatedAt 倒序，不再只取 projects[0]；
 * - 每条独立显示名称、已存播放位置、更新时间，并带各自的“打开”按钮；
 * - 打开其中一个只传该项目的 projectId，另一条仍可见（不隐藏、不覆盖）；
 * - 存储边界提示与空历史文案。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSrt } from "../src/core/srt.js";
import { resetDbForTests } from "../src/store/db.js";
import { createProject, makeSegmentFromCue, savePlayback } from "../src/store/repo.js";
import { ImportScreen } from "../src/ui/ImportScreen.js";

const RAW_SRT =
  "1\n00:00:01,600 --> 00:00:02,940\n欢迎大家来到创业课\n\n2\n00:00:03,600 --> 00:00:09,460\n今天讲第一个问题\n";

function makeInput(projectId: string, name: string) {
  const parsed = parseSrt(RAW_SRT);
  return {
    meta: {
      projectId,
      name,
      normalizedStem: name,
      media: {
        audioName: `${name}.mp3`,
        audioSize: 98_320_717,
        audioLastModified: 1_754_400_000_000,
        audioFingerprint: "afp-" + projectId,
        srtFileName: `${name}.srt`,
        srtSha256: "deadbeef",
        mediaKey: "key-" + projectId,
        durationMs: null,
        srtHandle: null,
        audioHandle: null,
      },
      playback: { positionMs: 0, speed: 1, autoRewindMs: 1500, loopSegmentId: null },
    },
    srtSource: {
      rawContent: RAW_SRT,
      sha256: "deadbeef",
      sourceFilename: `${name}.srt`,
      cueCount: parsed.cues.length,
    },
    segments: parsed.cues.map((c) => makeSegmentFromCue(projectId, c)),
  };
}

beforeEach(() => {
  // 每个用例重建 IndexedDB 工厂，模拟“同一 origin 的全新浏览器存储”。
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
});

afterEach(() => cleanup());

describe("ImportScreen 最近项目列表（AC-052）", () => {
  it("两个项目都渲染为独立条目，按 updatedAt 倒序并各自显示播放位置", async () => {
    await createProject(makeInput("tp-recent-a", "青创 一 1 7月25日"));
    await savePlayback("tp-recent-a", {
      positionMs: 1_200_878,
      speed: 0.8,
      autoRewindMs: 1500,
      loopSegmentId: null,
    });
    await new Promise((r) => setTimeout(r, 15));
    await createProject(makeInput("tp-recent-b", "环境画卷 试听"));
    await savePlayback("tp-recent-b", {
      positionMs: 62_000,
      speed: 1,
      autoRewindMs: 1500,
      loopSegmentId: null,
    });

    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    const items = await within(list).findAllByRole("listitem");
    expect(items).toHaveLength(2);

    // 倒序：更新更晚的 tp-recent-b 在前。
    expect(items[0].textContent).toContain("环境画卷 试听");
    expect(items[0].textContent).toContain("00:01:02.000");
    expect(items[1].textContent).toContain("青创 一 1 7月25日");
    expect(items[1].textContent).toContain("00:20:00.878");

    // 每条都有自己的“打开”按钮（可访问名称区分项目）。
    expect(within(list).getByRole("button", { name: "打开 环境画卷 试听" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "打开 青创 一 1 7月25日" })).toBeTruthy();
  });

  it("点击第二条的「打开」只传该 projectId，第一条仍可见且不被隐藏", async () => {
    await createProject(makeInput("tp-recent-a", "青创 一 1 7月25日"));
    await new Promise((r) => setTimeout(r, 15));
    await createProject(makeInput("tp-recent-b", "环境画卷 试听"));

    const onOpenProject = vi.fn();
    render(<ImportScreen onOpenProject={onOpenProject} />);

    const btnB = await screen.findByRole("button", { name: "打开 环境画卷 试听" });
    fireEvent.click(btnB);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject).toHaveBeenCalledWith("tp-recent-b", null);

    // 打开 B 后，A 的条目与打开按钮仍可见（不得被隐藏或覆盖）。
    expect(screen.getByRole("button", { name: "打开 青创 一 1 7月25日" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "最近项目" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("存储边界提示始终可见：IndexedDB 按 origin/浏览器隔离", async () => {
    await createProject(makeInput("tp-recent-a", "青创 一 1 7月25日"));
    render(<ImportScreen onOpenProject={vi.fn()} />);
    await screen.findByRole("list", { name: "最近项目" });

    const notice = screen.getByText(/存储边界提示/);
    expect(notice.textContent).toContain("IndexedDB");
    expect(notice.textContent).toContain("localhost");
    expect(notice.textContent).toContain("无痕");
    expect(notice.textContent).not.toContain("已同步");
  });

  it("空历史明确显示“当前浏览器/当前地址没有本地项目”", async () => {
    render(<ImportScreen onOpenProject={vi.fn()} />);
    expect(await screen.findByText(/当前浏览器\/当前地址没有本地项目/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "最近项目" })).toBeNull();
  });

  it("超过 20 条默认展示 20 条，可加载更多（不丢弃其余项目）", async () => {
    for (let i = 1; i <= 21; i++) {
      await createProject(makeInput(`tp-bulk-${i}`, `批量项目 ${String(i).padStart(2, "0")}`));
    }
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    expect(await within(list).findAllByRole("listitem")).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));
    expect(await within(list).findAllByRole("listitem")).toHaveLength(21);
    // 最早的项目（第 21 条）也在列表中。
    expect(within(list).getByRole("button", { name: "打开 批量项目 01" })).toBeTruthy();
  });
});
