import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  listQoderAccounts,
  loginQoderForProvider,
  refreshQoderTokenForMode,
} from "./auth/oauth.js";
import { fetchQoderUsageForMode } from "./auth/usage.js";
import {
  addPriceFactorToName,
  getCachedModels,
  hasCachedCatalog,
  isAccountCatalogStale,
  qoderAccountKey,
  qoderCatalogCacheSignature,
  staticCnModels,
  staticModels,
  updateQoderModelsCache,
} from "./catalog.js";
import { streamQoder } from "./protocol/stream.js";
import { getQoderBaseUrl, getQoderRegionConfig, isProviderIDForMode, QODER_MODES, type QoderMode } from "./region.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type AccountLoginHandler = (providerID: string) => void;

const MAX_QODER_ACCOUNTS = 10;

/** Widget key + lifetime for the transient `/qoder-usage` readout. */
const USAGE_WIDGET_KEY = "qoder-usage";
const USAGE_WIDGET_TTL_MS = 15_000;
let usageWidgetTimer: ReturnType<typeof setTimeout> | undefined;

/** Drop a pending/visible usage readout. Safe to call from any UI context. */
function clearUsageWidget(ctx: { ui: { setWidget: (key: string, content: undefined) => void } }): void {
  if (usageWidgetTimer) {
    clearTimeout(usageWidgetTimer);
    usageWidgetTimer = undefined;
  }
  ctx.ui.setWidget(USAGE_WIDGET_KEY, undefined);
}

const registeredAccountProvidersByPi = new WeakMap<ExtensionAPI, Set<string>>();

function getRegisteredAccountProviderIDs(pi: ExtensionAPI): Set<string> {
  let ids = registeredAccountProvidersByPi.get(pi);
  if (!ids) {
    ids = new Set<string>();
    registeredAccountProvidersByPi.set(pi, ids);
  }
  return ids;
}

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
  const registeredAccountProviderIDs = getRegisteredAccountProviderIDs(pi);
  if (registeredAccountProviderIDs.has(providerID)) return;
  if (!getCachedCredentials("", previousProviderID)?.access) return;

  registeredAccountProviderIDs.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextAccountProvider(pi, accountNumber + 1, mode);
  });
}

function registerAccountProvider(pi: ExtensionAPI, accountNumber: number, mode: QoderMode): void {
  const providerID = accountProviderID(mode, accountNumber);
  const registeredAccountProviderIDs = getRegisteredAccountProviderIDs(pi);
  if (registeredAccountProviderIDs.has(providerID)) return;

  registeredAccountProviderIDs.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextAccountProvider(pi, accountNumber + 1, mode);
  });
}

function reRegisterProvidersForMode(pi: ExtensionAPI, mode: QoderMode): void {
  const registeredAccountProviderIDs = getRegisteredAccountProviderIDs(pi);
  for (const providerID of registeredAccountProviderIDs) {
    if (isProviderIDForMode(providerID, mode)) {
      registerQoderProvider(pi, providerID, mode);
    }
  }
}

