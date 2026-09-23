import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQoderUsageForMode } from "../auth/usage.js";

/** Credentials are opaque here; the fetch is stubbed for every case. */
const CREDENTIALS = { access: "token", refresh: "rt", expires: Date.now() + 3_600_000 } as never;

function stubUsage(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchQoderUsageForMode", () => {
  it("surfaces the org resource package when its size is reported as `cap`", async () => {
    // The live CN payload has no `total` on orgResourcePackage: it carries
    // `cap` plus `available`, which a `total > 0` check silently dropped.
    stubUsage({
      usageType: "credits",
      expiresAt: 1_792_339_200_000,
      userQuota: { total: 3000, used: 258, remaining: 2742, percentage: 0.09, unit: "credits" },
      orgResourcePackage: { used: 0, remaining: 500, percentage: 0, unit: "credits", cap: 500, available: true },
    });

    const usage = await fetchQoderUsageForMode(CREDENTIALS, "cn");

    expect(usage.usageBuckets?.map((bucket) => bucket.id)).toEqual(["user-quota", "org-resource-package"]);
    expect(usage.usageBuckets?.find((bucket) => bucket.id === "org-resource-package")).toMatchObject({
      label: "Org Resource Package",
      usedDisplay: "0.00",
      limitDisplay: "500.00",
      unit: "credits",
    });
    expect(usage.summary).toBe("User 2742/3000 credits left · Org 500/500 credits left");
  });

  it("derives the limit from used + remaining when neither total nor cap is present", async () => {
    stubUsage({
      userQuota: { used: 10, remaining: 90, unit: "credits" },
      orgResourcePackage: { used: 5, remaining: 45, unit: "credits" },
    });

    const usage = await fetchQoderUsageForMode(CREDENTIALS, "cn");

    expect(usage.usageBuckets?.find((bucket) => bucket.id === "org-resource-package")).toMatchObject({
      usedDisplay: "5.00",
      limitDisplay: "50.00",
    });
  });

  it("omits an unavailable org package", async () => {
    stubUsage({
      userQuota: { total: 3000, used: 258, remaining: 2742, unit: "credits" },
      orgResourcePackage: { used: 500, remaining: 0, cap: 500, available: false, unit: "credits" },
    });

    const usage = await fetchQoderUsageForMode(CREDENTIALS, "cn");

    expect(usage.usageBuckets?.map((bucket) => bucket.id)).toEqual(["user-quota"]);
    expect(usage.summary).toBe("User 2742/3000 credits left");
  });

  it("survives a payload without a user quota", async () => {
    stubUsage({ orgResourcePackage: { used: 0, remaining: 500, cap: 500, unit: "credits" } });

    const usage = await fetchQoderUsageForMode(CREDENTIALS, "cn");

    expect(usage.summary).toBe("Org 500/500 credits left");
    expect(usage.usageBuckets?.map((bucket) => bucket.id)).toEqual(["org-resource-package"]);
  });

  it("reports the HTTP status when the token does not belong to the region", async () => {
    stubUsage({}, 401);

    await expect(fetchQoderUsageForMode(CREDENTIALS, "global")).rejects.toThrow(
      "Failed to fetch Qoder usage: 401 Unauthorized",
    );
  });
});
