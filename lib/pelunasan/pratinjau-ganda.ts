/**
 * Tujuan: pratinjau duplikat sales-receipt sebelum eksekusi — dipindah UTUH dari W:30-45 (tipe) dan W:1903-2053
 *   `app/(dashboard)/api-wrapper/page.tsx` basis 5d6cc936 (S6e-1): duplikat dalam unggahan, kunci yang diblokir lock
 *   idempotency (pratinjau), dan kemiripan histori sales-receipt Accurate. Perilaku dikunci golden.
 * Caller: app/(dashboard)/api-wrapper/page.tsx (previewSalesReceiptDuplicates, executeBulkPayload); S6e-2.
 * Main Functions: pratinjauRiwayatAccurate, pemastiRiwayatTulis (Konsol: riwayat hanya jenis dokumen yang sama), pratinjauDuplikat,
 *   periksaRiwayatAccurate (server), targetRiwayat, strukDariDetail.
 * Side Effects: GET Accurate sales-receipt/list.do & detail.do lewat `accurateFetch` DIINJEKSI; pratinjau lock lewat
 *   `pratinjauKunci` DIINJEKSI (halaman: POST /api/idempotency/lock {preview:true}); console.error saat histori galat.
 */
import { buildSalesReceiptIdempotencyPayload } from "../sales-receipt-fingerprint.ts";
import type { Bebas } from "./sel.ts";
import type { AccurateFetch } from "./retur.ts";

export type DuplicateConflictReason = "DUPLICATE_IN_UPLOAD" | "ALREADY_SUCCESS" | "STILL_PROCESSING" | "UNKNOWN_OUTCOME" | "ACCURATE_HISTORY"
    | "ACCURATE_HISTORY_UNREADABLE";

export type DuplicateReviewEntry = {
    reviewId: string;
    key: string;
    row: Record<string, unknown>;
    originalIndex: number;
    invoiceNo: string;
    customerNo: string;
    amount: number;
    transDate: string;
    paymentMethod: string;
    reasons: DuplicateConflictReason[];
    recommended: boolean;
    matchedReceiptNumbers: string[];
};

/**
 * Identitas KASAR riwayat (keputusan orkestrator 11 Okt, tinjauan S6e-2a A1/B1): pelanggan + tanggal (= nilai FILTER list.do,
 * bukan versi Accurate) + {nomor faktur: nominal bayar}. Akun, catatan, dan jumlah potongan TIDAK ikut — bentuk item potongan
 * di detail.do belum terbukti, dan "akun potongan diganti" tetap ganda (definisi owner #1). `nominal` = per faktur, nominal yang
 * dianggap SAMA: Σ paymentAmount dan (lebih banyak menahan = aman) Σ paymentAmount + potongan baris itu. Dicocokkan PER FAKTUR
 * (putaran 2, A-N1): satu faktur bernominal sama di pelunasan mana pun di grup sudah menahan baris.
 */
export type TargetRiwayat = {
    key: string;
    customerNo: string;
    transDate: string;
    /** nomor faktur → nominal yang dianggap sama. Kosong = tidak dicocokkan kasar (baris idempotency_log: hanya `mirip`). */
    nominal: Map<string, number[]>;
    /** Nomor faktur Accurate ini milik baris? (`mirip` = pelunasan di grup yang menyentuh faktur MANA PUN dari baris.) */
    menyentuh: (invoiceNo: string) => boolean;
};
/** Pelunasan Accurate yang terbaca (detail.do dinormalkan). invoicePayment null = tidak dikirim Accurate. */
export type StrukAccurate = { number: string; transDate: string; invoices: Array<{ invoiceNo: string; paymentAmount: number; invoicePayment: number | null }> };
type Kelompok = { customerNo: string; transDate: string; targets: Map<string, TargetRiwayat> };

const bulat = (v: number) => Number(v.toFixed(2));
/** Nomor faktur untuk PERBANDINGAN saja (putaran 2, A-N2): Excel "kn01340" = Accurate "KN01340". Payload ke Accurate tidak diubah. */
export const normFaktur = (v: unknown) => String(v ?? "").trim().toUpperCase();

