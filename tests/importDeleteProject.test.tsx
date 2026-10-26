// @vitest-environment jsdom
/**
 * 删除历史记录（PRD V1.1.3 / AC-066）：
 * - 每条「打开」旁有「删除」按钮（可访问名称区分项目）+ 行内二次确认；
 * - 取消零调用、列表不变；确认文案明确不可撤销且不删本机源文件；
 * - 确认只删目标项且其他项保留；删除中仅目标条目禁用、防重复（双击一次调用）；
 * - 最后一项删除后空状态；普通失败保留条目、恢复按钮、显示错误并可重试；
 * - 409 冲突：不自动重删、安全刷新 revision、条目保留、用户再次确认后第二次删除成功；
 *   安全刷新失败时列表不被清空；
 * - 幽灵条目防护：删除成功后迟到的旧列表响应不能复活已删除条目（多项目并发删除安全）；
 * - 超过 20 条分页边界：删除后剩余计数正确、不为负、无幽灵目标，加载更多后不重复。
 * deleteProject/listProjects 经 vi.mock 包装计数（透传真实 IndexedDB 实现），观察真实持久效果。
 */
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSrt } from "../src/core/srt.js";
import { resetDbForTests } from "../src/store/db.js";
import { RevisionConflictError } from "../src/store/remoteRepo.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  makeSegmentFromCue,
} from "../src/store/repo.js";
import { ImportScreen } from "../src/ui/ImportScreen.js";

vi.mock("../src/store/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/repo.js")>();
  return {
    ...actual,
    deleteProject: vi.fn(actual.deleteProject),
    listProjects: vi.fn(actual.listProjects),
  };
});

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

async function seedTwoProjects() {
  await createProject(makeInput("tp-del-a", "青创 一 1 7月25日"));
  await new Promise((r) => setTimeout(r, 15));
  await createProject(makeInput("tp-del-b", "环境画卷 试听"));
}

beforeEach(() => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  resetDbForTests();
  vi.mocked(deleteProject).mockClear();
  vi.mocked(listProjects).mockClear();
});

afterEach(() => cleanup());

