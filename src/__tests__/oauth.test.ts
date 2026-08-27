import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateQoderModelsCache } from "../models.js";
import { autoLoginQoderFromEnvironment, getCachedCredentials, getQoderPatForMode } from "../oauth.js";
import { credentialsFromPat } from "../pat.js";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

vi.mock("../pat.js", () => ({
  credentialsFromPat: vi.fn().mockResolvedValue({
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3600000,
    userID: "mock-user-123",
    email: "test@example.com",
    name: "Test User",
    machineID: "mock-machine-id",
    type: "oauth",
  }),
  isPatRefresh: vi.fn().mockReturnValue(false),
  decodePatRefresh: vi.fn(),
}));

vi.mock("../models.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  getCachedModels: vi.fn().mockReturnValue([]),
  isCacheStale: vi.fn().mockReturnValue(true),
  staticModels: [],
  staticCnModels: [],
}));

describe("oauth autoLoginQoderFromEnvironment", () => {
  const originalEnv = process.env;
  let originalAuth: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    originalAuth = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, "utf8") : undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalAuth === undefined) rmSync(AUTH_FILE, { force: true });
    else writeFileSync(AUTH_FILE, originalAuth, "utf8");
  });

  it("extracts PAT correctly from env for global and CN mode", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    expect(getQoderPatForMode("global")).toBe("pt-global-123");

    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-456";
    expect(getQoderPatForMode("cn")).toBe("pt-cn-456");
  });

  it("uses separate environment variables for the second global account", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    process.env.QODER_PERSONAL_ACCESS_TOKEN_2 = "pt-global-456";

    expect(getQoderPatForMode("global", "qoder")).toBe("pt-global-123");
    expect(getQoderPatForMode("global", "qoder-2")).toBe("pt-global-456");
  });

  it("does not reuse account 1 environment credentials for account 2", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN_2;
    delete process.env.QODER_API_KEY_2;
    delete process.env.QODER_PAT_2;

    expect(getQoderPatForMode("global", "qoder-2")).toBe("");
  });

  it("uses separate environment variables for the second CN account", () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-123";
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN_2 = "pt-cn-456";

    expect(getQoderPatForMode("cn", "qoder-cn")).toBe("pt-cn-123");
    expect(getQoderPatForMode("cn", "qoder-cn-2")).toBe("pt-cn-456");
  });

  it("does nothing if no PAT in environment", async () => {
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PAT;

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");
    expect(getCachedCredentials("mock-token", "qoder-test-provider")).toBeNull();
  });

  it("re-exchanges an environment PAT even when cached credentials exist", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-new-account";
    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth["qoder-test-provider"] = {
      type: "oauth",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 3600000,
      userID: "old-user",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).toHaveBeenCalledWith("pt-global-new-account", "global");
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "mock-access-token",
      "mock-user-123",
      "Test User",
      "test@example.com",
      "global",
    );
  });
});
