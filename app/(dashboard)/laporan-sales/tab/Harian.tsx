/*
 * Tujuan: Tab "Monitoring Harian" /laporan-sales — STUB kerangka; diganti slice tab ini (kontrak lib/laporan-sales/kontrak.ts).
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx.
 */
"use client";

import { EmptyState } from "@/components/fiori/core";
import type { PropsTab } from "@/lib/laporan-sales/kontrak";

export default function Harian({ bulan }: PropsTab) {
    return <EmptyState title="Monitoring Harian" message={`Laporan bulan ${bulan} sedang disiapkan.`} />;
}
