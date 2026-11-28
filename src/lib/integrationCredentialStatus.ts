export const DAY_MS = 24 * 60 * 60 * 1000;

export type ProbeStatus = "valid" | "expired" | "rejected" | "access_denied" | "missing" | "unavailable";
export type IntegrationStatus = ProbeStatus | "pending" | "expiring";

export interface CredentialCheck {
  status: ProbeStatus;
  expiresAt: number | null;
  account: string | null;
}

export interface CredentialHealth {
  revision: string;
  manualExpiry?: number;
  providerExpiry?: number;
  accountName?: string;
  status?: ProbeStatus;
  warnedDays?: number;
  lossReported?: boolean;
}

export function expiryOf(health: CredentialHealth | undefined): number | undefined {
  return health?.providerExpiry ?? health?.manualExpiry;
}

export function statusOf(health: CredentialHealth | undefined, now: number): IntegrationStatus {
  const expiresAt = expiryOf(health);
  if (expiresAt !== undefined && expiresAt <= now) return "expired";
  const checked = health?.status ?? "pending";
  if ((checked === "valid" || checked === "unavailable" || checked === "pending")
      && expiresAt !== undefined && expiresAt - now <= 3 * DAY_MS) return "expiring";
  return checked;
}

export function applyCredentialCheck(health: CredentialHealth, check: CredentialCheck): CredentialHealth {
  if (check.status === "unavailable"
      && (health.status === "rejected" || health.status === "expired" || health.status === "missing")) {
    return health;
  }
  if (health.status === check.status
      && (check.expiresAt === null || check.expiresAt === health.providerExpiry)
      && (check.account === null || check.account === health.accountName)) {
    return health;
  }
  const next = { ...health, status: check.status };
  if (check.expiresAt !== null) next.providerExpiry = check.expiresAt;
  if (check.account !== null) next.accountName = check.account;
  if (expiryOf(next) !== expiryOf(health)) delete next.warnedDays;
  if (check.status === "valid") delete next.lossReported;
  return next;
}

export function expiryWarningDays(health: CredentialHealth, now: number): number | undefined {
  const expiresAt = expiryOf(health);
  if (expiresAt === undefined || statusOf(health, now) !== "expiring") return undefined;
  const days = Math.ceil((expiresAt - now) / DAY_MS);
  return health.warnedDays === undefined || days < health.warnedDays ? days : undefined;
}
