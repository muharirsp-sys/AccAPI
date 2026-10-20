/*
 * Tujuan: Tab "Target vs Realisasi" /laporan-sales — STUB kerangka; diganti slice tab ini (kontrak lib/laporan-sales/kontrak.ts).
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx.
 */
"use client";

import { EmptyState } from "@/components/fiori/core";
import type { PropsTab } from "@/lib/laporan-sales/kontrak";

export default function Target({ bulan }: PropsTab) {
    return <EmptyState title="Target vs Realisasi" message={`Laporan bulan ${bulan} sedang disiapkan.`} />;
}
