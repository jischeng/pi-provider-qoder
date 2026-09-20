/**
 * Live account-catalogue inspection: refresh every discoverable Qoder account
 * catalogue and print the merged picker list.
 *
 * Useful when the picker shows fewer models than expected: `/model/list` is
 * account-scoped, so this reports which account is degraded (free-only
 * catalogue) and what the union of all accounts looks like.
 *
 * Usage: npx tsx scripts/live-account-catalog.ts
 */
import { listQoderAccounts } from "../src/auth/oauth.js";
import { getCachedModels, isAccountCatalogStale, updateQoderModelsCache } from "../src/catalog.js";

for (const mode of ["global", "cn"] as const) {
  const accounts = listQoderAccounts(mode);
  console.log(`[${mode}] accounts=${accounts.length}`);
  for (const account of accounts) {
    console.log(
      `  - ${account.source}/${account.providerID} ${account.email || account.key} stale=${isAccountCatalogStale(mode, account.key)}`,
    );
    if (account.expires !== undefined && account.expires <= Date.now()) {
      console.log("    skipped: token expired");
      continue;
    }
    const ok = await updateQoderModelsCache(
      account.access,
      account.userID || "qoder-user",
      account.name || "Qoder User",
      account.email || "user@qoder.com",
      mode,
    );
    console.log(`    fetch ok=${ok}`);
  }
  const merged = getCachedModels(mode).map((m) => m.id);
  console.log(`[${mode}] merged (${merged.length}): ${merged.join(", ")}`);
}
