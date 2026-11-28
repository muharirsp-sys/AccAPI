/**
 * Tujuan: parser Format Pelunasan Internal (Excel → payload `sales-receipt/bulk-save`) sebagai fungsi murni — dipindah
 *   dari `handleFileUpload` W:600-1629 `app/(dashboard)/api-wrapper/page.tsx` basis 5d6cc936 (S6e-1).
 *   Urutan kerja SAMA dengan kode lama: kumpulkan kueri → cari retur (berurutan) → cari faktur → alokasi → finalisasi.
 *   Perilaku dikunci golden lib/pelunasan/uji/golden.json.
 * Caller: app/(dashboard)/api-wrapper/page.tsx (handleFileUpload); S6e-2 (wizard Pelunasan).
 * Main Functions: deteksiFormatPelunasan, parsePelunasan.
 * Side Effects: GET Accurate lewat `accurateFetch` DIINJEKSI (tidak pernah menulis). Progres/toast lewat callback `lapor`;
 *   unduhan "Retur Manual" TIDAK dilakukan di sini — `manualRows` dikembalikan ke pemanggil.
 */
import { getTextVal, getVal, type Bebas } from "./sel.ts";
import { buildReturLookupKey, cariRetur, isAyatSilangReference, type AccurateFetch, type KueriRetur } from "./retur.ts";
import { cariFaktur } from "./cari-faktur.ts";
import { alokasikan, type BarisDilewati, type PetaAkun } from "./alokasi.ts";
import { finalisasiPayload, pesanPeringatanRetur, susunBarisManual } from "./payload.ts";

export type JenisLapor = "loading" | "success" | "warning" | "error";
/** `opsi.id` = id toast yang dipakai kode lama ("parse"); peringatan retur tidak ber-id. */
export type Lapor = (jenis: JenisLapor, pesan: string, opsi?: { id: string }) => void;

/** W:600-622. sheet_to_json mengabaikan kolom kosong, jadi detector format harus toleran jika `Total.Trx` tidak ikut terbaca. */
export const deteksiFormatPelunasan = (cleanedData: Bebas[]) => cleanedData.length > 0 && cleanedData.some((r: Bebas) => {
    const hasCoreKeys = "Code Outlet" in r && "No. Nota" in r;
    const hasPelunasanSignals = [
        "Tunai",
        "Trf",
        "BG",
        "Total.Trx",
        "Ket. All Trx",
        "Pot.1 Kwtnsi",
        "Pot.2 Kwtnsi",
        "Pot.3 Kwtnsi",
        "Pot.DiscTB",
        "Pot.RT Ktr",
        "Pot. RT Gt",
        "Pot. Lain",
        "Ket. Pot",
        "No.SRB Rt Ktr",
        "No.RJS RT Gt"
    ].some((key) => key in r);

    return hasCoreKeys && hasPelunasanSignals;
});

/** W:627-662: kueri retur (kunci = buildReturLookupKey) + himpunan No. Nota. */
function kumpulkanKueri(cleanedData: Bebas[]) {
    const returQueries = new Map<string, KueriRetur>();
    const invoiceNos = new Set<string>();

    cleanedData.forEach((r: Bebas) => {
        const cust = getTextVal(r, "Code Outlet");
        if (!cust) return;

        const invNo = getTextVal(r, "No. Nota");

        const srb = getTextVal(r, "No.SRB Rt Ktr");
        if (srb) {
            const key = buildReturLookupKey(cust, srb);
            if (!returQueries.has(key)) returQueries.set(key, { desc: srb, invNos: new Set(), sourceCustomerNo: cust, isAyatSilang: isAyatSilangReference(srb) });
            if (invNo) returQueries.get(key)!.invNos.add(invNo);
        }

        const rjs = getTextVal(r, "No.RJS RT Gt");
        if (rjs) {
            const key = buildReturLookupKey(cust, rjs);
            if (!returQueries.has(key)) returQueries.set(key, { desc: rjs, invNos: new Set(), sourceCustomerNo: cust, isAyatSilang: isAyatSilangReference(rjs) });
            if (invNo) returQueries.get(key)!.invNos.add(invNo);
        }

        const ketPot = getTextVal(r, "Ket. Pot");
        if (ketPot && (ketPot.toUpperCase().includes('RJN') || ketPot.toUpperCase().includes('SRT'))) {
            const potLain = Number(getVal(r, "Pot. Lain")) || 0;
            if (potLain > 0) {
                const key = buildReturLookupKey(cust, ketPot);
                if (!returQueries.has(key)) returQueries.set(key, { desc: ketPot, invNos: new Set(), sourceCustomerNo: cust, isAyatSilang: true });
                if (invNo) returQueries.get(key)!.invNos.add(invNo);
            }
        }

        if (invNo) invoiceNos.add(invNo);
    });
    return { returQueries, invoiceNos };
}

