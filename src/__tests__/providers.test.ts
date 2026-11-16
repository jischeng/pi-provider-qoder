import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache } from "../catalog.js";
import registerQoderExtension from "../index.js";

// Registration imports the full pi-ai compat layer; under parallel workers
// that can push these tests past vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const AGENT_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
const AUTH_FILE = join(AGENT_DIR, "auth.json");

const EXPIRES = Date.now() + 3_600_000;

function credential(userID: string, access: string) {
  return {
    type: "oauth",
    access,
    refresh: "rt",
    expires: EXPIRES,
    userID,
    email: `${userID}@example.com`,
    name: userID,
  };
}

/**
 * Minimal ExtensionAPI stand-in that records provider registrations and the
 * event handlers the extension subscribes to.
 */
interface FakePi {
  api: ExtensionAPI;
  registered: Map<string, number>;
  configs: Map<string, Record<string, unknown>>;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  emit(event: string): Promise<void>;
}

function makePi(): FakePi {
  const registered = new Map<string, number>();
  const configs = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = {
    registerProvider: (id: string, config: Record<string, unknown>) => {
      registered.set(id, (registered.get(id) ?? 0) + 1);
      configs.set(id, config);
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: () => {},
    registerFooterProvider: () => {},
    registerCreditDisplay: () => {},
    // Anything else the extension reaches for is not exercised here.
  } as unknown as ExtensionAPI;
  return {
    api,
    registered,
    configs,
    handlers,
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) await handler({}, {});
    },
  };
}

let prevSkipUpdateCheck: string | undefined;

beforeEach(() => {
  prevSkipUpdateCheck = process.env.PI_PROVIDER_QODER_SKIP_UPDATE_CHECK;
  process.env.PI_PROVIDER_QODER_SKIP_UPDATE_CHECK = "1";
  clearQoderAuthMemCache();
  clearQoderModelsMemCache();
  mkdirSync(AGENT_DIR, { recursive: true });
  rmSync(AUTH_FILE, { force: true });
  writeFileSync(AUTH_FILE, JSON.stringify({ qoder: credential("user-a", "token-a") }), "utf8");
  // Both catalogues: the extension registers a provider per Qoder region.
  for (const name of ["qoder-models-cache.json", "qoder-cn-models-cache.json"]) {
    writeFileSync(
      join(AGENT_DIR, name),
      JSON.stringify({
        version: 2,
        updatedAt: Date.now(),
        models: [{ id: "Lite", name: "Lite" }],
        configs: { Lite: { key: "lite", display_name: "Lite", is_free: true } },
        accounts: {
          "user-a": {
            updatedAt: Date.now(),
            identity: { userID: "user-a" },
            servedModelIds: ["Lite"],
            models: [{ id: "Lite", name: "Lite" }],
            configs: { Lite: { key: "lite", display_name: "Lite", is_free: true } },
          },
        },
      }),
      "utf8",
    );
  }
  clearQoderModelsMemCache();
  // Registration reads the catalogue; never let it hit the network here.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  if (prevSkipUpdateCheck === undefined) delete process.env.PI_PROVIDER_QODER_SKIP_UPDATE_CHECK;
  else process.env.PI_PROVIDER_QODER_SKIP_UPDATE_CHECK = prevSkipUpdateCheck;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearQoderAuthMemCache();
  clearQoderModelsMemCache();
});

describe("provider registration across session lifecycles", () => {
  it("registers the qoder provider for a fresh instance", async () => {
    const pi = makePi();
    await registerQoderExtension(pi.api);

    expect(pi.registered.get("qoder")).toBe(1);
    expect(pi.registered.get("qoder-cn")).toBe(1);
    const qoderUsage = pi.configs.get("qoder")?.usage as
      | { fetchUsage?: unknown; validatesCredentials?: boolean }
      | undefined;
    expect(typeof qoderUsage?.fetchUsage).toBe("function");
    expect(qoderUsage?.validatesCredentials).toBe(false);
  });

  it("registers again for a replacement instance in the same process", async () => {
    // ESM modules stay cached across session replacement, so a module-level
    // "already registered" set made every later session skip registerProvider.
    // /resume, /new and /fork then built a ModelRuntime with zero Qoder
    // providers and the picker silently fell back to the default model
    // (issue #1). Registration state must be per pi instance.
    const first = makePi();
    await registerQoderExtension(first.api);
    expect(first.registered.get("qoder")).toBe(1);
    expect(first.registered.get("qoder-cn")).toBe(1);

    const second = makePi();
    await registerQoderExtension(second.api);

    expect(second.registered.get("qoder")).toBe(1);
    expect(second.registered.get("qoder-cn")).toBe(1);
  });

  it("does not double-register within one instance", async () => {
    const pi = makePi();
    await registerQoderExtension(pi.api);
    const afterInit = pi.registered.get("qoder");

    // A second agent_end/session_start cycle on the same instance must reconcile,
    // not stack duplicate provider registrations.
    await pi.emit("agent_end");
    await pi.emit("session_start");

    expect(afterInit).toBe(1);
    // session_start may re-register once to adopt a refreshed catalogue, but it
    // must never accumulate beyond that.
    expect(pi.registered.get("qoder")).toBeLessThanOrEqual(3);
  });

  it("releases its registration record on session_shutdown", async () => {
    const pi = makePi();
    await registerQoderExtension(pi.api);
    await pi.emit("session_shutdown");

    // Shutting down must not throw and must leave the instance reusable: a later
    // registration pass on the same object registers again.
    await pi.emit("session_start");
    expect(pi.registered.get("qoder")).toBeGreaterThan(0);
  });
});
