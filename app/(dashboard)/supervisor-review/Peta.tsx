"use client";
/*
 * Tujuan: peta Supervisor Review — STUB kontrak. SR-3 mengganti isinya (Leaflet + OSM); SR-2 hanya MEMAKAI komponen ini, tidak menyuntingnya.
 * Props tetap: penanda toko + kunjungan (titik check-in, garis urutan bila satu salesman dipilih).
 */
import { EmptyState } from "@/components/fiori/core";
import type { Kunjungan, PenandaToko } from "@/lib/supervisor-review/kontrak";

export interface PetaProps {
    penanda: PenandaToko[];
    kunjungan: Kunjungan[];
    /** null = semua salesman dalam cakupan; terisi = saring + gambar garis urutan check-in. */
    salesCodeTerpilih: string | null;
}

export default function Peta({ penanda }: PetaProps) {
    return <EmptyState title="Peta menyusul" message={`${penanda.length} toko berkoordinat.`} />;
}
