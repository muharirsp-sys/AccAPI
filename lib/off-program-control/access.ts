export type OffRole =
  | "admin"
  | "supervisor"
  | "sales_manager"
  | "claim"
  | "operational_manager"
  | "finance"
  | "sales"
  | "unknown";

export type OffRoleSource =
  | "session"
  | "email"
  | "development_fallback"
  | "dev_preview"
  | "unknown";

export type OffTab =
  | "overview"
  | "supervisor"
  | "sales"
  | "claim"
  | "om"
  | "finance"
  | "audit";

export type OffAction =
  | "create_batch"
  | "edit_returned_batch"
  | "submit_batch"
  | "sm_approve"
  | "sm_return"
  | "claim_review"
  | "claim_final"
  | "om_approve"
  | "om_cancel"
  | "finance_payment";

export type OffRoleResolution = {
  role: OffRole;
  source: OffRoleSource;
  isFallback: boolean;
};

export type OffSessionUserLike = {
  role?: unknown;
  userRole?: unknown;
  type?: unknown;
  position?: unknown;
  department?: unknown;
  email?: unknown;
};

function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeOffRole(value?: unknown): OffRole {
  const text = toText(value);

  if (!text) return "unknown";

  const role = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  if (role === "admin") return "admin";

  if (role === "spv" || role === "supervisor") {
    return "supervisor";
  }

  if (role === "sm" || role === "sales_manager" || role === "salesmanager") {
    return "sales_manager";
  }

  if (role === "claim") return "claim";

  if (
    role === "om" ||
    role === "operational_manager" ||
    role === "operationalmanager"
  ) {
    return "operational_manager";
  }

  if (role === "finance" || role === "keuangan") {
    return "finance";
  }

  if (role === "sales") return "sales";

  return "unknown";
}

export function inferOffRoleFromEmail(email?: unknown): OffRole {
  const text = toText(email);

  if (!text || !text.includes("@")) return "unknown";

  const domain = text.split("@").pop()?.trim().toLowerCase();

  switch (domain) {
    case "admin.com":
      return "admin";

    case "spv.com":
    case "supervisor.com":
      return "supervisor";

    case "sm.com":
    case "salesmanager.com":
    case "sales-manager.com":
      return "sales_manager";

    case "claim.com":
      return "claim";

    case "om.com":
    case "operationalmanager.com":
    case "operational-manager.com":
      return "operational_manager";

    case "keuangan.com":
    case "finance.com":
      return "finance";

    case "sales.com":
      return "sales";

    default:
      return "unknown";
  }
}

export function resolveOffRoleFromUser(
  user?: OffSessionUserLike | null,
): OffRoleResolution {
  const sessionCandidates = [
    user?.role,
    user?.userRole,
    user?.type,
    user?.position,
    user?.department,
  ];

  for (const candidate of sessionCandidates) {
    const normalized = normalizeOffRole(candidate);

    if (normalized !== "unknown") {
      return {
        role: normalized,
        source: "session",
        isFallback: false,
      };
    }
  }

  const emailRole = inferOffRoleFromEmail(user?.email);

  if (emailRole !== "unknown") {
    return {
      role: emailRole,
      source: "email",
      isFallback: false,
    };
  }

  if (process.env.NODE_ENV === "development") {
    return {
      role: "admin",
      source: "development_fallback",
      isFallback: true,
    };
  }

  return {
    role: "unknown",
    source: "unknown",
    isFallback: false,
  };
}

/**
 * Backward-compatible resolver.
 *
 * - Jika dipanggil dengan string: return OffRole.
 * - Jika dipanggil dengan object user/session: return OffRoleResolution.
 */
export function resolveOffRole(value?: string | null): OffRole;
export function resolveOffRole(
  user?: OffSessionUserLike | null,
): OffRoleResolution;
export function resolveOffRole(
  input?: string | OffSessionUserLike | null,
): OffRole | OffRoleResolution {
  if (typeof input === "string" || input === null || input === undefined) {
    return normalizeOffRole(input);
  }

  return resolveOffRoleFromUser(input);
}

export function getOffAccessibleTabs(roleInput: OffRole | string): OffTab[] {
  const role = normalizeOffRole(roleInput);

  switch (role) {
    case "admin":
      return [
        "overview",
        "supervisor",
        "sales",
        "claim",
        "om",
        "finance",
        "audit",
      ];

    case "supervisor":
      return ["supervisor"];

    case "sales_manager":
      return ["overview", "sales"];

    case "claim":
      return ["claim"];

    case "operational_manager":
      return ["overview", "om"];

    case "finance":
      return ["finance"];

    case "sales":
      return [];

    default:
      return [];
  }
}

export function canAccessOffTab(
  roleInput: OffRole | string,
  tab: OffTab | string,
): boolean {
  return getOffAccessibleTabs(roleInput).includes(tab as OffTab);
}

export function canPerformOffAction(
  roleInput: OffRole | string | null | undefined,
  action: OffAction,
): boolean {
  const role = normalizeOffRole(roleInput);

  if (role === "admin") return true;

  const allowedActions: Record<OffRole, OffAction[]> = {
    admin: [],
    supervisor: ["create_batch", "edit_returned_batch", "submit_batch"],
    sales_manager: ["sm_approve", "sm_return"],
    claim: ["claim_review", "claim_final"],
    operational_manager: ["om_approve", "om_cancel"],
    finance: ["finance_payment"],
    sales: [],
    unknown: [],
  };

  return allowedActions[role]?.includes(action) ?? false;
}

export function getOffRoleBadgeLabel(
  resolutionOrRole: OffRoleResolution | OffRole | string,
): string {
  if (typeof resolutionOrRole === "string") {
    return normalizeOffRole(resolutionOrRole);
  }

  if (resolutionOrRole.source === "email") {
    return `${resolutionOrRole.role} (from email domain)`;
  }

  if (resolutionOrRole.source === "development_fallback") {
    return `${resolutionOrRole.role} (fallback dev)`;
  }

  if (resolutionOrRole.source === "dev_preview") {
    return `${resolutionOrRole.role} (dev preview)`;
  }

  if (resolutionOrRole.source === "unknown") {
    return "unknown";
  }

  return resolutionOrRole.role;
}
