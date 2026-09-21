import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getQoderRegionConfig, getQoderUsageURL, type QoderMode } from "../region.js";

interface QoderQuota {
  total?: number;
  used?: number;
  remaining?: number;
  percentage?: number;
  unit?: string;
  /** Org packages report their size as `cap` instead of `total`. */
  cap?: number;
  available?: boolean;
}

interface QoderUsageInfo {
  userQuota?: QoderQuota;
  orgResourcePackage?: QoderQuota;
  totalUsagePercentage?: number;
  isQuotaExceeded?: boolean;
  expiresAt?: number;
}

/** `total` is optional upstream: org packages carry `cap` (and sometimes only `remaining`). */
function quotaLimit(quota: QoderQuota): number | undefined {
  if (typeof quota.total === "number") return quota.total;
  if (typeof quota.cap === "number") return quota.cap;
  if (typeof quota.used === "number" && typeof quota.remaining === "number") return quota.used + quota.remaining;
  return undefined;
}

function quotaUsed(quota: QoderQuota): number {
  if (typeof quota.used === "number") return quota.used;
  const limit = quotaLimit(quota);
  if (typeof limit === "number" && typeof quota.remaining === "number") return Math.max(0, limit - quota.remaining);
  return 0;
}

/** Renders a quota as `remaining/limit unit left`, degrading to whatever the payload actually has. */
function formatQuota(quota: QoderQuota): string {
  const unit = quota.unit ? ` ${quota.unit}` : "";
  const limit = quotaLimit(quota);
  const remaining = typeof quota.remaining === "number" ? quota.remaining : undefined;
  if (remaining !== undefined) {
    return limit === undefined ? `${remaining}${unit} left` : `${remaining}/${limit}${unit} left`;
  }
  return limit === undefined ? `${quotaUsed(quota)}${unit} used` : `${quotaUsed(quota)}/${limit}${unit} used`;
}

export interface QoderProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  manageUrl?: string;
  usageBuckets?: Array<{
    id: string;
    label: string;
    usedDisplay: string;
    limitDisplay?: string;
    unit?: string;
    resetAt?: string;
  }>;
  raw?: Record<string, unknown>;
}

export async function fetchQoderUsageForMode(
  credentials: OAuthCredentials,
  mode: QoderMode,
): Promise<QoderProviderUsage> {
  const region = getQoderRegionConfig(mode);
  const response = await fetch(getQoderUsageURL(mode), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.access}`,
      Accept: "application/json",
      "User-Agent": "pi-provider-qoder",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Qoder usage: ${response.status} ${response.statusText}`);
  }

  const raw = (await response.json()) as QoderUsageInfo;
  const usageBuckets = [];

  if (raw.userQuota) {
    usageBuckets.push({
      id: "user-quota",
      label: "User Quota",
      usedDisplay: quotaUsed(raw.userQuota).toFixed(2),
      limitDisplay: quotaLimit(raw.userQuota)?.toFixed(2),
      unit: raw.userQuota.unit,
      resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    });
  }

  // Org packages are reported even when their size lives in `cap` rather than
  // `total`, and an `available: false` package holds no usable credits.
  if (
    raw.orgResourcePackage &&
    raw.orgResourcePackage.available !== false &&
    quotaLimit(raw.orgResourcePackage) !== undefined
  ) {
    usageBuckets.push({
      id: "org-resource-package",
      label: "Org Resource Package",
      usedDisplay: quotaUsed(raw.orgResourcePackage).toFixed(2),
      limitDisplay: quotaLimit(raw.orgResourcePackage)?.toFixed(2),
      unit: raw.orgResourcePackage.unit,
      resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    });
  }

  const hasOrgPackage =
    !!raw.orgResourcePackage &&
    raw.orgResourcePackage.available !== false &&
    quotaLimit(raw.orgResourcePackage) !== undefined;

  const summaryParts: string[] = [];
  if (raw.userQuota) summaryParts.push(`User ${formatQuota(raw.userQuota)}`);
  if (hasOrgPackage && raw.orgResourcePackage) summaryParts.push(`Org ${formatQuota(raw.orgResourcePackage)}`);

  return {
    summary: summaryParts.join(" · "),
    subscriptionTitle: region.usageTitle,
    resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    manageUrl: region.manageUrl,
    usageBuckets,
    raw: raw as unknown as Record<string, unknown>,
  };
}
