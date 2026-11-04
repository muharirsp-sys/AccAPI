/*
 * Tujuan: Aturan murni Potong Tagihan OPC (owner 3 Nov 2026): item ber-cara bayar Potong Tagihan dicatat Incaso dengan nomor
 *   faktur yang dipotong. Satu item boleh dipotong dari lebih dari satu faktur; faktur wajib ada di data faktur tersinkron,
 *   pelanggannya wajib sama dengan toko item, dan total potongan per faktur tidak boleh melebihi sisa tagihannya.
 * Caller: app/api/off-program-control/batches/[id]/finance-payment/route.ts, app/api/off-program-control/faktur-potong/route.ts,
 *   opc/peran/Incaso.tsx (pratinjau di browser).
 * Dependensi: tidak ada (murni). Akses DB ada di potong-tagihan-db.ts.
 * Main Functions: nomorFakturKunci, cocokPelanggan, parseAlokasi, periksaAlokasi.
 * Side Effects: tidak ada.
 */

export type AlokasiPotong = { itemId: string; nomorFaktur: string; nominal: number };
export type FakturPotong = { id: number; number: string; customerNo: string | null; customerName: string | null; outstanding: number | null };
export type ItemPotong = { id: string; itemNo: number; toko: string | null; nominal: number };

const sen = (n: number) => Math.round(Number(n || 0) * 100);
const huruf = (s: string | null | undefined) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Kunci pembanding nomor faktur: spasi tepi dibuang, huruf besar. */
export const nomorFakturKunci = (no: string | null | undefined) => String(no || "").trim().toUpperCase();

/**
 * Toko item (teks bebas, mis. "TOKO A (C-TA0001)") cocok dengan pelanggan faktur bila memuat kode pelanggannya,
 * atau bila namanya (tanpa bagian dalam kurung) sama persis setelah tanda baca/spasi dibuang.
 */
export function cocokPelanggan(toko: string | null | undefined, customerNo: string | null | undefined, customerName: string | null | undefined): boolean {
    const kode = huruf(customerNo);
    if (kode && huruf(toko).includes(kode)) return true;
    const nama = huruf(String(toko || "").replace(/\([^)]*\)/g, ""));
    return Boolean(nama) && nama === huruf(customerName);
}

/** Muatan form `alokasi` (JSON larik). Baris kosong dibuang; nominal teks/angka diurai. Melempar bila bukan larik. */
export function parseAlokasi(raw: unknown): AlokasiPotong[] {
    const data = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    if (!Array.isArray(data)) throw new Error("Rincian faktur tidak valid.");
    return data.map((r) => ({
        itemId: String(r?.itemId || "").trim(),
        nomorFaktur: String(r?.nomorFaktur || "").trim(),
        nominal: Number(r?.nominal || 0),
    })).filter((r) => r.itemId || r.nomorFaktur || r.nominal);
}

export type HasilPeriksa = { ok: true } | { ok: false; error: string };

/**
 * Periksa seluruh rincian potong tagihan satu pencatatan.
 * `faktur`: hasil cari per kunci nomor (larik, karena data tersinkron bisa memuat nomor ganda).
 * `terpakai`: Σ potongan OPC yang SUDAH tercatat per kunci nomor faktur (sisa tagihan Accurate belum mengenalnya).
 */
export function periksaAlokasi(input: {
    items: ItemPotong[];
    alokasi: AlokasiPotong[];
    faktur: Map<string, FakturPotong[]>;
    terpakai: Map<string, number>;
}): HasilPeriksa {
    const { items, alokasi, faktur, terpakai } = input;
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const a of alokasi) {
        if (!byId.has(a.itemId)) return { ok: false, error: "Rincian faktur memuat item yang tidak dipilih." };
        if (!a.nomorFaktur) return { ok: false, error: `Item ${byId.get(a.itemId)!.itemNo}: nomor faktur wajib diisi.` };
        if (!(a.nominal > 0)) return { ok: false, error: `Item ${byId.get(a.itemId)!.itemNo}: nominal potongan faktur ${a.nomorFaktur} wajib lebih dari 0.` };
    }
    const perFakturItem = new Set<string>();
    for (const item of items) {
        const milik = alokasi.filter((a) => a.itemId === item.id);
        if (milik.length === 0) return { ok: false, error: `Item ${item.itemNo}: isi minimal satu nomor faktur.` };
        for (const a of milik) {
            const kunci = `${item.id}|${nomorFakturKunci(a.nomorFaktur)}`;
            if (perFakturItem.has(kunci)) return { ok: false, error: `Item ${item.itemNo}: faktur ${a.nomorFaktur} ditulis dua kali; gabungkan nominalnya.` };
            perFakturItem.add(kunci);
        }
        const jumlah = milik.reduce((t, a) => t + sen(a.nominal), 0);
        if (jumlah !== sen(item.nominal)) {
            return { ok: false, error: `Item ${item.itemNo}: total potongan faktur harus sama dengan nominal item.` };
        }
    }
    const perFaktur = new Map<string, number>();
    for (const a of alokasi) {
        const kunci = nomorFakturKunci(a.nomorFaktur);
        const hasil = faktur.get(kunci) ?? [];
        if (hasil.length === 0) return { ok: false, error: `Faktur ${a.nomorFaktur} tidak ditemukan di data faktur Accurate yang tersinkron.` };
        if (new Set(hasil.map((f) => f.id)).size > 1) return { ok: false, error: `Faktur ${a.nomorFaktur} tercatat ganda di data tersinkron. Hubungi admin.` };
        const f = hasil[0];
        const item = byId.get(a.itemId)!;
        if (!cocokPelanggan(item.toko, f.customerNo, f.customerName)) {
            return { ok: false, error: `Item ${item.itemNo}: faktur ${f.number} milik ${f.customerName || "-"} (${f.customerNo || "-"}), bukan toko ${item.toko || "-"}.` };
        }
        perFaktur.set(kunci, (perFaktur.get(kunci) ?? 0) + sen(a.nominal));
    }
    for (const [kunci, jumlah] of perFaktur) {
        const f = faktur.get(kunci)![0];
        if (f.outstanding == null) return { ok: false, error: `Sisa tagihan faktur ${f.number} belum diketahui. Segarkan data faktur lalu coba lagi.` };
        // ponytail: sisa = sisa tagihan tersinkron − potongan OPC yang sudah tercatat. Bila Incaso sudah membukukan potongan
        // itu di Accurate tetapi fakturnya belum lunas, potongan terhitung dua kali (terlalu ketat, tidak pernah terlalu longgar).
        const sisa = sen(f.outstanding) - sen(terpakai.get(kunci) ?? 0);
        if (jumlah > sisa) {
            return { ok: false, error: `Faktur ${f.number}: potongan Rp ${(jumlah / 100).toLocaleString("id-ID")} melebihi sisa tagihan Rp ${(Math.max(0, sisa) / 100).toLocaleString("id-ID")}.` };
        }
    }
    return { ok: true };
}
