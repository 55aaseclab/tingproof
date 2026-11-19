// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { assignmentTarget } from "../src/ui/AssignmentWorkbench.js";
import { setLanguage } from "../src/i18n.js";

const probes = vi.hoisted(() => ({ importScreen: vi.fn(), project: vi.fn(), segments: vi.fn(), issues: vi.fn(), write: vi.fn() }));
vi.mock("../src/ui/ImportScreen.js", () => ({ ImportScreen: () => { probes.importScreen(); return <div>Standalone project import</div>; } }));
vi.mock("../src/ui/Workbench.js", () => ({ Workbench: () => <div>Whole project workbench</div> }));
vi.mock("../src/store/repo.js", () => ({ getProject: probes.project, getProjectSegments: probes.segments, getProjectIssues: probes.issues, updateSegment: probes.write }));
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL"), originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const session = () => ({ csrfToken: "synthetic-csrf", expiresAt: Date.now() + 3600000 });
const data = (id = "assignment-a", options: { title?: string; segments?: unknown[] } = {}) => ({
  assignment: { id, spaceId: "team-a", title: options.title ?? "Assigned field notes", status: "active", expiresAt: null }, revision: 4, cursor: 3,
  segments: options.segments ?? [{ segmentId: "segment-a", cueNo: 2, startMs: 1000, endMs: 3000, originalText: "Authorized original words", correctedText: "Authorized corrected words", status: "confirmed", revisionNo: 2, updatedAt: 100 }],
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let api: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setLanguage("en"); window.history.replaceState(null, "", "/apps/tingproof/?space=team-a&assignment=assignment-a");
  Object.values(probes).forEach(probe => probe.mockClear());
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { Object.defineProperty(this, "paused", { configurable: true, value: true }); this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { Object.defineProperty(this, "paused", { configurable: true, value: false }); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:synthetic-audio") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  api = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/auth/session") return json(session());
    if (path === "/api/business/invoke") return json(data(JSON.parse(String(options?.body)).resourceId));
    throw new Error("Unexpected unscoped request: " + path);
  });
  vi.stubGlobal("fetch", api);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, descriptor] of [["createObjectURL", originalCreate], ["revokeObjectURL", originalRevoke]] as const) {
    if (descriptor) Object.defineProperty(URL, name, descriptor); else Reflect.deleteProperty(URL, name);
  }
});

