import { createRequire } from "node:module";
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
import { registerQoderCreditDisplay } from "./credit-display.js";
import { applyCachedChatEndpoint, getCachedChatBaseUrl, refreshChatEndpoint } from "./endpoints.js";
import { streamQoder } from "./protocol/stream.js";
import { getQoderBaseUrl, getQoderRegionConfig, isProviderOfMode, QODER_MODES, type QoderMode } from "./region.js";
import { checkForUpdate } from "./update-check.js";
import { createQoderUsageProvider, type UsageProvider } from "./usage-provider.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type AccountLoginHandler = (providerID: string) => void;

// fork: multi-account registration. Upstream registers a single `qoder` /
// `qoder-cn` provider; this fork registers `qoder-2`..`qoder-10` progressively as
// each earlier account logs in, and keeps the registration record per pi
// instance so a replaced session registers from scratch (issue #1).
const MAX_QODER_ACCOUNTS = 10;

/**
 * Provider ids already registered, tracked per pi instance.
 *
 * This MUST be keyed by instance, not a module-level Set. ESM modules stay
 * cached across session replacement, so a module-level set made every later
 * session skip `pi.registerProvider()` entirely: `/resume`, `/new` and `/fork`
 * built a fresh ModelRuntime with zero Qoder providers, the picker fell back to
 * the default model, and the same happened when the official loader loaded the
 * built package a second time in one process.
 *
 * A WeakMap keeps the dedupe within one pi (registerProvider repeatedly for the
 * same id would stack duplicates) while letting a replaced instance register
 * from scratch, and it does not retain dead instances.
 */
const registeredProvidersByPi = new WeakMap<ExtensionAPI, Set<string>>();

function registeredProviderIDs(pi: ExtensionAPI): Set<string> {
  let ids = registeredProvidersByPi.get(pi);
  if (!ids) {
    ids = new Set<string>();
    registeredProvidersByPi.set(pi, ids);
  }
  return ids;
}

const QODER_API = "qoder-api" as Api;

// Version of the running extension, used by the startup update notice.
const requirePackageJson = createRequire(import.meta.url);
const CURRENT_VERSION: string = (requirePackageJson("../package.json") as { version?: string }).version ?? "0.0.0";

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
  // `usage` is OMP's slot for `omp usage`; pi's published ProviderConfig has no
  // such field, so the registered object is widened locally. pi ignores the key.
  const config: ProviderConfig & { usage?: UsageProvider } = {
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
    usage: createQoderUsageProvider(mode, providerID),
  };
  pi.registerProvider(providerID, config);
}

function registerNextAccountProvider(pi: ExtensionAPI, accountNumber: number, mode: QoderMode): void {
  if (accountNumber > MAX_QODER_ACCOUNTS) return;

  const providerID = accountProviderID(mode, accountNumber);
  const previousProviderID = accountProviderID(mode, accountNumber - 1);
  const registered = registeredProviderIDs(pi);
  if (registered.has(providerID)) return;
  if (!getCachedCredentials("", previousProviderID)?.access) return;

  registered.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextAccountProvider(pi, accountNumber + 1, mode);
  });
}

function registerAccountProvider(pi: ExtensionAPI, accountNumber: number, mode: QoderMode): void {
  const providerID = accountProviderID(mode, accountNumber);
  const registered = registeredProviderIDs(pi);
  if (registered.has(providerID)) return;

  registered.add(providerID);
  registerQoderProvider(pi, providerID, mode, () => {
    registerNextAccountProvider(pi, accountNumber + 1, mode);
  });
}

function reRegisterProvidersForMode(pi: ExtensionAPI, mode: QoderMode): void {
  for (const providerID of registeredProviderIDs(pi)) {
    if (isProviderOfMode(providerID, mode)) {
      registerQoderProvider(pi, providerID, mode);
    }
  }
}

async function initializeAccountProviders(pi: ExtensionAPI, mode: QoderMode): Promise<void> {
  // Apply the node that served the last successful chat before registering,
  // so the first turn after a restart does not repeat a failing route.
  applyCachedChatEndpoint(mode);

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

  // fork: multi-account non-blocking endpoint discovery. Only query when no
  // fresh node is cached and at least one non-expired account with a real
  // identity exists (skipping expired/placeholder records such as synthetic
  // offline harness entries with expires: 0).
  if (!getCachedChatBaseUrl(mode)) {
    const endpointAccount = listQoderAccounts(mode).find(
      (a) =>
        Boolean(a.access) &&
        (a.expires === undefined || a.expires > Date.now()) &&
        Boolean(a.userID) &&
        a.userID !== "qoder-user",
    );
    if (endpointAccount) {
      void refreshChatEndpoint(mode, {
        userID: endpointAccount.userID,
        authToken: endpointAccount.access,
        name: endpointAccount.name,
        email: endpointAccount.email,
      }).catch(() => {});
    }
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
  if (!credentials?.userID || credentials.userID === "qoder-user") return false;

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

  // npm-installed extensions get no update check from the host, so report a
  // stale install once per start. Never awaited: registration must not wait on
  // the network, and a failure here is uninteresting.
  void checkForUpdate({
    currentVersion: CURRENT_VERSION,
    hostExecutable: process.argv[1],
    disabled: process.env.PI_PROVIDER_QODER_SKIP_UPDATE_CHECK === "1",
  }).then((notice) => {
    if (notice) console.error(notice);
  });

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

  pi.on("session_shutdown", () => {
    // Drop this instance's registration record. The next session gets a fresh
    // pi (and ModelRuntime), so it must register providers from scratch instead
    // of inheriting a stale "already registered" set — the /resume, /new and
    // /fork model-disappearing bug (issue #1).
    registeredProvidersByPi.delete(pi);
  });

  registerQoderCreditDisplay(pi);
}
