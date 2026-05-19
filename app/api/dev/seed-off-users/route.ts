import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { appRoles, isAppRole } from "@/lib/rbac";
import { user } from "@/db/schema";

const DEV_OFF_PASSWORD = "Test12345";

const dummyUsers = [
  {
    name: "Admin OFF",
    email: "admin@admin.com",
    offRole: "admin",
    appRole: "admin",
  },
  {
    name: "Supervisor OFF",
    email: "spv@spv.com",
    offRole: "supervisor",
    appRole: "staff",
  },
  {
    name: "Sales Manager OFF",
    email: "sm@sm.com",
    offRole: "sales_manager",
    appRole: "staff",
  },
  {
    name: "Claim OFF",
    email: "claim@claim.com",
    offRole: "claim",
    appRole: "staff",
  },
  {
    name: "Operational Manager OFF",
    email: "om@om.com",
    offRole: "operational_manager",
    appRole: "staff",
  },
  {
    name: "Keuangan OFF",
    email: "keuangan@keuangan.com",
    offRole: "finance",
    appRole: "staff",
  },
  {
    name: "Sales OFF",
    email: "sales@sales.com",
    offRole: "sales",
    appRole: "staff",
  },
] as const;

function resolveAppRole(role: string): (typeof appRoles)[number] {
  if (isAppRole(role)) return role;

  if (isAppRole("staff")) return "staff";
  if (isAppRole("viewer")) return "viewer";
  if (isAppRole("admin")) return "admin";

  return appRoles[0];
}

export async function POST() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      {
        ok: false,
        error: "Not available in production",
      },
      { status: 403 },
    );
  }

  const results = [];

  for (const item of dummyUsers) {
    const email = item.email.trim().toLowerCase();

    try {
      const existing = await db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
        })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);

      if (existing[0]) {
        results.push({
          email,
          name: existing[0].name,
          offRole: item.offRole,
          appRole: item.appRole,
          status: "already_exists",
          userId: existing[0].id,
        });

        continue;
      }

      const appRole = resolveAppRole(item.appRole);

      const created = await auth.api.createUser({
        body: {
          name: item.name,
          email,
          password: DEV_OFF_PASSWORD,
          role: appRole,
          data: {
            emailVerified: true,
          },
        },
      });

      results.push({
        email,
        name: item.name,
        offRole: item.offRole,
        appRole,
        status: "created",
        userId: created.user.id,
      });
    } catch (error) {
      results.push({
        email,
        name: item.name,
        offRole: item.offRole,
        appRole: item.appRole,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    message: "DEV OFF dummy users seed completed.",
    password: DEV_OFF_PASSWORD,
    users: results,
    loginGuide: dummyUsers.map((item) => ({
      email: item.email,
      password: DEV_OFF_PASSWORD,
      expectedOffRole: item.offRole,
      appRole: item.appRole,
    })),
  });
}

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      {
        ok: false,
        error: "Not available in production",
      },
      { status: 403 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Use POST /api/dev/seed-off-users to create dummy OFF users.",
    developmentOnly: true,
    password: DEV_OFF_PASSWORD,
    users: dummyUsers.map((item) => ({
      email: item.email,
      password: DEV_OFF_PASSWORD,
      expectedOffRole: item.offRole,
      appRole: item.appRole,
    })),
  });
}