describe("native scoped assignment entry", () => {
  it("loads only the exact assigned resource and reuses native read-only subtitle rows", async () => {
    const page = render(<App />);
    await screen.findByText("Authorized original words");
    expect(screen.getByDisplayValue("Authorized corrected words").getAttribute("readonly")).not.toBeNull();
    expect(screen.getByText(/assigned segments · revision 4 · read-only/)).toBeTruthy();
    expect(page.container.querySelector(".seg-row")).toBeTruthy();
    expect(page.container.querySelector(".timeline")).toBeTruthy();
    expect(api.mock.calls.map(call => call[0])).toEqual(["/auth/session", "/api/business/invoke"]);
    const options = api.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({ appId: "tingproof", spaceId: "team-a", operation: "get_assignment", resourceId: "assignment-a", input: {} });
    expect(options.headers).toEqual({ "Content-Type": "application/json", "X-CSRF-Token": "synthetic-csrf" });
    expect(screen.queryByRole("button", { name: "Confirm segment" })).toBeNull();
    expect(screen.queryByText("⚑ Issue")).toBeNull(); expect(screen.queryByText(/Export SRT/)).toBeNull();
    fireEvent.focus(screen.getByDisplayValue("Authorized corrected words")); fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    for (const probe of Object.values(probes)) expect(probe).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("does not fall back to whole-project discovery after HTTP %s", async status => {
    api.mockImplementation(async (path: string) => path === "/auth/session" ? json(session()) : json({ code: "FORBIDDEN", message: "SYNTHETIC_PRIVATE_ERROR" }, status));
    render(<App />); await screen.findByRole("alert");
    expect(screen.queryByText("Authorized original words")).toBeNull();
    expect(screen.queryByText("Standalone project import")).toBeNull();
    expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE_ERROR");
    for (const probe of Object.values(probes)) expect(probe).not.toHaveBeenCalled();
  });
  it("rejects incomplete, duplicate or invalid scope without any API or project read", () => {
    expect(assignmentTarget("?space=team-a")).toEqual({ kind: "invalid" });
    expect(assignmentTarget("?assignment=a&space=x&space=y")).toEqual({ kind: "invalid" });
    expect(assignmentTarget("?assignment=../../private&space=team-a")).toEqual({ kind: "invalid" });
    window.history.replaceState(null, "", "/apps/tingproof/?space=team-a");
    render(<App />); expect(screen.getByRole("alert").textContent).toContain("incomplete or invalid");
    expect(api).not.toHaveBeenCalled(); expect(probes.importScreen).not.toHaveBeenCalled();
  });
  it("rejects a mismatched resource or expired assignment without exposing returned text", async () => {
    api.mockImplementation(async (path: string) => json(path === "/auth/session" ? session() : data("assignment-other")));
    render(<App />); await screen.findByRole("alert");
    expect(screen.queryByText("Authorized original words")).toBeNull(); expect(probes.importScreen).not.toHaveBeenCalled();
    cleanup();
    api.mockImplementation(async (path: string) => { const value = data(); return json(path === "/auth/session" ? session() : { ...value, assignment: { ...value.assignment, expiresAt: Date.now() - 1 } }); });
    render(<App />); await screen.findByRole("alert");
    expect(screen.queryByText("Authorized original words")).toBeNull(); expect(probes.project).not.toHaveBeenCalled();
  });
  it("keeps the ordinary native import entry when no assignment scope is present", () => {
    window.history.replaceState(null, "", "/apps/tingproof/"); render(<App />);
    expect(screen.getByText("Standalone project import")).toBeTruthy(); expect(api).not.toHaveBeenCalled();
  });
  it("shows authorized empty tasks without requesting unrelated material", async () => {
    api.mockImplementation(async (path: string) => json(path === "/auth/session" ? session() : data("assignment-a", { segments: [] })));
    render(<App />); await screen.findByText("This assignment has no subtitle segments.");
    expect(screen.queryByText("Standalone project import")).toBeNull(); expect(api).toHaveBeenCalledTimes(2);
  });
  it("ignores a late response from a previously selected assignment", async () => {
    const pending = new Map<string, (response: Response) => void>();
    api.mockImplementation(async (path: string, options?: RequestInit) => path === "/auth/session" ? json(session()) : new Promise<Response>(resolve => pending.set(JSON.parse(String(options?.body)).resourceId, resolve)));
    render(<App />); await waitFor(() => expect(pending.has("assignment-a")).toBe(true));
    act(() => { window.history.pushState(null, "", "/apps/tingproof/?space=team-a&assignment=assignment-b"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(pending.has("assignment-b")).toBe(true));
    await act(async () => pending.get("assignment-b")!(json(data("assignment-b", { title: "Current assignment" }))));
    await screen.findByText("Current assignment");
    await act(async () => pending.get("assignment-a")!(json(data("assignment-a", { title: "Private old assignment" }))));
    expect(screen.queryByText("Private old assignment")).toBeNull(); expect(screen.getByText("Current assignment")).toBeTruthy();
  });
  it("only plays a local session file within an assigned segment and never uploads or writes it", async () => {
    const page = render(<App />); await screen.findByText("Authorized original words");
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
    const local = new File(["synthetic audio"], "field-notes.mp3", { type: "audio/mpeg" });
    fireEvent.change(screen.getByLabelText("Local source audio"), { target: { files: [local] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(false));
    const audio = page.container.querySelector("audio")!;
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(audio.currentTime).toBe(1); expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    act(() => { audio.currentTime = 4; audio.dispatchEvent(new Event("timeupdate")); });
    expect(audio.currentTime).toBe(3); expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(2); expect(URL.createObjectURL).toHaveBeenCalledWith(local); expect(probes.write).not.toHaveBeenCalled();
  });
  it("clears task text, stops audio and revokes its blob after access is rejected on refresh", async () => {
    const page = render(<App />); await screen.findByText("Authorized original words");
    fireEvent.change(screen.getByLabelText("Local source audio"), { target: { files: [new File(["synthetic"], "clip.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    api.mockImplementation(async (path: string) => path === "/auth/session" ? json(session()) : json({ code: "FORBIDDEN" }, 403));
    fireEvent.click(screen.getByRole("button", { name: "Refresh assignment" })); await screen.findByRole("alert");
    expect(screen.queryByText("Authorized original words")).toBeNull(); expect(page.container.querySelector("audio")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-audio");
    expect(probes.project).not.toHaveBeenCalled(); expect(probes.write).not.toHaveBeenCalled();
  });
  it("renders the same native segment view in Simplified Chinese", async () => {
    setLanguage("zh"); render(<App />); await screen.findByText("Authorized original words");
    expect(screen.getByText(/授权字幕段 · 版本4 · 只读/)).toBeTruthy(); expect(screen.getByLabelText("本机源音频")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新任务" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "确认本段" })).toBeNull();
  });
});
