import { describe, expect, it } from "vitest";
import {
  getQoderBaseUrl,
  getQoderChatURL,
  getQoderExchangeURL,
  getQoderModelListURL,
  getQoderRefreshURL,
  getQoderRegionConfig,
  getQoderUsageURL,
  getQoderUserInfoURL,
  isProviderIDForMode,
  QODER_MODES,
} from "../region.js";

describe("Qoder regions", () => {
  it("defines only the fixed global and CN provider bindings", () => {
    expect(QODER_MODES).toEqual(["global", "cn"]);
    expect(getQoderRegionConfig("global").providerID).toBe("qoder");
    expect(getQoderRegionConfig("cn").providerID).toBe("qoder-cn");
  });

  it("builds global endpoints", () => {
    expect(getQoderBaseUrl("global")).toBe("https://api3.qoder.sh/");
    expect(getQoderModelListURL("global")).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
    expect(getQoderChatURL("global")).toContain("api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(getQoderExchangeURL("global")).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
    expect(getQoderUserInfoURL("global")).toBe("https://openapi.qoder.sh/api/v1/userinfo");
    expect(getQoderUsageURL("global")).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
    expect(getQoderRefreshURL("global")).toBe("https://center.qoder.sh/algo/api/v3/user/refresh_token");
  });

  it("builds CN endpoints", () => {
    expect(getQoderBaseUrl("cn")).toBe("https://gateway.qoder.com.cn/");
    expect(getQoderModelListURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1");
    expect(getQoderChatURL("cn")).toContain("gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(getQoderExchangeURL("cn")).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
    expect(getQoderUserInfoURL("cn")).toBe("https://openapi.qoder.com.cn/api/v1/userinfo");
    expect(getQoderUsageURL("cn")).toBe("https://openapi.qoder.com.cn/api/v2/quota/usage");
    expect(getQoderRefreshURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token");
  });
});

describe("isProviderIDForMode", () => {
  it("binds each provider id to exactly one region", () => {
    expect(isProviderIDForMode("qoder", "global")).toBe(true);
    expect(isProviderIDForMode("qoder", "cn")).toBe(false);
    expect(isProviderIDForMode("qoder-cn", "cn")).toBe(true);
    expect(isProviderIDForMode("qoder-cn", "global")).toBe(false);
  });

  it("keeps numbered account slots in their own region", () => {
    expect(isProviderIDForMode("qoder-2", "global")).toBe(true);
    expect(isProviderIDForMode("qoder-2", "cn")).toBe(false);
    expect(isProviderIDForMode("qoder-cn-2", "cn")).toBe(true);
    // The global prefix is itself a prefix of the CN prefix, so `qoder-cn-2`
    // must not be claimed by the global region.
    expect(isProviderIDForMode("qoder-cn-2", "global")).toBe(false);
  });

  it("rejects unrelated or lookalike ids", () => {
    expect(isProviderIDForMode("openai", "global")).toBe(false);
    expect(isProviderIDForMode("qoderx", "global")).toBe(false);
    expect(isProviderIDForMode("qoderx", "cn")).toBe(false);
    // Hand-named global slots keep working: any `qoder-*` id that is not a CN
    // slot stays a global account slot.
    expect(isProviderIDForMode("qoder-work", "global")).toBe(true);
    expect(isProviderIDForMode("qoder-work", "cn")).toBe(false);
  });
});
