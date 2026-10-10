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
import { alokasikan, type PetaAkun } from "./alokasi.ts";
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
 */
export async function parsePelunasan(rows: Bebas[], opsi: OpsiPelunasan): Promise<{ payload: Bebas[]; manualRows: Bebas[] | null }> {
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
    }

    let invoiceBranchMap = new Map<string, Bebas>();
    let invoiceLookupDebugMap = new Map<string, Bebas>();
    if (invoiceNos.size > 0 && isKeySaved) {
        lapor("loading", `Menarik data Cabang dari ${invoiceNos.size} tagihan Invoice...`, { id: "parse" });
        ({ invoiceBranchMap, invoiceLookupDebugMap } = await cariFaktur(invoiceNos, accurateFetch));
    }

    const { groupedMap, ayatSilangDocs, unresolvedReturWarnings } = alokasikan(cleanedData, {
        trxDate, peta: opsi.peta, returMap, invoiceBranchMap, invoiceLookupDebugMap,
    });

    const payload = finalisasiPayload(Array.from(groupedMap.values()), ayatSilangDocs);
    let manualRows: Bebas[] | null = null;
    if (unresolvedReturWarnings.length > 0) {
        lapor("warning", pesanPeringatanRetur(unresolvedReturWarnings));
        manualRows = susunBarisManual(unresolvedReturWarnings);
    }

    lapor("success", `Format Pelunasan dikonversi menjadi ${payload.length} Sales Receipt.`, { id: "parse" });
    return { payload, manualRows };
}