/** Target dari baris PAYLOAD (pratinjau klien & penahanan proxy). Uang = rumus sidik jari (Number(x) || 0). */
export function targetRiwayat(row: Bebas): TargetRiwayat {
    const fp = buildSalesReceiptIdempotencyPayload(row);
    const uang = (v: unknown) => bulat(Number(v) || 0);
    const jumlah = new Map<string, [number, number]>();
    for (const d of (row.detailInvoice ?? []) as Bebas[]) {
        const no = normFaktur(d.invoiceNo || "");
        const bayar = uang(d.paymentAmount);
        const potongan = ((d.detailDiscount ?? []) as Bebas[]).reduce((a: number, x: Bebas) => a + uang(x.amount), 0);
        const [a, b] = jumlah.get(no) ?? [0, 0];
        jumlah.set(no, [a + bayar, b + bayar + potongan]);
    }
    const nominal = new Map([...jumlah].map(([no, v]) => [no, v.map(bulat)]));
    return { key: fp.key, customerNo: String(fp.customerNo ?? "").trim(), transDate: fp.transDate, nominal, menyentuh: (no) => nominal.has(normFaktur(no)) };
}

function kelompokkan(targets: TargetRiwayat[]) {
    const groupedTargets = new Map<string, Kelompok>();
    targets.forEach((item) => {
        const groupKey = `${item.customerNo}|${item.transDate}`;
        if (!groupedTargets.has(groupKey)) {
            groupedTargets.set(groupKey, { customerNo: item.customerNo, transDate: item.transDate, targets: new Map() });
        }
        groupedTargets.get(groupKey)!.targets.set(item.key, item);
    });
    return [...groupedTargets.values()];
}

/**
 * Bentuk ASLI `sales-receipt/detail.do` (bukti baca-saja 10 Okt 2026, scratch/fiori-intake/S6e2-BUKTI-DETAIL-DO-2026-10-10.md):
 * nomor faktur di `detailInvoice[].invoice.number` (bentuk lama `invoiceNo` tetap dibaca), `paymentAmount`, `invoicePayment`
 * (arti belum terbukti — keduanya dipakai). Item potongan TIDAK dibaca. null = TIDAK TERBACA (detailInvoice bukan daftar, baris
 * tanpa nomor faktur, nominal bukan angka) → ditahan, bukan "tidak mirip". SATU tempat untuk pratinjau klien dan server.
 */
export function strukDariDetail(detail: Bebas, cadanganNomor?: unknown, cadanganTanggal?: string): StrukAccurate | null {
    if (!Array.isArray(detail?.detailInvoice)) return null;
    const teks = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
    const angka = (v: unknown) => typeof v === "number" ? (Number.isFinite(v) ? v : null)
        : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
    const invoices: StrukAccurate["invoices"] = [];
    for (const x of detail.detailInvoice as Bebas[]) {
        const invoiceNo = teks(x?.invoiceNo ?? x?.invoice?.number);
        const paymentAmount = angka(x?.paymentAmount);
        const adaIp = x?.invoicePayment !== undefined && x?.invoicePayment !== null;
        const invoicePayment = adaIp ? angka(x.invoicePayment) : null;
        if (!invoiceNo || paymentAmount === null || (adaIp && invoicePayment === null)) return null;
        invoices.push({ invoiceNo, paymentAmount, invoicePayment });
    }
    return { number: teks(detail.number) || teks(cadanganNomor), transDate: teks(detail.transDate) || (cadanganTanggal ?? ""), invoices };
}

/** Per faktur di SATU pelunasan Accurate: [Σ paymentAmount, Σ invoicePayment (cadangan paymentAmount)]. */
function nominalStruk(s: StrukAccurate): Map<string, number[]> {
    // ponytail: dijumlah per faktur (satu pelunasan menyebut faktur yang sama dua kali = dijumlah); campuran pa/ip antarbaris
    // faktur yang sama tidak dicoba — plafon: pencocokan per baris bila Accurate terbukti mengizinkan faktur berulang.
    const acc = new Map<string, [number, number]>();
    for (const b of s.invoices) {
        const no = normFaktur(b.invoiceNo);
        const [p, q] = acc.get(no) ?? [0, 0];
        acc.set(no, [p + b.paymentAmount, q + (b.invoicePayment ?? b.paymentAmount)]);
    }
    return new Map([...acc].map(([no, v]) => [no, v.map(bulat)]));
}

