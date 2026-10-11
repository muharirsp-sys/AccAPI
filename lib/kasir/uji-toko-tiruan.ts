/*
 * Tujuan: Toko tiruan (TokoBaca) untuk UJI pembaca pelunasan K1b tanpa Postgres — aturan lease 2 mnt, jeda lengkap 60 dtk, token dicek di
 *   setiap tulis, lengkap_pada hanya maju: sama dengan tokoPg (SQL-nya diuji di lib/kasir/baca-pg.test.ts).
 * Caller: lib/kasir/baca-pelunasan.test.ts, lib/kasir/segarkan-route.test.ts. BUKAN untuk produksi (tidak diimpor app/).
 * Side Effects: tidak ada (memori saja).
 */
import { belumDibaca, JEDA_LENGKAP_DETIK, LEASE_DETIK, type StatusBaca, type TokoBaca } from "./baca-pelunasan.ts";
import type { Ditolak } from "./pembaca.ts";
import type { Pelunasan } from "./rekonsiliasi.ts";

type Row = { status: StatusBaca["status"]; token: string | null; mulai: number; selesai: number | null; lengkap: number | null; sebab: string | null;
    pesan: string | null; jumlahDaftar: number | null; sisaDetail: number | null; ditolak: Ditolak[]; pemicu: string; akun: string | null;
    penuhTertunda: number | null };

export function tokoTiruan(jam: { t: number }, databaseId = "DB-UJI") {
    const rows = new Map<string, Row>();
    const cache = new Map<number, { tanggal: string; lastUpdate: string | null; p: Pelunasan }>();
    const klaimPenuh: string[] = [];
    const ke = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const status = (tanggal: string): StatusBaca => {
        const r = rows.get(tanggal);
        return r ? { databaseId, tanggal, status: r.status, aktif: r.status === "berjalan" && jam.t - r.mulai < LEASE_DETIK * 1000,
            sebab: r.sebab as StatusBaca["sebab"], pesan: r.pesan, jumlahDaftar: r.jumlahDaftar, sisaDetail: r.sisaDetail, ditolak: r.ditolak,
            mulaiPada: ke(r.mulai), selesaiPada: ke(r.selesai), lengkapPada: ke(r.lengkap), pemicu: r.pemicu, akunSinkron: r.akun,
            penuhTertundaPada: ke(r.penuhTertunda) } : belumDibaca(databaseId, tanggal);
    };
    const sah = (tanggal: string, token: string) => rows.get(tanggal)?.token === token && rows.get(tanggal)?.status === "berjalan";
    const toko: TokoBaca = {
        async klaim({ tanggal, token, pemicu, penuh, akun }) {
            const r = rows.get(tanggal);
            const aktif = r?.status === "berjalan" && jam.t - r.mulai < LEASE_DETIK * 1000;
            const tertunda = (r?.penuhTertunda ?? null) !== null;
            const jeda = !penuh && !tertunda && r?.status === "lengkap" && jam.t - (r.selesai ?? 0) < JEDA_LENGKAP_DETIK * 1000;
            if (aktif || jeda) return { diklaim: false, status: status(tanggal) };
            if (penuh || tertunda) klaimPenuh.push(`${tanggal}:${pemicu}`);
            const akunLama = r ? r.akun : akun; // akun TIDAK ditimpa klaim (hanya diisi saat baris baru)
            rows.set(tanggal, { jumlahDaftar: null, sisaDetail: null, ditolak: [], lengkap: null, penuhTertunda: null, ...r, status: "berjalan", token,
                mulai: jam.t, selesai: null, sebab: null, pesan: null, pemicu, akun: akunLama });
            return { diklaim: true, akunLama, penuhTertunda: tertunda };
        },
        async tandaiPenuhTertunda(_db, tanggal) {
            const r = rows.get(tanggal);
            if (r && r.penuhTertunda === null) r.penuhTertunda = jam.t;
        },
        status: async (_db, tanggal) => status(tanggal),
        cache: async (_db, tanggal) => new Map([...cache].filter(([, v]) => v.tanggal === tanggal).map(([id, v]) => [id, v.lastUpdate])),
        async tandaiBasi(token, _db, tanggal) {
            if (!sah(tanggal, token)) return false;
            for (const v of cache.values()) if (v.tanggal === tanggal) v.lastUpdate = null;
            rows.get(tanggal)!.penuhTertunda = null;
            return true;
        },
        async tulis(token, _db, p, lastUpdate) {
            if (!sah(p.tanggal, token)) return false;
            cache.set(p.id, { tanggal: p.tanggal, lastUpdate, p });
            return true;
        },
        async hapus(token, _db, tanggal, ids) {
            if (!sah(tanggal, token)) return false;
            for (const id of ids) if (cache.get(id)?.tanggal === tanggal) cache.delete(id);
            return true;
        },
        nomor: async (_db, ids) => new Map(ids.filter((id) => cache.has(id)).map((id) => [id, cache.get(id)!.p.nomor])),
        async selesai(token, _db, tanggal, a, ditolak, akun) {
            if (!sah(tanggal, token)) return null;
            const r = rows.get(tanggal)!;
            Object.assign(r, { status: a.status, sebab: a.sebab, pesan: a.pesan, jumlahDaftar: a.jumlahDaftar, sisaDetail: a.sisaDetail, ditolak,
                token: null, selesai: jam.t, lengkap: a.status === "lengkap" ? jam.t : r.lengkap, akun });
            return status(tanggal);
        },
    };
    return { toko, rows, cache, klaimPenuh };
}
