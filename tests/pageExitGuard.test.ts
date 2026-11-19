// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPageExitGuard } from "../src/core/navigation.js";
import { SaveCoordinator } from "../src/store/saveCoordinator.js";

function requestsConfirmation(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("browser page exit protection", () => {
  it("protects pending and failed saves, then permits departure after retry succeeds", async () => {
    const save = new SaveCoordinator(60000);
    const guard = createPageExitGuard(() => save.pendingCount > 0 || save.state.state === "failed");
    const unsubscribe = save.subscribe(guard.refresh);
    let failed = true;
    try {
      expect(requestsConfirmation()).toBe(false);
      save.enqueue("synthetic-change", async () => { if (failed) throw new Error("Synthetic save failure"); });
      save.schedule();
      expect(requestsConfirmation()).toBe(true);
      await save.flush();
      expect(save.state.state).toBe("failed");
      expect(requestsConfirmation()).toBe(true);
      failed = false;
      await save.flush();
      expect(save.pendingCount).toBe(0);
      expect(requestsConfirmation()).toBe(false);
    } finally { unsubscribe(); guard.dispose(); save.dispose(); }
  });

  it("protects unfinished composition and removes its listener when editing ends", () => {
    let composing = false;
    const guard = createPageExitGuard(() => composing);
    try {
      expect(requestsConfirmation()).toBe(false);
      composing = true; guard.refresh();
      expect(requestsConfirmation()).toBe(true);
      composing = false; guard.refresh();
      expect(requestsConfirmation()).toBe(false);
    } finally { guard.dispose(); }
  });

  it("cleans up idempotently and ignores later refresh calls", () => {
    const guard = createPageExitGuard(() => true);
    expect(requestsConfirmation()).toBe(true);
    guard.dispose(); guard.dispose(); guard.refresh();
    expect(requestsConfirmation()).toBe(false);
  });
});