/**
 * TAHAN (putaran 2, A-N1): ada SATU faktur baris yang nominalnya (paymentAmount / + potongan) = nominal faktur yang SAMA di
 * pelunasan ini (paymentAmount / invoicePayment). Per faktur, bukan himpunan: pelunasan {I1, I2} terposting lalu baris {I1}
 * diunggah ulang (atau sebaliknya) tetap ditahan — I1 bisa terbayar dua kali.
 */
function adaFakturCocok(t: TargetRiwayat, s: StrukAccurate): boolean {
    const acc = nominalStruk(s);
    return [...t.nominal].some(([no, alt]) => (acc.get(no) ?? []).some((v) => alt.includes(v)));
}

/** IDENTIK kasar penuh (Selesaikan `terposting`, putaran 2 B-N1): himpunan faktur sama dan SETIAP faktur bernominal sama. */
export function identikKasar(nominal: Map<string, number[]>, s: StrukAccurate): boolean {
    const acc = nominalStruk(s);
    return nominal.size > 0 && acc.size === nominal.size && [...nominal].every(([no, alt]) => (acc.get(no) ?? []).some((v) => alt.includes(v)));
}

/** `cocok` = kunci → nomor pelunasan yang punya faktur bernominal sama (kunci ada walau nomor kosong); `mirip` = kunci → pelunasan
 * yang menyentuh faktur baris (berapa pun nominalnya). */
function cocokkan(group: Kelompok, struk: StrukAccurate[], cocok: Map<string, string[]>, mirip?: Map<string, StrukAccurate[]>) {
    for (const t of group.targets.values()) {
        for (const s of struk) {
            if (adaFakturCocok(t, s)) {
                if (!cocok.has(t.key)) cocok.set(t.key, []);
                const list = cocok.get(t.key)!;
                if (s.number && !list.includes(s.number)) list.push(s.number);
            }
            if (mirip && s.invoices.some((b) => t.menyentuh(b.invoiceNo))) {
                const list = mirip.get(t.key) ?? [];
                if (!s.number || !list.some((x) => x.number === s.number)) mirip.set(t.key, [...list, s]);
            }
        }
    }
}

/**
 * W:1903-1977 (satu kelompok pelanggan+tanggal): list.do (≤ 5 halaman, ≤ 300 kandidat) → detail.do per kandidat → daftar
 * pelunasan terbaca. `ketat` (server, S6e-2 owner #6, fail-closed): jawaban yang tidak terbaca (bukan `s:true`, detail kosong,
 * daftar terpotong / tanpa `sp.pageCount` angka / halaman kosong sebelum halaman terakhir yang diumumkan, bentuk tak dikenali)
 * MELEMPAR — klien (pratinjau) menandai kelompoknya `tidakTerbaca` dan lanjut. `berhenti()` (server, tinjauan A4) diperiksa SEBELUM setiap panggilan Accurate: sesudah batas
 * waktu tidak ada list.do/detail.do baru (jawaban yang sedang berjalan diabaikan pemanggil).
 */
