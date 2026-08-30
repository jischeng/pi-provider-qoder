import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModels, updateQoderModelsCache } from "../models.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const CACHE_PATH = join(homedir(), ".pi", "agent", "qoder-models-cache.json");
let originalCache: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalCache = existsSync(CACHE_PATH) ? readFileSync(CACHE_PATH, "utf8") : undefined;
  rmSync(CACHE_PATH, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCache === undefined) rmSync(CACHE_PATH, { force: true });
  else writeFileSync(CACHE_PATH, originalCache, "utf8");
});

describe("Qoder model cache", () => {
  it("keeps only enabled service models without adding auto as a fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "auto", enable: false, display_name: "Auto" },
              { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
              { key: "lite", enable: true, display_name: "Lite" },
              { key: "performance", enable: false, display_name: "Performance" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["ultimate", "lite"]);
    expect(cache.models.some((model: { id: string }) => model.id === "auto")).toBe(false);
  });

  it("publishes a complete cache with an atomic same-directory rename", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "ultimate", enable: true, display_name: "Ultimate" }] }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cacheWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find(([path]) => typeof path === "string" && path.includes("qoder-models-cache.json."));
    expect(cacheWrite).toBeDefined();
    const temporaryPath = cacheWrite?.[0] as string;
    expect(dirname(temporaryPath)).toBe(dirname(CACHE_PATH));
    expect(renameSync).toHaveBeenCalledWith(temporaryPath, CACHE_PATH);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(JSON.parse(readFileSync(CACHE_PATH, "utf8")).models[0].id).toBe("ultimate");
  });

  it("preserves the previous cache when the atomic rename fails", async () => {
    const previousCache = JSON.stringify({
      updatedAt: Date.now(),
      models: [{ id: "qmodel_38max", name: "Previous catalog" }],
      configs: { qmodel_38max: { key: "qmodel_38max", enable: true } },
    });
    writeFileSync(CACHE_PATH, previousCache, "utf8");
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "ultimate", enable: true, display_name: "Ultimate" }] }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    expect(readFileSync(CACHE_PATH, "utf8")).toBe(previousCache);
    const temporaryPath = vi.mocked(writeFileSync).mock.calls[0]?.[0] as string;
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it("includes the dynamic Qoder price factor in the model name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [{ key: "qmodel_38max", enable: true, display_name: "Qwen3.8-Max", price_factor: 0.5 }],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models[0]).toMatchObject({
      id: "qmodel_38max",
      name: "Qwen3.8-Max (0.5x)",
      priceFactor: 0.5,
    });
    expect(getCachedModels("global")[0]?.name).toBe("Qwen3.8-Max (0.5x)");
  });

  it("keeps the Cantus model returned by the current catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "cmodel", enable: true, display_name: "Cantus" }] }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["cmodel"]);
  });

  it("filters auto from a legacy fallback cache when the service did not enable it", () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "auto" }, { id: "ultimate" }],
        configs: { ultimate: { key: "ultimate", enable: true } },
      }),
      "utf8",
    );

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["ultimate"]);
  });
});