const rp = (n: number) => `Rp ${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
const tglAccurate = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

/**
 * Laporan PERLU_CEK (pemilik 28 Nov 2026 "masukkan ke laporan saja"): keterangan tiap baris ditambah pelunasan Accurate yang menyentuh
 * fakturnya (nomor, tanggal, nilai) dan tanda dugaan input dobel (tanggal + nilai sama), supaya admin/Finance bisa menyelesaikannya
 * tanpa menelusuri Accurate. Bukti P.27-11-2026: INV/2610/HZ02233 dilunasi 2× Rp 700.000 pada 28/11 (110102.2026.11.16019 & 16020).
 * ponytail: jendela 60 hari sebelum tanggal berkas s.d. hari ini, ≤ 30 pelunasan per pelanggan (detail.do satu per satu); pelunasan
 * lebih lama tidak tampak. Galat baca = catatan "tidak terbaca", Tinjau tetap jalan. Baca-saja.
 */
async function buktiPerluCek(baris: BarisDilewati[], invoiceBranchMap: Map<string, Bebas>, trxDate: string, accurateFetch: AccurateFetch) {
    const awal = new Date(`${trxDate}T00:00:00Z`);
    awal.setUTCDate(awal.getUTCDate() - 60);
    const akhir = new Date(Date.now() + 8 * 3600_000 + 24 * 3600_000); // besok WITA: pelunasan hari ini ikut
    const perPelanggan = new Map<string, BarisDilewati[]>();
    for (const b of baris) {
        const cust = String(invoiceBranchMap.get(String(b.invoiceNo).trim())?.customerNo ?? "").trim();
        if (!cust) { b.detail = `${b.detail ?? ""} Pelunasan di Accurate: pelanggan faktur tidak terbaca.`; continue; }
        perPelanggan.set(cust, [...(perPelanggan.get(cust) ?? []), b]);
    }
    for (const [cust, daftar] of perPelanggan) {
        const temuan = new Map<string, Array<{ nomor: string; tanggal: string; nilai: number }>>();
        try {
            const list = await accurateFetch("/api/sales-receipt/list.do", "GET", {
                fields: "id,number,transDate", "filter.customerNo": cust, "filter.transDate.op": "BETWEEN",
                "filter.transDate.val[0]": tglAccurate(awal), "filter.transDate.val[1]": tglAccurate(akhir), "sp.pageSize": 30,
            });
            for (const c of (Array.isArray(list?.d) ? list.d : []).slice(0, 30)) {
                const d = (await accurateFetch("/api/sales-receipt/detail.do", "GET", { id: c.id }))?.d;
                for (const x of (Array.isArray(d?.detailInvoice) ? d.detailInvoice : [])) {
                    const no = String(x?.invoice?.number ?? x?.invoiceNo ?? "").trim();
                    if (!daftar.some((b) => String(b.invoiceNo).trim() === no)) continue;
                    temuan.set(no, [...(temuan.get(no) ?? []), { nomor: String(d.number ?? c.number), tanggal: String(d.transDate ?? c.transDate ?? ""), nilai: Number(x.paymentAmount) || 0 }]);
                }
            }
        } catch {
            for (const b of daftar) b.detail = `${b.detail ?? ""} Pelunasan di Accurate: tidak terbaca (ulangi pratinjau untuk melihatnya).`;
            continue;
        }
        for (const b of daftar) {
            const t = temuan.get(String(b.invoiceNo).trim()) ?? [];
            const kembar = t.filter((x, i) => t.some((y, j) => j !== i && y.tanggal === x.tanggal && Math.abs(y.nilai - x.nilai) < 0.01));
            b.detail = `${b.detail ?? ""} Pelunasan di Accurate sejak ${tglAccurate(awal)}: `
                + (t.length ? t.map((x) => `${x.nomor} (${x.tanggal}) ${rp(x.nilai)}`).join("; ") : "tidak ada")
                + (kembar.length ? `. DUGAAN INPUT DOBEL: ${kembar.map((x) => x.nomor).join(", ")} (tanggal & nilai sama).` : ".");
        }
    }
}

export type OpsiPelunasan = {
    /** Tanggal transaksi YYYY-MM-DD (dari pemilih tanggal halaman). */
    trxDate: string;
    /** Database Accurate sudah terbuka; tanpa ini tidak ada pencarian retur/faktur (seperti kode lama). */
    isKeySaved: boolean;
    peta: PetaAkun;
    accurateFetch: AccurateFetch;
    lapor?: Lapor;
};

/**
 * Baris Excel Pelunasan (sudah `sheet_to_json` + header `(*wajib)` dibersihkan) → payload sales-receipt.
 * Pemanggil memastikan `deteksiFormatPelunasan(rows)` true. Baris masukan disalin dangkal (tidak dimutasi).
 * `manualRows` = baris laporan retur/pot.lain yang belum ketemu (null bila tidak ada) — pemanggil yang mengunduh.
 * `counts` (S6e-2 butir 9) = baris data dibaca + yang dilewati beserta alasannya (langkah Tinjau); payload/manualRows tidak berubah.
 */
export async function parsePelunasan(rows: Bebas[], opsi: OpsiPelunasan): Promise<{ payload: Bebas[]; manualRows: Bebas[] | null; counts: { read: number; skipped: BarisDilewati[] } }> {
    const { trxDate, isKeySaved, accurateFetch } = opsi;
    const lapor: Lapor = opsi.lapor ?? (() => {});
    const cleanedData = rows.map((r) => ({ ...r }));

    lapor("loading", "Membedah Format Pelunasan Internal...", { id: "parse" });

    const { returQueries, invoiceNos } = kumpulkanKueri(cleanedData);

    const returMap = new Map<string, Bebas>();
    if (returQueries.size > 0 && isKeySaved) {
        lapor("loading", `Mencari ${returQueries.size} referensi Retur Penjualan...`, { id: "parse" });
        try {
            await cariRetur(returQueries, returMap, accurateFetch);
        } catch {
            lapor("error", "Gagal menarik data Retur Penjualan", { id: "parse" });
        }
        // Celah 4D (27 Nov 2026): akun Accurate tanpa hak "Lihat Retur Penjualan" → pencarian SRB galat, ditelan jadi NOT_FOUND, lalu masuk
        // retur manual berlabel "belum ditemukan" walau returnya ada. Bukti putar ulang 26/11: 9 penolakan sales-return/list.do.
        // Satu RJN/SRT bisa tercantum di daftar beberapa baris (teks daftar berbeda = entri returMap berbeda, tiap entri salinan sendiri):
        // alokasi memotong sisa (primeOwing) di objeknya, jadi tanpa ini sisa yang sama terpakai berulang. Satu objek per nomor dokumen.
        const satuDok = new Map<string, Bebas>();
        for (const v of returMap.values()) {
            if (Array.isArray(v.returns)) v.returns = v.returns.map((r: Bebas) => !r?.number ? r : satuDok.get(r.number) ?? (satuDok.set(r.number, r), r));
        }
        const tanpaHak = [...returMap.values()].filter((r) => r.number === "NOT_FOUND" && /tidak memiliki hak/i.test(String(r.DEBUG_RAW ?? ""))).length;
        if (tanpaHak > 0) {
            lapor("warning", `${tanpaHak} referensi retur tidak bisa dicari: akun Accurate di sesi ini tidak punya hak Lihat Retur Penjualan. `
                + "Baris yang masih memerlukan retur itu masuk retur manual walau returnya mungkin ada di Accurate; masuk Accurate dengan akun yang "
                + "berhak lalu ulangi pratinjau.");
        }
    }

    let invoiceBranchMap = new Map<string, Bebas>();
    let invoiceLookupDebugMap = new Map<string, Bebas>();
    if (invoiceNos.size > 0 && isKeySaved) {
        lapor("loading", `Menarik data Cabang dari ${invoiceNos.size} tagihan Invoice...`, { id: "parse" });
        ({ invoiceBranchMap, invoiceLookupDebugMap } = await cariFaktur(invoiceNos, accurateFetch));
    }

    const { groupedMap, ayatSilangDocs, unresolvedReturWarnings, dilewati, trxTakCocok, hanyaReturBaris, returIkutAccurate } = alokasikan(cleanedData, {
        trxDate, peta: opsi.peta, returMap, invoiceBranchMap, invoiceLookupDebugMap,
    });
    const perluCek = dilewati.filter((d) => d.reason === "PERLU_CEK" && d.invoiceNo);
    if (perluCek.length > 0 && isKeySaved) {
        lapor("loading", `Mencari pelunasan di Accurate untuk ${perluCek.length} baris perlu cek...`, { id: "parse" });
        await buktiPerluCek(perluCek, invoiceBranchMap, trxDate, accurateFetch);
    }

    const payload = finalisasiPayload(Array.from(groupedMap.values()), ayatSilangDocs);
    if (trxTakCocok.length > 0) {
        const contoh = trxTakCocok.slice(0, 8).join(", ");
        lapor("warning", `${trxTakCocok.length} baris: Total.Trx berbeda dari jumlah kolom pembayaran (kolom Total.Trx di berkas tampak bergeser); `
            + `yang dipakai jumlah kolom Tunai/Trf/BG/potongan/retur. Baris data ke-${contoh}${trxTakCocok.length > 8 ? ", …" : ""}.`);
    }
    if (hanyaReturBaris.length > 0) {
        const contoh = hanyaReturBaris.slice(0, 8).join(", ");
        lapor("warning", `${hanyaReturBaris.length} baris: uang/potongan sudah diinput di Accurate, returnya belum — hanya retur yang belum `
            + `terpakai di Accurate yang dikirim (kekurangannya dilunasi sesuai Accurate). Baris data ke-${contoh}${hanyaReturBaris.length > 8 ? ", …" : ""}.`);
    }
    let manualRows: Bebas[] | null = null;
    if (unresolvedReturWarnings.length > 0) {
        lapor("warning", pesanPeringatanRetur(unresolvedReturWarnings));
        manualRows = susunBarisManual(unresolvedReturWarnings);
    }
    if (returIkutAccurate.length > 0) {
        const total = returIkutAccurate.reduce((s, r) => s + r.kurang, 0);
        const contoh = returIkutAccurate.slice(0, 5).map((r) => `${r.invoiceNo} (${rp(r.kurang)})`).join(", ");
        lapor("warning", `${returIkutAccurate.length} baris: retur di berkas lebih besar dari sisa RJN di Accurate, dilunasi sesuai Accurate; `
            + `selisih ${rp(total)} tetap menjadi sisa piutang fakturnya (bukan retur manual). Contoh: ${contoh}${returIkutAccurate.length > 5 ? ", …" : ""}.`);
    }

    lapor("success", `Format Pelunasan dikonversi menjadi ${payload.length} Sales Receipt.`, { id: "parse" });
    return { payload, manualRows, counts: { read: cleanedData.length, skipped: dilewati } };
}