async function riwayatKelompok(group: Kelompok, accurateFetch: AccurateFetch, ketat: boolean, tidakTerbaca?: Set<string>, berhenti?: () => boolean): Promise<StrukAccurate[]> {
    const cekWaktu = () => { if (berhenti?.()) throw new Error("batas waktu pembacaan riwayat terlampaui"); };
    let currentPage = 1;
    let pageCount = 1;
    const candidateReceipts: Bebas[] = [];

    do {
        cekWaktu();
        const listRes = await accurateFetch('/api/sales-receipt/list.do', 'GET', {
            fields: "id,number,customer,branch,transDate,chequeAmount,paymentMethod,description",
            "filter.customerNo": group.customerNo,
            "filter.transDate.op": "EQUAL",
            "filter.transDate.val": group.transDate,
            "sp.pageSize": 100,
            "sp.page": currentPage
        });
        if (ketat && !(listRes?.s === true && Array.isArray(listRes.d))) throw new Error("daftar riwayat sales-receipt tidak terbaca");
        // Tinjauan A2: tanpa jumlah halaman angka, "halaman 2" tak bisa dipastikan ada/tidak -> terpotong (fail-closed). Putaran 2:
        // teks angka ("1") diterima; 0 hanya sah bila daftarnya kosong (0 halaman + baris = tak konsisten = ditahan).
        if (ketat) {
            const pc = listRes.sp?.pageCount;
            const n = typeof pc === "number" || (typeof pc === "string" && pc.trim() !== "") ? Number(pc) : NaN;
            if (!(Number.isFinite(n) && (n >= 1 || (n === 0 && listRes.d.length === 0)))) {
                throw new Error("daftar riwayat sales-receipt tanpa jumlah halaman (sp.pageCount) — dianggap terpotong");
            }
            // Susulan S6e (tinjauan A, RENDAH): halaman 1 `pageCount:3` lalu halaman 2 kosong `pageCount:0` dulu menyusutkan jumlah
            // halaman -> halaman 3 tak dibaca, lolos. Jumlah halaman tidak boleh turun (di bawah), dan halaman kosong sebelum
            // halaman terakhir yang diumumkan = gagal baca. Halaman terakhir yang kosong tetap sah (daftar menyusut).
            if (listRes.d.length === 0 && currentPage < Math.max(pageCount, n)) {
                throw new Error("halaman riwayat sales-receipt kosong sebelum halaman terakhir yang diumumkan — dianggap gagal baca");
            }
        }

        const pageRows = Array.isArray(listRes?.d) ? listRes.d : [];
        candidateReceipts.push(...pageRows);
        const umum = Number(listRes?.sp?.pageCount || currentPage || 1);
        pageCount = ketat ? Math.max(pageCount, umum) : umum; // pratinjau klien (golden) tetap perilaku lama
        currentPage += 1;
    } while (currentPage <= pageCount && currentPage <= 5 && candidateReceipts.length < 300);
    if (ketat && currentPage <= pageCount) throw new Error("riwayat sales-receipt terpotong (> 5 halaman / 300 kandidat)");

    const struk: StrukAccurate[] = [];
    for (const candidate of candidateReceipts) {
        try {
            cekWaktu();
            const detailRes = await accurateFetch('/api/sales-receipt/detail.do', 'GET', candidate?.id ? { id: candidate.id } : { number: candidate.number });
            if (ketat && !(detailRes?.s === true && detailRes.d && typeof detailRes.d === "object" && !Array.isArray(detailRes.d))) {
                throw new Error(`detail sales-receipt ${candidate?.number ?? candidate?.id ?? "?"} tidak terbaca`);
            }
            const detail = detailRes?.d || detailRes;
            if (!detail) continue;

            const s = strukDariDetail(detail, candidate?.number, group.transDate);
            if (!s) throw new Error(`bentuk detail sales-receipt ${candidate?.number ?? candidate?.id ?? "?"} tidak dikenali`);
            struk.push(s);
        } catch (detailErr) {
            if (ketat) throw detailErr;
            // S6e-2: kandidat yang tidak terbaca = kelompok TIDAK TERBACA (bukan "aman") — pratinjau menandainya.
            group.targets.forEach((_, k) => tidakTerbaca?.add(k));
            console.error("Accurate history preview detail error:", detailErr);
        }
    }
    return struk;
}

/** W:1903-1977: kunci fingerprint → nomor sales-receipt Accurate yang identik KASAR (per pelanggan + tanggal). Pratinjau klien:
 * kelompok berurutan, galat menghentikan pencarian (hasil sebagian) — perilaku lama, dikunci golden. S6e-2: `tidakTerbaca` =
 * kunci yang kelompoknya gagal dibaca / bentuk detailnya tak dikenali / tidak sempat dibaca setelah galat (bukan "aman"). */
