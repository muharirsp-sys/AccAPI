/*
 * Tujuan: Halaman kit internal design system Fiori (baseline visual Playwright untuk slice S0).
 * Caller: Next.js route /dev/ui-kit (grup dashboard: login + RBAC layout tetap berlaku).
 * Dependensi: UiKit (client), next/navigation notFound.
 * Main Functions: UiKitPage.
 * Side Effects: Tidak ada; 404 di build produksi.
 */
import { notFound } from "next/navigation";
import UiKit from "./UiKit";

// ponytail: hanya development (baseline Playwright lokal). Bila kit perlu ada di produksi, ganti dengan entri
// pagePermissions "/dev/ui-kit" → users.manage di lib/rbac.ts (zona otorisasi, perlu tinjauan).
export default function UiKitPage() {
    if (process.env.NODE_ENV === "production") notFound();
    return <UiKit />;
}
