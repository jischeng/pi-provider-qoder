import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  getQoderBaseUrl,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  toQoderCNFriendlyModel,
} from "./cosy.js";
import { getCachedModels, isCacheStale, staticCnModels, staticModels, updateQoderModelsCache } from "./models.js";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  loginQoderCN,
  loginQoderForProvider,
  refreshQoderToken,
  refreshQoderTokenCN,
} from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage, fetchQoderUsageCN } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type AccountLoginHandler = (providerID: string) => void;

const MAX_GLOBAL_QODER_ACCOUNTS = 10;
const registeredGlobalProviderIDs = new Set<string>();

function globalProviderID(accountNumber: number): string {
  return accountNumber === 1 ? "qoder" : `qoder-${accountNumber}`;
}

function modelsForProvider(mode: string, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : isQoderCNMode(mode) ? staticCnModels : staticModels;

  return modelsToUse.map((m) => {
    const model = isQoderCNMode(mode) ? toQoderCNFriendlyModel(m) : m;
    return {
      ...model,
      provider: providerID,
      baseUrl: getQoderBaseUrl(mode),
    };
  }) as unknown as Model<Api>[];
}

function createQoderOAuth(providerID: string, mode: string, onLogin?: AccountLoginHandler): OAuthConfigWithUsage {
  const accountNumber = providerID === "qoder" ? 1 : Number(providerID.replace("qoder-", ""));
  const accountLabel = Number.isInteger(accountNumber) && accountNumber > 1 ? `Account ${accountNumber}` : "Account 1";
  return {
    name: isQoderCNMode(mode) ? "Qoder CN (PAT)" : `Qoder ${accountLabel} (Browser OAuth / PAT)`,
    login: isQoderCNMode(mode)
      ? loginQoderCN
      : (callbacks) => loginQoderForProvider(callbacks, providerID, mode, onLogin),
    refreshToken: isQoderCNMode(mode) ? refreshQoderTokenCN : refreshQoderToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    // NOTE: no `modifyModels` hook on purpose. OMP (Bun) does a whole-catalog
    // structuredClone before invoking it, and its bundled catalog contains a
    // model with a non-cloneable property -> "The object can not be cloned."
    // removes qoder from `omp models`. Models are supplied at registration
    // via `modelsForProvider` and refreshed by the startup/session cache hooks.
    fetchUsage: isQoderCNMode(mode) ? fetchQoderUsageCN : fetchQoderUsage,
  };
}

function registerQoderProvider(
  pi: ExtensionAPI,
  providerID: string,
  mode: string,
  onLogin?: AccountLoginHandler,
): void {
  const oauth = createQoderOAuth(providerID, mode, onLogin);
  pi.registerProvider(providerID, {
    name:
      providerID === "qoder-cn"
        ? "Qoder CN"
        : providerID === "qoder"
          ? "Qoder (Account 1)"
          : `Qoder (Account ${providerID.replace("qoder-", "")})`,
    baseUrl: getQoderBaseUrl(mode),
    api: "qoder-api" as Api,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: oauth as ProviderConfig["oauth"],
    streamSimple: streamQoder,
  });
}

function registerNextGlobalProvider(pi: ExtensionAPI, accountNumber: number, mode: string): void {
  if (accountNumber > MAX_GLOBAL_QODER_ACCOUNTS) return;

  const providerID = globalProviderID(accountNumber);
  const previousProviderID = globalProviderID(accountNumber - 1);
  if (registeredGlobalProviderIDs.has(providerID)) return;
  if (!getCachedCredentials("", previousProviderID)?.access) return;

  registeredGlobalProviderIDs.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextGlobalProvider(pi, accountNumber + 1, mode);
  });
}

function registerGlobalProvider(pi: ExtensionAPI, accountNumber: number, mode: string): void {
  const providerID = globalProviderID(accountNumber);
  if (registeredGlobalProviderIDs.has(providerID)) return;

  registeredGlobalProviderIDs.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextGlobalProvider(pi, accountNumber + 1, mode);
  });
}

async function refreshModelsAtStartup(providerID: string, mode: string): Promise<void> {
  if (!isCacheStale(mode)) return;

  const credentials = getCachedCredentials("", providerID);
  if (!credentials?.access) return;

  await updateQoderModelsCache(
    credentials.access,
    credentials.userID || "qoder-user",
    credentials.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
    credentials.email || getQoderUserEmailFallback(mode),
    mode,
  );
}

export default async function (pi: ExtensionAPI) {
  const globalMode = getQoderMode();

  // Only expose the next account slot after the previous slot is already
  // authenticated. This keeps the model list and /login selector uncluttered.
  for (let accountNumber = 1; accountNumber <= MAX_GLOBAL_QODER_ACCOUNTS; accountNumber++) {
    if (accountNumber > 1 && !getCachedCredentials("", globalProviderID(accountNumber - 1))?.access) break;

    const providerID = globalProviderID(accountNumber);
    try {
      await autoLoginQoderFromEnvironment(providerID, globalMode);
      await refreshModelsAtStartup(providerID, globalMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
    }

    registerGlobalProvider(pi, accountNumber, globalMode);
    if (!getCachedCredentials("", providerID)?.access) break;
  }

  try {
    await autoLoginQoderFromEnvironment("qoder-cn", "cn");
    await refreshModelsAtStartup("qoder-cn", "cn");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-provider-qoder] Automatic login failed for qoder-cn: ${message}`);
  }

  // Refresh the models cache once per session at startup if it is missing or
  // stale (>1h old), rather than on every message in the stream hot path.
  // Login/refresh are the other rebuild triggers; this covers the case where
  // the cache was deleted while the token is still valid.
  pi.on("session_start", async (_event, ctx) => {
    const providers: Array<[string, string]> = [
      ...Array.from(registeredGlobalProviderIDs, (providerID) => [providerID, globalMode] as [string, string]),
      ["qoder-cn", "cn"],
    ];
    for (const [providerID, mode] of providers) {
      try {
        const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
        if (!accessToken || !isCacheStale(mode)) continue;
        const creds = getCachedCredentials(accessToken, providerID);
        const userID = creds?.userID || "qoder-user";
        const name = creds?.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User");
        const email = creds?.email || getQoderUserEmailFallback(mode);
        await updateQoderModelsCache(accessToken, userID, name, email, mode);
      } catch {
        // Best-effort: fall back to the existing cache / static models.
      }
    }
  });

  registerQoderProvider(pi, "qoder-cn", "cn");
}