export const pratinjauRiwayatAccurate = async (rows: Bebas[], accurateFetch: AccurateFetch) => {
    const matchedReceiptsByKey = new Map<string, string[]>();
    const tidakTerbaca = new Set<string>();
    const groups = kelompokkan(rows.map(targetRiwayat));
    let i = 0;
    try {
        for (; i < groups.length; i++) {
            cocokkan(groups[i], await riwayatKelompok(groups[i], accurateFetch, false, tidakTerbaca), matchedReceiptsByKey);
        }
    } catch (historyErr) {
        groups.slice(i).forEach((g) => g.targets.forEach((_, k) => tidakTerbaca.add(k)));
        console.error("Accurate history preview skipped:", historyErr);
    }
    return Object.assign(matchedReceiptsByKey, { tidakTerbaca });
};

/** Review S7-1b: pemasti kiriman TULIS Konsol yang gagal/tanpa jawaban lewat riwayat Accurate — HANYA jenis dokumen yang sama.
 * ponytail: pencocok andal baru ada untuk sales-receipt (sidik jari pelanggan+tanggal+faktur+nilai); jenis lain (retur, PO, …)
 * → null = tidak dicek, baris tanpa jawaban tetap TIDAK PASTI. Tambah pencocok per jenis bila memang dibutuhkan. */
export const pemastiRiwayatTulis = (writePath: string, accurateFetch: AccurateFetch) =>
    writePath === "/api/sales-receipt/bulk-save.do" ? (rows: Bebas[]) => pratinjauRiwayatAccurate(rows, accurateFetch) : null;

/**
 * S6e-2 (owner #6): pemeriksaan riwayat di SERVER, fail-closed. Logika = pratinjau (riwayatKelompok, mode ketat). `cocok` =
 * kunci → nomor identik KASAR (penahanan proxy); `mirip` = kunci → pelunasan di grup pelanggan+tanggal yang menyentuh faktur
 * mana pun dari baris (bukti ketiadaan Selesaikan); `gagal` = kunci yang kelompoknya tidak terbaca (galat, bukan `s:true`,
 * terpotong, bentuk tak dikenali, atau melewati `batasMs`). Paling banyak `konkurensi` kelompok serentak.
 * Biaya per paket: per kelompok pelanggan+tanggal 1–5 list.do + 1 detail.do per kandidat (≤ 300 kandidat; lebih = terpotong =
 * ditahan); sesudah `batasMs` tidak ada panggilan baru (tinjauan A4).
 */
export async function periksaRiwayatAccurate(targets: TargetRiwayat[], accurateFetch: AccurateFetch, opsi: { konkurensi?: number; batasMs?: number } = {}) {
    const kelompok = kelompokkan(targets);
    const selesai = new Map<Kelompok, StrukAccurate[]>();
    const galat = new Map<Kelompok, string>();
    let berikut = 0;
    let habis = false;
    const pekerja = async () => {
        while (!habis && berikut < kelompok.length) {
            const g = kelompok[berikut++];
            try {
                selesai.set(g, await riwayatKelompok(g, accurateFetch, true, undefined, () => habis));
            } catch (e) {
                galat.set(g, e instanceof Error ? e.message : String(e));
            }
        }
    };
    let tunda: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.all(Array.from({ length: Math.min(opsi.konkurensi ?? 4, kelompok.length) }, pekerja)),
        new Promise<void>((r) => { tunda = setTimeout(r, opsi.batasMs ?? 60_000); }),
    ]);
    clearTimeout(tunda);
    habis = true; // kelompok yang belum selesai saat batas waktu = tidak terbaca (jawaban terlambat diabaikan)
    const cocok = new Map<string, string[]>();
    const mirip = new Map<string, StrukAccurate[]>();
    const gagal = new Map<string, string>();
    for (const g of kelompok) {
        const s = selesai.get(g);
        if (s) cocokkan(g, s, cocok, mirip);
        else g.targets.forEach((_, k) => gagal.set(k, galat.get(g) ?? "batas waktu pembacaan riwayat terlampaui"));
    }
    return { cocok, mirip, gagal };
}

