import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoLoginQoderFromEnvironment,
  clearQoderAuthMemCache,
  getCachedCredentials,
  getQoderPatForMode,
  resolveQoderIdentity,
} from "../auth/oauth.js";
import { credentialsFromPat, fetchUserInfo } from "../auth/pat.js";
import { updateQoderModelsCache } from "../catalog.js";
import { loadLiveFixture } from "./live-fixture.js";

const AUTH_FILE = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent", "auth.json");

const PAT_ENV_NAMES = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;

function clearPatEnv(): void {
  for (const name of PAT_ENV_NAMES) {
    delete process.env[name];
  }
}

vi.mock("../auth/pat.js", () => ({
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
  fetchUserInfo: vi.fn(),
  authFetchSignal: vi.fn(),
}));

vi.mock("../catalog.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  qoderAccountKey: (identity: { userID?: string; email?: string }) =>
    identity.userID || identity.email || "__unknown__",
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
    clearPatEnv();
    clearQoderAuthMemCache();
    originalAuth = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, "utf8") : undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalAuth === undefined) rmSync(AUTH_FILE, { force: true });
    else writeFileSync(AUTH_FILE, originalAuth, "utf8");
    clearQoderAuthMemCache();
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

  it("passes a recorded-format identity into the model catalog refresh", async () => {
    const identity = loadLiveFixture("global").interactions.userinfo.response.body as {
      id: string;
      email: string;
      name: string;
    };
    vi.mocked(credentialsFromPat).mockResolvedValueOnce({
      access: "<redacted:job-token>",
      refresh: "<redacted:refresh-token>",
      expires: Date.now() + 3600000,
      userID: identity.id,
      email: identity.email,
      name: identity.name,
      machineID: "<redacted:machine-id>",
      type: "oauth",
    } as never);
    clearPatEnv();
    process.env.QODER_PAT = "test-only-pat";

    await autoLoginQoderFromEnvironment("qoder-fixture-provider", "global");

    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "<redacted:job-token>",
      identity.id,
      identity.name,
      identity.email,
      "global",
    );
  });
});

describe("resolveQoderIdentity", () => {
  const originalEnv = process.env;
  let originalAuth: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    clearPatEnv();
    clearQoderAuthMemCache();
    originalAuth = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, "utf8") : undefined;
    rmSync(AUTH_FILE, { force: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalAuth === undefined) rmSync(AUTH_FILE, { force: true });
    else writeFileSync(AUTH_FILE, originalAuth, "utf8");
    clearQoderAuthMemCache();
  });

  it("does not cache or persist fallback qoder-user identity on transient userinfo failure", async () => {
    vi.mocked(fetchUserInfo)
      .mockResolvedValueOnce({ userID: "", email: "", name: "" })
      .mockResolvedValueOnce({ userID: "real-uid", email: "u@example.com", name: "User" });

    const first = await resolveQoderIdentity("tok-transient", "qoder-cn", "cn");
    expect(first.userID).toBe("qoder-user");
    expect(existsSync(AUTH_FILE)).toBe(false);

    const second = await resolveQoderIdentity("tok-transient", "qoder-cn", "cn");
    expect(second.userID).toBe("real-uid");
    expect(second.email).toBe("u@example.com");
    expect(second.name).toBe("User");
    expect(fetchUserInfo).toHaveBeenCalledTimes(2);
  });

  it("ignores cached qoder-user placeholder in auth.json and preserves refresh and expires on update", async () => {
    writeFileSync(
      AUTH_FILE,
      JSON.stringify({
        qoder: {
          type: "oauth",
          access: "tok-1",
          refresh: "pat|pt-1|jrt| |m",
          expires: 1900000000000,
          userID: "qoder-user",
        },
      }),
      "utf8",
    );
    clearQoderAuthMemCache();
    vi.mocked(fetchUserInfo).mockResolvedValueOnce({
      userID: "cn-uid",
      email: "cn@example.com",
      name: "CN",
    });

    const resolved = await resolveQoderIdentity("tok-1", "qoder", "cn");
    expect(resolved).toMatchObject({
      access: "tok-1",
      userID: "cn-uid",
      email: "cn@example.com",
      name: "CN",
      refresh: "pat|pt-1|jrt| |m",
      expires: 1900000000000,
    });
    expect(fetchUserInfo).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, Record<string, unknown>>;
    expect(saved.qoder).toMatchObject({
      access: "tok-1",
      userID: "cn-uid",
      email: "cn@example.com",
      name: "CN",
      refresh: "pat|pt-1|jrt| |m",
      expires: 1900000000000,
    });
  });
});
