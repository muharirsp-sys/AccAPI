/*
 * Tujuan: Ringkasan Kasir untuk tile Beranda (K3, BL-59): selisih belum dijelaskan (orang + ember tak teralokasi), salesman belum
 *   menyetor, hari belum ditutup (hari ini + 7 hari kerja terakhir). BACA-SAJA dari cache K1b + tabel kasir_*; tidak pernah memicu
 *   Accurate dan tidak menulis (tanpa kunci otomatis 20.00 seperti GET /api/kasir). Angka = angka layar /kasir: dihitung dari
 *   JawabanHari yang sama (bentukJawabanHari) dengan rumus KPI layar; Tutup memakai statusHari yang sama.
 * Keputusan: owner 17 Okt (K3). Kontrak: docs/handover/KASIR-KONTRAK.md §9.
 * Caller: app/api/kasir/ringkasan/route.ts; lib/beranda.ts membaca bentuk jawabannya (SOURCES.kasir).
 * Dependensi: lib/kasir/hari (muatDalam, bentukJawabanHari), lib/kasir/rekonsiliasi (statusHari, hariKerja), db/schema.
 * Main Functions: jendelaTutup, bentukRingkasan (murni), muatRingkasan (satu snapshot REPEATABLE READ baca-saja).
 * Side Effects: SELECT saja.
 */
import { asc, inArray } from "drizzle-orm";
import { kasirHariEvent } from "@/db/schema";
import { bawaanHari, bentukJawabanHari, muatDalam, type DepsHari, type Muatan } from "./hari.ts";
import { hariKerja, statusHari, type EventHari } from "./rekonsiliasi.ts";

/** Berapa hari kerja SEBELUM hari ini yang ikut dihitung "belum ditutup". */
export const HARI_KERJA_MUNDUR = 7;

export type EventJendela = EventHari & { tanggal: string };

const geser = (t: string, n: number) => new Date(Date.parse(`${t}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Hari ini (`tanggal`, ikut bila hari kerja Senin–Sabtu; Minggu dikecualikan, keputusan owner) + 7 hari kerja sebelumnya, urut lama -> baru. */
export function jendelaTutup(tanggal: string): string[] {
    const mundur: string[] = [];
    for (let n = 1; mundur.length < HARI_KERJA_MUNDUR; n++) {
        const t = geser(tanggal, -n);
        if (hariKerja(t)) mundur.push(t);
    }
    return [...mundur.reverse(), ...(hariKerja(tanggal) ? [tanggal] : [])];
}

/**
 * Murni (diuji tanpa DB). Angka Incaso HANYA bila status baca `lengkap` (selain itu `null` = "belum terbaca", BUKAN nol); hari belum
 * ditutup tidak bergantung pada Incaso. Selisih = orang berstatus `selisih` belum dijelaskan + ember tak teralokasi belum dijelaskan
 * (persis KPI layar); belumSetor = SEMUA orang ber-pelunasan tanpa setoran (`belumDijelaskan` = angka KPI layar).
 */
export function bentukRingkasan(m: Muatan, events: readonly EventJendela[], jendela: readonly string[], sekarang: Date) {
    const h = bentukJawabanHari(m, { sekarang, orang: null, namaUser: new Map(), baca: null });
    const L = h.incaso.lengkap;
    const nSelisih = h.orang.filter((o) => o.status === "selisih" && !o.dijelaskan).length;
    const nTak = h.total.takTeralokasiBelumDijelaskan ?? 0;
    const belumSetor = h.orang.filter((o) => o.status === "belum_setor");
    const belumTutup = jendela.filter((t) => statusHari(t, events.filter((e) => e.tanggal === t), sekarang).sebab !== "tutup");
    return {
        ok: true as const,
        tanggal: m.tanggal,
        sekarang: sekarang.toISOString(),
        incaso: h.incaso,
        baca: m.baca ? { status: m.baca.status, lengkapPada: m.baca.lengkapPada } : null,
        selisih: L ? { orang: nSelisih, takTeralokasi: nTak, jumlah: nSelisih + nTak } : null,
        belumSetor: L ? { jumlah: belumSetor.length, belumDijelaskan: belumSetor.filter((o) => !o.dijelaskan).length } : null,
        hariBelumDitutup: { jumlah: belumTutup.length, tanggal: belumTutup, jendela: [...jendela] },
    };
}
export type RingkasanKasir = ReturnType<typeof bentukRingkasan>;

/** Satu snapshot REPEATABLE READ baca-saja: muatan hari `tanggal` (sama dengan GET /api/kasir) + event Tutup jendela. */
export async function muatRingkasan(tanggal: string, deps: DepsHari = bawaanHari): Promise<RingkasanKasir> {
    const databaseId = (await deps.databaseId()).trim();
    const jendela = jendelaTutup(tanggal);
    const { m, ev } = await deps.db.transaction(async (tx) => ({
        m: await muatDalam(tx, tanggal, databaseId),
        ev: await tx.select({ tanggal: kasirHariEvent.tanggal, id: kasirHariEvent.id, jenis: kasirHariEvent.jenis, pada: kasirHariEvent.pada, alasan: kasirHariEvent.alasan })
            .from(kasirHariEvent).where(inArray(kasirHariEvent.tanggal, jendela)).orderBy(asc(kasirHariEvent.id)),
    }), { isolationLevel: "repeatable read", accessMode: "read only" });
    const events = ev.map((e): EventJendela => ({ tanggal: e.tanggal, id: Number(e.id), jenis: e.jenis as EventHari["jenis"], pada: e.pada, alasan: e.alasan }));
    return bentukRingkasan(m, events, jendela, deps.sekarang());
}