type KunciFingerprint = ReturnType<typeof buildSalesReceiptIdempotencyPayload>;

/**
 * W:1979-2053. `pratinjauKunci` = pratinjau lock idempotency (dipanggil DULU, seperti kode lama), wajib melempar bila
 * server menolak. Mengembalikan null bila tidak ada yang perlu ditinjau.
 */
export const pratinjauDuplikat = async <K extends string>(rows: Bebas[], routeKey: K, deps: {
    accurateFetch: AccurateFetch;
    pratinjauKunci: (keysPayload: KunciFingerprint[]) => Promise<{ blockedEntries?: Array<{ key: string; reason?: string }> }>;
}) => {
    const keysPayload = rows.map((row: Bebas) => buildSalesReceiptIdempotencyPayload(row));
    const uploadDuplicateIndexes = new Map<string, number[]>();
    keysPayload.forEach((item, index) => {
        if (!uploadDuplicateIndexes.has(item.key)) uploadDuplicateIndexes.set(item.key, []);
        uploadDuplicateIndexes.get(item.key)!.push(index);
    });

    const previewData = await deps.pratinjauKunci(keysPayload);
    const accurateHistoryMap = await pratinjauRiwayatAccurate(rows, deps.accurateFetch);

    const blockedReasonMap = new Map<string, DuplicateConflictReason[]>();
    (previewData.blockedEntries || []).forEach((entry: Bebas) => {
        const reason = entry.reason as DuplicateConflictReason;
        if (!blockedReasonMap.has(entry.key)) blockedReasonMap.set(entry.key, []);
        if (reason && !blockedReasonMap.get(entry.key)!.includes(reason)) {
            blockedReasonMap.get(entry.key)!.push(reason);
        }
    });

    const firstIndexByKey = new Map<string, number>();
    uploadDuplicateIndexes.forEach((indexes, key) => {
        firstIndexByKey.set(key, Math.min(...indexes));
    });

    const passthroughRows: Array<{ originalIndex: number; row: Bebas }> = [];
    const reviewRows: DuplicateReviewEntry[] = [];
    const selections: Record<string, boolean> = {};

    rows.forEach((row: Bebas, index: number) => {
        const keyMeta = keysPayload[index];
        const reasons: DuplicateConflictReason[] = [];
        const duplicateIndexes = uploadDuplicateIndexes.get(keyMeta.key) || [];
        if (duplicateIndexes.length > 1) reasons.push("DUPLICATE_IN_UPLOAD");
        (blockedReasonMap.get(keyMeta.key) || []).forEach((reason) => {
            if (!reasons.includes(reason)) reasons.push(reason);
        });
        const matchedReceiptNumbers = accurateHistoryMap.get(keyMeta.key) || [];
        if (matchedReceiptNumbers.length > 0 && !reasons.includes("ACCURATE_HISTORY")) {
            reasons.push("ACCURATE_HISTORY");
        }
        // S6e-2: riwayat tak terbaca = ditinjau (server juga menahannya), bukan lolos sebagai "aman".
        if (accurateHistoryMap.tidakTerbaca.has(keyMeta.key)) reasons.push("ACCURATE_HISTORY_UNREADABLE");

        if (reasons.length === 0) {
            passthroughRows.push({ originalIndex: index, row });
            return;
        }

        const reviewId = `${keyMeta.key}__${index}`;
        const recommended = reasons.every((reason) => reason === "DUPLICATE_IN_UPLOAD") && firstIndexByKey.get(keyMeta.key) === index;
        reviewRows.push({
            reviewId,
            key: keyMeta.key,
            row,
            originalIndex: index,
            invoiceNo: keyMeta.invoiceNo,
            customerNo: keyMeta.customerNo,
            amount: keyMeta.amount,
            transDate: keyMeta.transDate,
            paymentMethod: keyMeta.paymentMethod,
            reasons,
            recommended,
            matchedReceiptNumbers
        });
        selections[reviewId] = recommended;
    });

    if (reviewRows.length === 0) return null;
    return { routeKey, passthroughRows, reviewRows, selections };
};
