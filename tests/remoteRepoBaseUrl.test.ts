import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteRepository } from "../src/store/remoteRepo.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function captureRequests() {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ projects: [] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("remote repository deployment base", () => {
  it("keeps the build prefix in browser API requests", async () => {
    vi.stubEnv("BASE_URL", "/apps/tingproof/");
    vi.stubGlobal("window", { location: { origin: "https://public.test" } });
    const fetchMock = captureRequests();

    expect(await createRemoteRepository().listProjects()).toEqual([]);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://public.test/apps/tingproof/api/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each(["./", "/"])("preserves root API requests for local base %s", async (base) => {
    vi.stubEnv("BASE_URL", base);
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:5173", pathname: "/nested/page/" },
    });
    const fetchMock = captureRequests();

    await createRemoteRepository().listProjects();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:5173/api/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each(["http://custom.test/workspace/", "http://custom.test/workspace/api/"])(
    "uses the explicit API address %s instead of the build prefix",
    async (baseUrl) => {
      vi.stubEnv("BASE_URL", "/apps/tingproof/");
      vi.stubGlobal("window", { location: { origin: "https://public.test" } });
      const fetchMock = captureRequests();

      await createRemoteRepository(baseUrl).listProjects();

      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "http://custom.test/workspace/api/projects",
        expect.objectContaining({ method: "GET" }),
      );
    },
  );

  it("preserves the nonbrowser fallback address", async () => {
    vi.stubEnv("BASE_URL", "/apps/tingproof/");
    vi.stubGlobal("window", undefined);
    const fetchMock = captureRequests();

    await createRemoteRepository().listProjects();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:5173/api/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