describe("ImportScreen 删除历史记录（AC-066）", () => {
  it("每条在「打开」旁渲染「删除」按钮（可访问名称区分项目），行内二次确认文案完整", async () => {
    await seedTwoProjects();
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    expect(within(list).getByRole("button", { name: "打开 环境画卷 试听" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "删除 环境画卷 试听" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "打开 青创 一 1 7月25日" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "删除 青创 一 1 7月25日" })).toBeTruthy();

    // 点击「删除」只展开行内确认，不发请求。
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    expect(
      screen.getByText(
        "将删除该项目的字幕、校对文本、疑点和播放进度，无法撤销；不会删除本机 MP3/SRT 源文件。",
      ),
    ).toBeTruthy();
    expect(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "取消删除 环境画卷 试听" })).toBeTruthy();
    expect(deleteProject).toHaveBeenCalledTimes(0);
  });

  it("取消零调用：确认面板关闭，列表与后端数据完全不变", async () => {
    await seedTwoProjects();
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "取消删除 环境画卷 试听" }));

    expect(screen.queryByRole("button", { name: /确认删除/ })).toBeNull();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(deleteProject).toHaveBeenCalledTimes(0);
    expect(await getProject("tp-del-b")).toBeDefined();
    expect(await getProject("tp-del-a")).toBeDefined();
  });

  it("确认只删目标项：其他项目保留，列表总数递减，后端行消失，不整页刷新", async () => {
    await seedTwoProjects();
    const onOpenProject = vi.fn();
    render(<ImportScreen onOpenProject={onOpenProject} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));

    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(deleteProject).toHaveBeenCalledTimes(1);
    expect(deleteProject).toHaveBeenCalledWith("tp-del-b");
    // 只删目标项：另一条完整保留（名称 + 打开按钮可用）。
    expect(within(list).getByRole("button", { name: "打开 青创 一 1 7月25日" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除 环境画卷 试听" })).toBeNull();
    expect(screen.getByText(/共 1 个项目/)).toBeTruthy();
    // 后端持久行消失。
    expect(await getProject("tp-del-b")).toBeUndefined();
    expect(await getProject("tp-del-a")).toBeDefined();
    expect(onOpenProject).toHaveBeenCalledTimes(0); // 删除不触发打开
  });

  it("删除中防重复：双击确认只产生一次调用；期间目标条目按钮禁用、其他条目不受阻", async () => {
    await seedTwoProjects();
    const onOpenProject = vi.fn();
    // 用挂起的 promise 观察删除中状态。
    let release!: () => void;
    vi.mocked(deleteProject).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    render(<ImportScreen onOpenProject={onOpenProject} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    const confirmBtn = within(list).getByRole("button", { name: "确认删除 环境画卷 试听" });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn); // 双击：仅第一次生效（按钮已禁用）

    expect(deleteProject).toHaveBeenCalledTimes(1);
    // 目标条目：两个按钮禁用，删除按钮显示“删除中…”。
    const openB = within(list).getByRole("button", {
      name: "打开 环境画卷 试听",
    }) as HTMLButtonElement;
    const delB = within(list).getByRole("button", {
      name: "删除 环境画卷 试听",
    }) as HTMLButtonElement;
    expect(openB.disabled).toBe(true);
    expect(delB.disabled).toBe(true);
    expect(delB.textContent).toBe("删除中…");
    // 其他条目不受阻：按钮可用、可正常打开（同一 spy 断言收到正确的 projectId/null）。
    const openA = within(list).getByRole("button", {
      name: "打开 青创 一 1 7月25日",
    }) as HTMLButtonElement;
    expect(openA.disabled).toBe(false);
    fireEvent.click(openA);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject).toHaveBeenCalledWith("tp-del-a", null);

    release(); // 完成 Promise，条目移除。
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
  });

  it("最后一项删除后显示“暂无最近项目。”空状态", async () => {
    await createProject(makeInput("tp-del-solo", "单人项目"));
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    fireEvent.click(within(list).getByRole("button", { name: "删除 单人项目" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 单人项目" }));

    await waitFor(() => {
      expect(screen.getByText("暂无最近项目。")).toBeTruthy();
    });
    expect(screen.queryByRole("list", { name: "最近项目" })).toBeNull();
    expect(await getProject("tp-del-solo")).toBeUndefined();
  });

  it("失败保留条目并显示清晰错误，可重试成功", async () => {
    await seedTwoProjects();
    vi.mocked(deleteProject).mockRejectedValueOnce(
      new Error("暂时无法连接服务（网络不可达），项目未删除"),
    );
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));

    // 失败：条目保留、按钮恢复、错误可见。
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("删除失败");
    expect(error.textContent).toContain("项目未删除，可重试");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const openB = within(list).getByRole("button", {
      name: "打开 环境画卷 试听",
    }) as HTMLButtonElement;
    const delB = within(list).getByRole("button", {
      name: "删除 环境画卷 试听",
    }) as HTMLButtonElement;
    expect(openB.disabled).toBe(false);
    expect(delB.disabled).toBe(false);
    expect(await getProject("tp-del-b")).toBeDefined(); // 不假装已删除

    // 重试成功（真实实现）：条目移除、错误清除。
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await getProject("tp-del-b")).toBeUndefined();
  });

  it("409 冲突：不自动重删、条目保留、安全刷新发生；用户再次确认后第二次删除成功", async () => {
    await seedTwoProjects();
    vi.mocked(deleteProject).mockRejectedValueOnce(
      new RevisionConflictError("项目已在其他设备更新，写入被拒绝", 2),
    );
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    const listCallsAfterLoad = vi.mocked(listProjects).mock.calls.length;
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));

    // 冲突提示出现（意味着安全刷新已完成——提示在刷新之后设置）；不自动发第二次 DELETE。
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("版本冲突");
    expect(alert.textContent).toContain("未删除");
    expect(alert.textContent).toContain("再次确认");
    expect(deleteProject).toHaveBeenCalledTimes(1);
    // 内部安全刷新发生（初次加载之外恰好多一次 listProjects）。
    expect(vi.mocked(listProjects).mock.calls.length).toBe(listCallsAfterLoad + 1);
    // 目标条目保留、按钮恢复、后端未删除。
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const delB = within(list).getByRole("button", {
      name: "删除 环境画卷 试听",
    }) as HTMLButtonElement;
    expect(delB.disabled).toBe(false);
    expect(await getProject("tp-del-b")).toBeDefined();

    // 用户重新点击「删除」并再次确认 → 第二次 DELETE 成功（真实实现），条目消失。
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(deleteProject).toHaveBeenCalledTimes(2);
    expect(await getProject("tp-del-b")).toBeUndefined();
    expect(await getProject("tp-del-a")).toBeDefined();
  });

  it("409 且安全刷新失败：列表不被清空、目标行保留、提示稍后重试", async () => {
    await seedTwoProjects();
    vi.mocked(deleteProject).mockRejectedValueOnce(
      new RevisionConflictError("项目已在其他设备更新，写入被拒绝", 2),
    );
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    // 队列下一次 listProjects（即冲突后的安全刷新）失败；初始加载已完成不受影响。
    vi.mocked(listProjects).mockRejectedValueOnce(new Error("暂时无法连接服务"));
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("版本冲突");
    expect(alert.textContent).toContain("暂时无法刷新版本信息");
    expect(alert.textContent).toContain("稍后重试");
    // 列表未被清空（不像初次加载失败那样变空），两条目都在、按钮恢复。
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const delB = within(list).getByRole("button", {
      name: "删除 环境画卷 试听",
    }) as HTMLButtonElement;
    expect(delB.disabled).toBe(false);
    expect(deleteProject).toHaveBeenCalledTimes(1); // 不自动重删
    expect(await getProject("tp-del-b")).toBeDefined();
  });

  it("幽灵条目防护：删除成功后，迟到的旧列表响应不能复活已删除条目（多项目并发安全）", async () => {
    await seedTwoProjects();
    render(<ImportScreen onOpenProject={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "最近项目" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    // 捕获“删除前”的服务端快照（含两个项目）。
    const staleSnapshot = await listProjects();
    expect(staleSnapshot).toHaveLength(2);

    // 项目 B 的第一次删除返回 409 → 触发安全刷新；让该刷新挂起，并在释放时返回旧快照
    // （数据在删除前读取、响应在删除后才送达——正是幽灵条目的竞态形状）。
    vi.mocked(deleteProject).mockRejectedValueOnce(
      new RevisionConflictError("项目已在其他设备更新，写入被拒绝", 2),
    );
    let releaseStale!: () => void;
    vi.mocked(listProjects).mockImplementationOnce(
      () =>
        new Promise<typeof staleSnapshot>((resolve) => {
          releaseStale = () => resolve(staleSnapshot);
        }),
    );

    // B：删除 → 409 → 安全刷新挂起（B 条目处于删除中）。
    fireEvent.click(within(list).getByRole("button", { name: "删除 环境画卷 试听" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 环境画卷 试听" }));

    // 并发删除另一个项目 A（不受 B 阻塞）：真实实现成功，本地立即移除。
    fireEvent.click(within(list).getByRole("button", { name: "删除 青创 一 1 7月25日" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 青创 一 1 7月25日" }));
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(await getProject("tp-del-a")).toBeUndefined();

    // 释放迟到的旧响应（含已删除的 A）：不得复活 A（无幽灵条目）。
    releaseStale();
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
    // 稳定后仍无幽灵：A 不在列表，B 保留（其 409 提示随后出现）。
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("版本冲突");
    });
    expect(screen.queryByRole("button", { name: "打开 青创 一 1 7月25日" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 青创 一 1 7月25日" })).toBeNull();
    expect(within(list).getByRole("button", { name: "打开 环境画卷 试听" })).toBeTruthy();
    expect(await getProject("tp-del-a")).toBeUndefined(); // 后端确实已删除
    expect(await getProject("tp-del-b")).toBeDefined();
  });

  it("超过 20 条的分页边界：删除后剩余计数正确、不为负、无幽灵目标；加载更多后不重复", async () => {
    for (let i = 1; i <= 22; i += 1) {
      await createProject(makeInput(`tp-page-${i}`, `分页项目 ${String(i).padStart(2, "0")}`));
    }
    render(<ImportScreen onOpenProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "最近项目" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByRole("button", { name: /加载更多/ }).textContent).toContain("还有 2 个");

    // 删除一个可见条目（最新的 22 号）。
    fireEvent.click(within(list).getByRole("button", { name: "删除 分页项目 22" }));
    fireEvent.click(within(list).getByRole("button", { name: "确认删除 分页项目 22" }));
    await waitFor(() => {
      expect(screen.getByText(/共 21 个项目/)).toBeTruthy();
    });
    // 剩余 21 个：默认展示 20（原被隐藏的第 21 个补位），“还有 1 个”为正数、无幽灵目标。
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByRole("button", { name: /加载更多/ }).textContent).toContain("还有 1 个");
    expect(screen.queryByRole("button", { name: "删除 分页项目 22" })).toBeNull();
    expect(await getProject("tp-page-22")).toBeUndefined();
    expect(await getProject("tp-page-1")).toBeDefined();

    // 加载更多：21 条全部可见且不重复（无重复行）。
    fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));
    const items = await within(list).findAllByRole("listitem");
    expect(items).toHaveLength(21);
    const openNames = within(list)
      .getAllByRole("button", { name: /^打开 分页项目/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(openNames).toHaveLength(21);
    expect(new Set(openNames).size).toBe(21); // 无重复（可访问名称唯一）
    expect(screen.queryByRole("button", { name: /加载更多/ })).toBeNull();
  });
});
