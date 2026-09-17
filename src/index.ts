import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  loginQoderForProvider,
  refreshQoderTokenForMode,
} from "./auth/oauth.js";
import { fetchQoderUsageForMode } from "./auth/usage.js";
import {
  addPriceFactorToName,
  getCachedModels,
  isCacheStale,
  staticCnModels,
  staticModels,
  updateQoderModelsCache,
} from "./catalog.js";
import { streamQoder } from "./protocol/stream.js";
import { getQoderBaseUrl, getQoderRegionConfig, QODER_MODES, type QoderMode } from "./region.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type AccountLoginHandler = (providerID: string) => void;

const MAX_QODER_ACCOUNTS = 10;
const registeredAccountProviderIDs = new Set<string>();

const QODER_API = "qoder-api" as Api;

async function registerQoderApi(): Promise<void> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    const register = (compat as Record<string, unknown>).registerApiProvider;
    if (typeof register !== "function") return; // OMP / hosts without the export
    (register as (config: unknown, source: string) => void)(
      { api: QODER_API, stream: streamQoder, streamSimple: streamQoder },
      "provider:qoder",
    );
  } catch {
    // Host has no compat registry; registerProvider(streamSimple) is enough.
  }
}

function accountProviderID(mode: QoderMode, accountNumber: number): string {
  const prefix = getQoderRegionConfig(mode).providerID;
  return accountNumber === 1 ? prefix : `${prefix}-${accountNumber}`;
}

function modelsForProvider(mode: QoderMode, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : mode === "cn" ? staticCnModels : staticModels;

  return modelsToUse.map((m) => ({
    ...m,
    name: addPriceFactorToName(m.name, m.priceFactor),
    provider: providerID,
    baseUrl: getQoderBaseUrl(mode),
  })) as unknown as Model<Api>[];
}

function createQoderOAuth(providerID: string, mode: QoderMode, onLogin?: AccountLoginHandler): OAuthConfigWithUsage {
  const accountSuffix = providerID.match(/-(\d+)$/);
  const accountNumber = accountSuffix ? Number(accountSuffix[1]) : 1;
  const accountLabel = Number.isInteger(accountNumber) && accountNumber > 1 ? `Account ${accountNumber}` : "Account 1";
  return {
    name: mode === "cn" ? `Qoder CN ${accountLabel} (PAT)` : `Qoder ${accountLabel} (Browser OAuth / PAT)`,
    login: (callbacks) => loginQoderForProvider(callbacks, providerID, mode, onLogin),
    refreshToken: (credentials) => refreshQoderTokenForMode(credentials, mode),
    getApiKey: (cred: OAuthCredentials) => cred.access,
    // NOTE: no `modifyModels` hook on purpose. OMP (Bun) does a whole-catalog
    // structuredClone before invoking it, and its bundled catalog contains a
    // model with a non-cloneable property -> "The object can not be cloned."
    // removes qoder from `omp models`. Models are supplied at registration
    // via `modelsForProvider` and refreshed by the startup/session cache hooks.
    fetchUsage: (credentials) => fetchQoderUsageForMode(credentials, mode),
  };
}

function registerQoderProvider(
  pi: ExtensionAPI,
  providerID: string,
  mode: QoderMode,
  onLogin?: AccountLoginHandler,
): void {
  const oauth = createQoderOAuth(providerID, mode, onLogin);
  pi.registerProvider(providerID, {
    name:
      providerID === "qoder-cn"
        ? "Qoder CN (Account 1)"
        : providerID === "qoder"
          ? "Qoder (Account 1)"
          : mode === "cn"
            ? `Qoder CN (Account ${providerID.replace("qoder-cn-", "")})`
            : `Qoder (Account ${providerID.replace("qoder-", "")})`,
    baseUrl: getQoderBaseUrl(mode),
    api: QODER_API,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: oauth as ProviderConfig["oauth"],
    // pi-coding-agent resolves its own nested @earendil-works/pi-ai copy, so the
    // structurally identical Model/Context types are nominally distinct here.
    streamSimple: streamQoder as unknown as ProviderConfig["streamSimple"],
  });
}

