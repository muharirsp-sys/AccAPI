/*
 * Tujuan: Tab "Tidak Order" /laporan-sales — STUB kerangka; diganti slice tab ini (kontrak lib/laporan-sales/kontrak.ts).
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx.
 */
"use client";

import { EmptyState } from "@/components/fiori/core";
import type { PropsTab } from "@/lib/laporan-sales/kontrak";

export default function TidakOrder({ bulan }: PropsTab) {
    return <EmptyState title="Tidak Order" message={`Laporan bulan ${bulan} sedang disiapkan.`} />;
}