async function initializeAccountProviders(pi: ExtensionAPI, mode: QoderMode): Promise<void> {
  for (let accountNumber = 1; accountNumber <= MAX_QODER_ACCOUNTS; accountNumber++) {
    if (accountNumber > 1 && !getCachedCredentials("", accountProviderID(mode, accountNumber - 1))?.access) break;

    const providerID = accountProviderID(mode, accountNumber);
    try {
      // PAT-based logins exchange the token and refresh the catalogue here;
      // that path stays awaited so `pi --list-models` has data immediately.
      await autoLoginQoderFromEnvironment(providerID, mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
    }

    registerAccountProvider(pi, accountNumber, mode);
    if (!getCachedCredentials("", providerID)?.access) break;
  }

  // Register from whatever catalogue is already on disk, then refresh in the
  // background. Blocking registration on a network round-trip delayed the
  // provider (and therefore every qoder model) by seconds on slow networks.
  if (hasCachedCatalog(mode)) {
    void refreshAccountCatalogs(mode)
      .then((changed) => {
        if (changed) reRegisterProvidersForMode(pi, mode);
      })
      .catch(() => {});
    return;
  }

  const changed = await refreshAccountCatalogs(mode);
  if (changed) reRegisterProvidersForMode(pi, mode);
}

/** Collect usage lines for every Qoder account visible in this process. */
async function collectQoderUsageLines(ctx: {
  modelRegistry: { getApiKeyForProvider: (providerID: string) => Promise<string | undefined> };
}): Promise<string[]> {
  const lines: string[] = [];

  for (const mode of QODER_MODES) {
    const region = getQoderRegionConfig(mode);
    const accounts = listQoderAccounts(mode);

    if (accounts.length === 0) {
      // Hosts that keep credentials outside auth.json (e.g. OMP) still expose
      // the resolved token through the model registry.
      try {
        const token = await ctx.modelRegistry.getApiKeyForProvider(region.providerID);
        if (token) {
          const usage = await fetchQoderUsageForMode({ access: token } as OAuthCredentials, mode);
          lines.push(`${region.usageTitle}: ${usage.summary || "usage unknown"}`);
        }
      } catch {
        // Not logged in for this region; skip silently.
      }
      continue;
    }

    for (const account of accounts) {
      try {
        const usage = await fetchQoderUsageForMode({ access: account.access } as OAuthCredentials, mode);
        const who = account.email || account.name || account.key;
        const reset = usage.resetAt ? ` · resets ${usage.resetAt.slice(0, 10)}` : "";
        lines.push(`${who} [${region.usageTitle}] — ${usage.summary || "usage unknown"}${reset}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`${account.email || account.key} [${region.usageTitle}] — failed: ${message}`);
      }
    }
  }

  return lines;
}

/**
 * Refresh the catalogue of every Qoder account known for a region.
 *
 * `/model/list` is account-scoped: a free-plan or quota-exhausted account only
 * answers with its `is_free` models. Refreshing just the single account found
 * in auth.json let that degraded answer decide the whole picker, while a funded
 * account's full catalogue (or the pool's other accounts) was never queried.
 */
async function refreshAccountCatalogs(mode: QoderMode): Promise<boolean> {
  const region = getQoderRegionConfig(mode);
  let changed = false;

  for (const account of listQoderAccounts(mode)) {
    if (!account.access) continue;
    if (account.expires !== undefined && account.expires <= Date.now()) continue;
    if (!isAccountCatalogStale(mode, account.key)) continue;

    try {
      const updated = await updateQoderModelsCache(
        account.access,
        account.userID || "qoder-user",
        account.name || region.userNameFallback,
        account.email || region.userEmailFallback,
        mode,
      );
      changed = updated || changed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Catalogue refresh failed for ${account.email || account.key}: ${message}`);
    }
  }

  return changed;
}

/**
 * Fallback refresh for hosts that keep credentials outside auth.json (OMP
 * stores them in its own agent db): ask pi for the resolved token instead of
 * reading the files ourselves. Tokens that cannot be mapped back to a real
 * identity are skipped, because Qoder answers the placeholder identity with
 * 403 `Login expired`.
 */
async function refreshAccountFromRegistry(
  mode: QoderMode,
  ctx: { modelRegistry: { getApiKeyForProvider: (providerID: string) => Promise<string | undefined> } },
): Promise<boolean> {
  const providerID = accountProviderID(mode, 1);
  const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
  if (!accessToken) return false;

  const credentials = getCachedCredentials(accessToken, providerID);
  if (!credentials?.userID) return false;

  const key = qoderAccountKey({ userID: credentials.userID, email: credentials.email });
  if (!isAccountCatalogStale(mode, key)) return false;

  const region = getQoderRegionConfig(mode);
  return updateQoderModelsCache(
    credentials.access || accessToken,
    credentials.userID,
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

  // Panes are separate processes sharing one catalogue file. Watch its
  // signature (mtime+size) so a pane picks up another pane's refresh without
  // restarting; re-registration only happens when the file really changed.
  const knownSignatures = new Map<QoderMode, string>();
  const reRegisterIfCatalogChanged = (): void => {
    for (const mode of QODER_MODES) {
      const signature = qoderCatalogCacheSignature(mode);
      if (knownSignatures.get(mode) === signature) continue;
      knownSignatures.set(mode, signature);
      reRegisterProvidersForMode(pi, mode);
    }
  };
  // Seed the signatures from the catalogue these registrations were built
  // from, so the first turn does not re-register needlessly.
  for (const mode of QODER_MODES) {
    knownSignatures.set(mode, qoderCatalogCacheSignature(mode));
  }

  pi.on("session_start", async (_event, ctx) => {
    // A readout scheduled by the previous session must not leak into this one.
    clearUsageWidget(ctx);
    // Adopt whatever another pane wrote while this one was idle, then refresh
    // the accounts whose own slot is stale.
    reRegisterIfCatalogChanged();
    for (const mode of QODER_MODES) {
      try {
        let changed = await refreshAccountCatalogs(mode);
        if (listQoderAccounts(mode).length === 0) {
          changed = (await refreshAccountFromRegistry(mode, ctx)) || changed;
        }
        if (changed) reRegisterProvidersForMode(pi, mode);
      } catch {
        // Best-effort: fall back to the existing cache / static models.
      }
    }
    reRegisterIfCatalogChanged();
  });

  pi.on("agent_end", () => {
    // Reconcile after a turn rather than before one: re-registering replaces the
    // provider that pi-multiprovider wraps in its account pool, and its own
    // reconcile (which re-wraps the fresh provider) also runs at a turn
    // boundary. Doing this before a request could bypass the pool for that
    // request if handler ordering were reversed.
    reRegisterIfCatalogChanged();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearUsageWidget(ctx);
    registeredAccountProvidersByPi.delete(pi);
  });

  // Optional: hosts without interactive commands (OMP-style) simply skip it.
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("qoder-usage", {
      description: "Show Qoder credit balance and quota usage",
      handler: async (_args, ctx) => {
        try {
          const lines = await collectQoderUsageLines(ctx);
          if (lines.length === 0) {
            ctx.ui.notify("No logged-in Qoder account found. Use /login qoder or /login qoder-cn first.", "warning");
            return;
          }
          // Transient by design: the readout self-clears so it never becomes a
          // permanent fixture above the editor.
          ctx.ui.setWidget(USAGE_WIDGET_KEY, lines, { placement: "aboveEditor" });
          if (usageWidgetTimer) clearTimeout(usageWidgetTimer);
          usageWidgetTimer = setTimeout(() => {
            usageWidgetTimer = undefined;
            ctx.ui.setWidget(USAGE_WIDGET_KEY, undefined);
          }, USAGE_WIDGET_TTL_MS);
          usageWidgetTimer.unref?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to fetch Qoder usage: ${message}`, "error");
        }
      },
    });
  }
}