function registerNextAccountProvider(pi: ExtensionAPI, accountNumber: number, mode: QoderMode): void {
  if (accountNumber > MAX_QODER_ACCOUNTS) return;

  const providerID = accountProviderID(mode, accountNumber);
  const previousProviderID = accountProviderID(mode, accountNumber - 1);
  if (registeredAccountProviderIDs.has(providerID)) return;
  if (!getCachedCredentials("", previousProviderID)?.access) return;

  registeredAccountProviderIDs.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextAccountProvider(pi, accountNumber + 1, mode);
  });
}

function registerAccountProvider(pi: ExtensionAPI, accountNumber: number, mode: QoderMode): void {
  const providerID = accountProviderID(mode, accountNumber);
  if (registeredAccountProviderIDs.has(providerID)) return;

  registeredAccountProviderIDs.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextAccountProvider(pi, accountNumber + 1, mode);
  });
}

function reRegisterProvidersForMode(pi: ExtensionAPI, mode: QoderMode): void {
  const prefix = getQoderRegionConfig(mode).providerID;
  for (const providerID of registeredAccountProviderIDs) {
    if (providerID === prefix || providerID.startsWith(`${prefix}-`)) {
      registerQoderProvider(pi, providerID, mode);
    }
  }
}

async function initializeAccountProviders(pi: ExtensionAPI, mode: QoderMode): Promise<void> {
  for (let accountNumber = 1; accountNumber <= MAX_QODER_ACCOUNTS; accountNumber++) {
    if (accountNumber > 1 && !getCachedCredentials("", accountProviderID(mode, accountNumber - 1))?.access) break;

    const providerID = accountProviderID(mode, accountNumber);
    try {
      await autoLoginQoderFromEnvironment(providerID, mode);
      await refreshModelsAtStartup(mode, providerID);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
    }

    registerAccountProvider(pi, accountNumber, mode);
    if (!getCachedCredentials("", providerID)?.access) break;
  }
}

async function refreshModelsAtStartup(mode: QoderMode, providerID?: string): Promise<void> {
  const targetProviderID = providerID || getQoderRegionConfig(mode).providerID;
  if (!isCacheStale(mode)) return;

  const credentials = getCachedCredentials("", targetProviderID);
  if (!credentials?.access) return;

  const region = getQoderRegionConfig(mode);
  await updateQoderModelsCache(
    credentials.access,
    credentials.userID || "qoder-user",
    credentials.name || region.userNameFallback,
    credentials.email || region.userEmailFallback,
    mode,
  );
}

export default async function (pi: ExtensionAPI) {
  await registerQoderApi();

  for (const mode of QODER_MODES) {
    await initializeAccountProviders(pi, mode);
  }

  // Refresh the models cache once per session at startup if it is missing or
  // stale (>1h old), rather than on every message in the stream hot path.
  // Login/refresh are the other rebuild triggers; this covers the case where
  // the cache was deleted while the token is still valid.
  pi.on("session_start", async (_event, ctx) => {
    for (const mode of QODER_MODES) {
      try {
        if (!isCacheStale(mode)) continue;
        const region = getQoderRegionConfig(mode);
        for (let accountNumber = 1; accountNumber <= MAX_QODER_ACCOUNTS; accountNumber++) {
          const providerID = accountProviderID(mode, accountNumber);
          const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
          if (!accessToken) continue;
          const creds = getCachedCredentials(accessToken, providerID);
          const userID = creds?.userID || "qoder-user";
          const name = creds?.name || region.userNameFallback;
          const email = creds?.email || region.userEmailFallback;
          await updateQoderModelsCache(accessToken, userID, name, email, mode);
          reRegisterProvidersForMode(pi, mode);
          break;
        }
      } catch {
        // Best-effort: fall back to the existing cache / static models.
      }
    }
  });
}
