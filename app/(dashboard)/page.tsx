// Tujuan: Landing dashboard untuk akses cepat modul operasional Smart ERP dengan satu pintu Accurate.
// Caller: Route Next.js dashboard `/`.
// Dependensi: `lucide-react`, `next/link`, Better Auth, Drizzle user, helper RBAC, daftar modul lokal.
// Main Functions: `DashboardLanding`, `MODULES`.
// Side Effects: DB read user permissions dan navigasi via link.

import {
  Percent,
  CalendarCheck2,
  DollarSign,
  Wallet,
  Database,
  ArrowRight,
  Settings2,
  ShieldCheck,
  Cpu,
} from "lucide-react";
import Link from "next/link";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { canAccessPath, normalizeRole } from "@/lib/rbac";

const MODULES = [
  {
    title: "AOL Form Engine",
    desc: "API Injector ke Accurate Online massal. Bypass web forms.",
    icon: Settings2,
    href: "/api-wrapper",
    iconWrap: "bg-brand-50 text-brand-500 dark:bg-brand-500/15 dark:text-brand-400",
    border: "border-brand-200 hover:border-brand-300 dark:border-brand-500/30",
  },
  {
    title: "Validator Diskon",
    desc: "Lakukan validasi data potongan diskon manual secara bulk.",
    icon: Percent,
    href: "/validator",
    iconWrap:
      "bg-success-50 text-success-500 dark:bg-success-500/15 dark:text-success-500",
    border: "border-success-200 hover:border-success-300 dark:border-success-500/30",
  },
  {
    title: "Summary Promo",
    desc: "Ekstraksi PDF otomatis dengan regex AI dan kompilasi SPT.",
    icon: CalendarCheck2,
    href: "/summary",
    iconWrap:
      "bg-blue-light-50 text-blue-light-500 dark:bg-blue-light-500/15 dark:text-blue-light-400",
    border:
      "border-blue-light-200 hover:border-blue-light-300 dark:border-blue-light-500/30",
  },
  {
    title: "Finance",
    desc: "Review transfer, bukti pembayaran, dan posting purchase-payment.",
    icon: DollarSign,
    href: "/finance",
    iconWrap: "bg-warning-50 text-warning-500 dark:bg-warning-500/15 dark:text-warning-400",
    border: "border-warning-200 hover:border-warning-300 dark:border-warning-500/30",
  },
  {
    title: "Pembayaran & SPPD",
    desc: "Manajemen LPB / CBD dan auto-generate draft cart SPPD.",
    icon: Wallet,
    href: "/payments",
    iconWrap: "bg-error-50 text-error-500 dark:bg-error-500/15 dark:text-error-400",
    border: "border-error-200 hover:border-error-300 dark:border-error-500/30",
  },
  {
    title: "Master Principle",
    desc: "Konfigurasi kamus data principle untuk PDF Extraction AI.",
    icon: Database,
    href: "/principles",
    iconWrap: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    border: "border-gray-200 hover:border-gray-300 dark:border-gray-700",
  },
];

export default async function DashboardLanding() {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = String(session?.user?.id || "");
  const [dbUser] = userId
    ? await db
        .select({ role: user.role, permissions: user.permissions })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)
    : [];
  const role = normalizeRole(dbUser?.role || session?.user?.role);
  const permissions = dbUser?.permissions || "{}";
  const visibleModules = MODULES.filter((mod) =>
    canAccessPath(mod.href, role, permissions),
  );

  return (
    <div className="mx-auto max-w-7xl pb-12 pt-2">
      <div className="relative mb-10 overflow-hidden rounded-2xl border border-gray-200 bg-white p-8 shadow-theme-md md:p-12 dark:border-gray-800 dark:bg-white/[0.03]">
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-success-500/10 blur-3xl" />

        <div className="relative z-10 flex flex-col items-center justify-between gap-10 md:flex-row">
          <div className="flex-1 space-y-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-brand-600 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              <ShieldCheck size={14} /> ERP Sistem Terpusat
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900 md:text-4xl dark:text-white/90">
              Portal Internal
              <br className="hidden md:block" />
              <span className="text-brand-500 dark:text-brand-400">
                CV. Surya Perkasa
              </span>
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-gray-500 dark:text-gray-400">
              Akses modul operasional, finansial, validator, summary, dan satu
              pintu injeksi Accurate dalam dashboard terpadu.
            </p>
          </div>

          <div className="relative hidden h-52 w-52 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 lg:flex dark:border-gray-700 dark:bg-gray-800">
            <Cpu
              size={72}
              className="text-brand-500/40 transition-transform duration-500 hover:scale-105 dark:text-brand-400/50"
            />
          </div>
        </div>
      </div>

      <div className="mb-4">
        <h2 className="mb-6 flex items-center gap-2 px-1 text-lg font-semibold text-gray-800 dark:text-white/90">
          <span className="block h-6 w-1.5 rounded-full bg-brand-500" />
          Modul Operasional
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleModules.map((mod) => {
            const Icon = mod.icon;
            return (
              <Link
                href={mod.href}
                key={mod.href}
                className={`group flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-theme-xs transition hover:-translate-y-0.5 hover:shadow-theme-md dark:bg-white/[0.03] ${mod.border}`}
              >
                <div>
                  <div
                    className={`mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 transition-transform group-hover:scale-105 dark:border-gray-800 ${mod.iconWrap}`}
                  >
                    <Icon size={24} />
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-gray-800 dark:text-white/90">
                    {mod.title}
                  </h3>
                  <p className="mb-6 line-clamp-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                    {mod.desc}
                  </p>
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-gray-100 pt-4 dark:border-gray-800">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-brand-500 dark:text-brand-400">
                    Akses Modul
                  </span>
                  <ArrowRight
                    size={16}
                    className="text-gray-400 transition group-hover:translate-x-1 group-hover:text-brand-500 dark:group-hover:text-brand-400"
                  />
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="mt-12 border-t border-gray-200 py-6 text-center dark:border-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          V1.0.0 &copy; 2026 Core ERP Infrastructure - PT. Surya Perkasa
        </p>
      </div>
    </div>
  );
}
