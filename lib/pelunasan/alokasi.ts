/**
 * Tujuan: mesin alokasi Pelunasan per baris Excel → kelompok sales-receipt. Asal: W:1038-1573 `app/(dashboard)/api-wrapper/page.tsx`
 *   basis 5d6cc936 (S6e-1). 25 Nov 2026 disesuaikan dengan praktik Accurate yang terbukti (lihat ./akun.ts):
 *   - pelanggan pelunasan = pelanggan faktur di Accurate bila Code Outlet berkas tanpa sufiks divisi (Form Kerja Inc: C-DEL015 → C-DEL015-SZ);
 *   - rekening per jenis (Tunai, Transfer Maybank/Permata/BRI/lain, BG, PPN retur) dan akun potongan per jenis (Kwitansi, Pot. Lain klaim,
 *     Biaya Trf/BG, selisih pembulatan) dari langkah Akun, bawaan AKUN_BAWAAN;
 *   - selisih ≤ Rp 100 terhadap sisa piutang → baris potongan akun Selisih Pembulatan (600136); uang yang diterima TIDAK diubah
 *     (dulu nominal kas dinaikkan/diturunkan agar pas);
 *   - retur pelanggan yang sama → baris retur negatif di pelunasan Kas (Tunai, atau pelunasan tanpa uang OTHERS); beda pelanggan →
 *     pasangan ayat silang 110120 dan nilai retur TIDAK lagi ikut dibayar di pelunasan utama (dulu faktur terbayar dua kali);
 *   - Pot. Lain: RJN/SRT = retur (seperti dulu), PPN = pelunasan terpisah rekening PPN retur, lainnya = potongan akun Pot. Lain
 *     (dulu Pot. Lain non-retur diabaikan diam-diam);
 *   - faktur yang PASTI tidak ada di Accurate dilewati (FAKTUR_TIDAK_DITEMUKAN), bukan dikirim untuk ditolak;
 *   - baris yang SUDAH diinput di Accurate (oleh sales/admin; sisa piutang = Saldo − bayar) dilewati, yang sisa piutangnya bergerak lain
 *     ditahan PERLU_CEK — hanya yang belum diinput yang dikirim (butuh kolom Saldo, ada di Form Kerja Inc).
 *   Urutan alokasi per baris tetap: Potongan → Retur → Uang; batas atas = Total.Trx (atau jumlah kolom) dan sisa piutang Accurate.
 * Caller: lib/pelunasan/parser.ts (parsePelunasan).
 * Main Functions: alokasikan.
 * Side Effects: tidak ada I/O. Memutasi baris masukan (suntik SRB/RJS dari Ket. Pot), sisa piutang di `invoiceBranchMap`, dan
 *   `primeOwing` retur di `returMap` — seperti kode lama (baris berikutnya tidak mengalokasikan ulang yang sama).
 */
import { getTextVal, getVal, hasMeaningfulCellValue, type Bebas } from "./sel.ts";
import { buildReturLookupKey } from "./retur.ts";
import { AKUN_BAWAAN, REKENING, bankTransfer, jenisPotLain } from "./akun.ts";

export type PetaAkun = {
    mapTunaiAutoNum: string; mapTunaiBank: string;
    mapTrfAutoNum: string; mapTrfBank: string;
    mapBgAutoNum: string; mapBgBank: string;
    mapPot1Account: string; mapPot2Account: string; mapPot3Account: string;
    /** 25 Nov 2026 — kosong/absen = AKUN_BAWAAN (praktik Accurate). */
    mapMaybankBank?: string; mapPermataBank?: string; mapBriBank?: string; mapPpnReturBank?: string;
    mapPotLainAccount?: string; mapBiayaTrfAccount?: string; mapBiayaBgAccount?: string; mapSelisihAccount?: string;
};

/** Baris Excel yang dilewati alokasi. SUDAH_DI_ACCURATE / PERLU_CEK membawa faktur + keterangan angka (langkah Tinjau). */
export type BarisDilewati = {
    row: number;
    reason: "KODE_OUTLET_KOSONG" | "TANPA_NOMINAL" | "FAKTUR_TIDAK_DITEMUKAN" | "SUDAH_DI_ACCURATE" | "PERLU_CEK";
    invoiceNo?: string;
    detail?: string;
};

const rp = (n: number) => `Rp ${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

export type PeringatanRetur = {
    invoiceNo: string,
    customerNo: string,
    refs: string[],
    unresolvedSrbAmt: number,
    unresolvedRjsAmt: number,
    tunaiAmt: number,
    trfAmt: number,
    bgAmt: number,
    biayaBg: number,
    ketAllTrx: string
};

const TOLERANSI_SELISIH = 100;
const SANGAT_KECIL = 0.000001;

type Bayar = { type: "TUNAI" | "TRF" | "BG" | "PPN" | "RETUR_ONLY"; amt: number; bank: string; code: string; cNo: string; pMeth: string; used: number };

/** Kapasitas retur dari peta retur (dulu W:300-365): nominal yang bisa dipakai, nomor Accurate, dan yang belum ketemu. */
function kapasitasRetur(returMap: Map<string, Bebas>, customerNo: string, desc: string, amt: number) {
    const r = { avail: 0, unresolved: 0, number: undefined as string | undefined, outstanding: undefined as number | undefined, kompensasi: 0 };
    if (!(amt > 0) || !desc) return r;
    const key = buildReturLookupKey(customerNo.trim(), desc.trim());
    const retData = returMap.get(key);
    if (!retData) { r.unresolved = amt; return r; }
    r.number = retData.number;
    if (retData.number === "NOT_FOUND") { r.unresolved = amt; return r; }
    const rawOut = retData.outstanding;
    if (rawOut == null || isNaN(Number(rawOut))) { r.avail = amt; return r; }
    const retOut = Math.abs(Number(rawOut));
    r.outstanding = retOut;
    if (Math.abs(amt - retOut) <= TOLERANSI_SELISIH) { r.avail = retOut; r.kompensasi = retOut - amt; }
    else if (retOut < 0.01) r.avail = amt; // ANTI-GHOSTING RETUR: jangan bunuh baris bila API membaca retur sudah lunas
    else r.avail = Math.min(amt, retOut);
    return r;
}

export function alokasikan(cleanedData: Bebas[], ctx: {
    trxDate: string;
    peta: PetaAkun;
    returMap: Map<string, Bebas>;
    invoiceBranchMap: Map<string, Bebas>;
    invoiceLookupDebugMap: Map<string, Bebas>;
}) {
    const { trxDate, returMap, invoiceBranchMap, invoiceLookupDebugMap, peta } = ctx;
    const akun = {
        tunai: peta.mapTunaiBank || AKUN_BAWAAN.tunai,
        maybank: peta.mapMaybankBank || AKUN_BAWAAN.maybank,
        permata: peta.mapPermataBank || AKUN_BAWAAN.permata,
        bri: peta.mapBriBank || AKUN_BAWAAN.bri,
        bg: peta.mapBgBank || AKUN_BAWAAN.bg,
        ppnRetur: peta.mapPpnReturBank || AKUN_BAWAAN.ppnRetur,
        potLain: peta.mapPotLainAccount || AKUN_BAWAAN.potLain,
        biayaTrf: peta.mapBiayaTrfAccount || AKUN_BAWAAN.biayaTrf,
        biayaBg: peta.mapBiayaBgAccount || AKUN_BAWAAN.biayaBg,
        selisih: peta.mapSelisihAccount || AKUN_BAWAAN.selisih,
    };
    const nomorOtomatis = (bank: string, eksplisit?: string) => eksplisit || REKENING[bank]?.autoNumber || "";
    const tanggal = trxDate.split('-').reverse().join('/');

    const groupedMap = new Map<string, Bebas>();
    const ayatSilangDocs: Bebas[] = [];
    const unresolvedReturWarnings: PeringatanRetur[] = [];
    const unresolvedReturKeys = new Set<string>();
    // S6e-2 butir 9: baris data yang tidak menghasilkan pelunasan (nomor baris mulai 1) — untuk langkah Tinjau.
    const dilewati: BarisDilewati[] = [];
    // Baris (mulai 1) yang Total.Trx-nya berbeda dari jumlah kolom pembayaran → dipakai jumlah kolom; dilaporkan di Tinjau.
    const trxTakCocok: number[] = [];

    cleanedData.forEach((row: Bebas, indeks: number) => {
        const nilai = (kolom: string) => Number(getVal(row, kolom)) || 0;
        const rawOutlet = getTextVal(row, "Code Outlet");
        let srbDesc = getTextVal(row, "No.SRB Rt Ktr");
        let rjsDesc = getTextVal(row, "No.RJS RT Gt");

        // customerNo = kunci pencarian retur (sama dengan parser.kumpulkanKueri); pelanggan pelunasan = custReceipt di bawah.
        let customerNo = rawOutlet;
        let branchName: string | undefined = undefined;
        let branchId: number | undefined = undefined;

        // Jika Excel kosong cabangnya, manfaatkan data retur yang sudah valid dari peta.
        for (const desc of [srbDesc, rjsDesc]) {
            if (!desc) continue;
            const matchedRet = returMap.get(buildReturLookupKey(rawOutlet.trim(), desc.trim()));
            if (!matchedRet) continue;
            if (!customerNo) customerNo = matchedRet.customerNo;
            if (!branchName) branchName = matchedRet.branchName;
            if (!branchId) branchId = matchedRet.branchId;
        }
        const invNo = getTextVal(row, "No. Nota");
        const fakturMeta = invNo ? invoiceBranchMap.get(invNo) : undefined;
        if (fakturMeta && !branchId) {
            branchId = fakturMeta.branchId;
            branchName = fakturMeta.branchName;
        }

        if (!customerNo) { dilewati.push({ row: indeks + 1, reason: "KODE_OUTLET_KOSONG" }); return; }
        // Faktur yang pencariannya SELESAI tanpa hasil (bukan galat jaringan) pasti ditolak Accurate → dilewati dengan alasan.
        const debugFaktur = invNo ? invoiceLookupDebugMap.get(invNo) : undefined;
        if (invNo && !fakturMeta && debugFaktur && debugFaktur.found === false && debugFaktur.lookupSource !== "ERROR") {
            dilewati.push({ row: indeks + 1, reason: "FAKTUR_TIDAK_DITEMUKAN" });
            return;
        }
        const fakturCust = String(fakturMeta?.customerNo || "").trim();
        const custReceipt = fakturCust && fakturCust.toUpperCase().startsWith(`${customerNo.trim().toUpperCase()}-`) ? fakturCust : customerNo;

        // 1. Nominal pembayaran & potongan
        const tunaiAmt = nilai("Tunai");
        const trfAmt = nilai("Trf");
        const bgAmt = nilai("BG");
        let srbAmt = nilai("Pot.RT Ktr");
        let rjsAmt = nilai("Pot. RT Gt");

        const ketPotRaw = getTextVal(row, "Ket. Pot");
        const potLain = nilai("Pot. Lain");
        const jenisPL = potLain > 0 ? jenisPotLain(ketPotRaw) : null;
        if (jenisPL === "retur") {
            // Pot. Lain bernomor RJN/SRT = retur; disuntik ke kolom retur yang masih kosong (perilaku lama).
            if (srbAmt === 0) {
                row["No.SRB Rt Ktr"] = ketPotRaw; row["Pot.RT Ktr"] = potLain; row["Pot. Lain"] = 0;
                srbAmt = potLain; srbDesc = ketPotRaw;
            } else if (rjsAmt === 0) {
                row["No.RJS RT Gt"] = ketPotRaw; row["Pot. RT Gt"] = potLain; row["Pot. Lain"] = 0;
                rjsAmt = potLain; rjsDesc = ketPotRaw;
            }
        }
        const ppnAmt = jenisPL === "ppn" ? potLain : 0;
        const klaimAmt = jenisPL === "klaim" ? potLain : 0;
        const pot1 = nilai("Pot.1 Kwtnsi");
        const pot2 = nilai("Pot.2 Kwtnsi");
        const pot3 = nilai("Pot.3 Kwtnsi");
        const potTB = nilai("Pot.DiscTB");
        const biayaBg = nilai("BiayaTrf/BG");

        // 2. Potongan di baris faktur (urutan = urutan kolom berkas)
        const potongan: Bebas[] = [];
        if (pot1 > 0) potongan.push({ amount: pot1, accountNo: peta.mapPot1Account || "ISI_KODE_AKUN_POT1_DI_UI" });
        if (pot2 > 0) potongan.push({ amount: pot2, accountNo: peta.mapPot2Account || "ISI_KODE_AKUN_POT2_DI_UI" });
        if (pot3 > 0) potongan.push({ amount: pot3, accountNo: peta.mapPot3Account || "ISI_KODE_AKUN_POT3_DI_UI" });
        if (potTB > 0) potongan.push({ amount: potTB, discountNotes: "Pot.DiscTB" });
        if (biayaBg > 0) potongan.push({ amount: biayaBg, accountNo: bgAmt > 0 ? akun.biayaBg : akun.biayaTrf });
        if (klaimAmt > 0) potongan.push({ amount: klaimAmt, accountNo: akun.potLain });
        const totalDisc = potongan.reduce((s, d) => s + d.amount, 0);

        // 3. Jenis pembayaran (satu pelunasan per pelanggan + jenis + keterangan bank)
        const payments: Bayar[] = [];
        if (tunaiAmt > 0) payments.push({ type: 'TUNAI', amt: tunaiAmt, bank: akun.tunai, code: nomorOtomatis(akun.tunai, peta.mapTunaiAutoNum), cNo: "", pMeth: "CASH_OTHER", used: 0 });
        if (trfAmt > 0) {
            const ketTrf = String(getVal(row, "Ket. Trf") || getVal(row, "Ket.TF") || "").toUpperCase();
            const bankTf = bankTransfer(ketTrf);
            const bank = bankTf ? akun[bankTf] : peta.mapTrfBank;
            payments.push({ type: 'TRF', amt: trfAmt, bank, code: bankTf ? nomorOtomatis(bank) : nomorOtomatis(bank, peta.mapTrfAutoNum), cNo: ketTrf, pMeth: "BANK_TRANSFER", used: 0 });
        }
        if (bgAmt > 0) payments.push({ type: 'BG', amt: bgAmt, bank: akun.bg, code: nomorOtomatis(akun.bg, peta.mapBgAutoNum), cNo: getVal(row, "Ket.BG") || "", pMeth: "BANK_CHEQUE", used: 0 });
        if (ppnAmt > 0) payments.push({ type: 'PPN', amt: ppnAmt, bank: akun.ppnRetur, code: nomorOtomatis(akun.ppnRetur), cNo: "", pMeth: "OTHERS", used: 0 });

        const uang = payments.filter((p) => p.type !== "PPN");
        const adaRetur = srbAmt > 0 || rjsAmt > 0;
        if (payments.length === 0 && !adaRetur && totalDisc <= 0) {
            dilewati.push({ row: indeks + 1, reason: "TANPA_NOMINAL" });
            return; // baris kosong beneran
        }
        // Pelunasan Kas tanpa uang (OTHERS) untuk retur bila tidak ada Tunai, atau untuk potongan bila tidak ada uang sama sekali.
        let returOnly: Bayar | undefined;
        if ((adaRetur && !uang.some((p) => p.type === "TUNAI")) || (uang.length === 0 && totalDisc > 0)) {
            returOnly = { type: 'RETUR_ONLY', amt: 0, bank: akun.tunai, code: nomorOtomatis(akun.tunai, peta.mapTunaiAutoNum), cNo: "", pMeth: "OTHERS", used: 0 };
            payments.push(returOnly);
        }
        // Potongan + selisih menempel di uang terbesar (pertama bila seri); tanpa uang → pelunasan tanpa uang; hanya PPN → PPN.
        const discountHost = uang.length > 0 ? uang.reduce((a, b) => (b.amt > a.amt ? b : a)) : (returOnly ?? payments[0]);
        // Retur menempel di pelunasan Kas: Tunai bila ada, selain itu pelunasan tanpa uang (praktik Accurate).
        const returHost = adaRetur ? (uang.find((p) => p.type === "TUNAI") ?? returOnly) : undefined;

        // 4. Retur yang bisa dipakai
        const srb = kapasitasRetur(returMap, customerNo, srbDesc, srbAmt);
        const rjs = kapasitasRetur(returMap, customerNo, rjsDesc, rjsAmt);

        // 5. Batas baris: jumlah kolom pembayaran, dibatasi sisa piutang Accurate; selisih ≤ Rp 100 → akun selisih.
        // Total.Trx hanya dipakai bila SAMA dengan jumlah kolom (± Rp 1). Bukti 25 Nov 2026: di 17 dari 73 Form Kerja Inc Sep–Okt 2026
        // (5.272 baris) Total.Trx bergeser satu baris (Total.Trx baris i = jumlah baris i-1), dan admin memposting sesuai kolom.
        const intendedRowPayable = totalDisc + srbAmt + rjsAmt + tunaiAmt + trfAmt + bgAmt + ppnAmt;
        const accuratePrimeOwing = fakturMeta?.outstanding != null && !isNaN(Number(fakturMeta.outstanding)) ? Number(fakturMeta.outstanding) : undefined;

        // 5a. Sudah diinput di Accurate? Pelunasan ada yang diinput sales, ada yang diinput admin. Form Kerja Inc membawa 6_Saldo (sisa
        // piutang SEBELUM baris ini): sisa Accurate ≈ Saldo → belum, diproses; ≈ Saldo − bayar → sudah (dilewati); selain itu sisa Accurate
        // sudah bergerak lain (sebagian/lebih/pembayaran lain) → PERLU_CEK, tidak dikirim. Bukti 25 Nov 2026 berkas 24 Nov: 825 sudah,
        // 55 belum, 17 berbeda dari 897 baris. Berkas tanpa kolom Saldo (Format Pelunasan) tidak diperiksa (perilaku lama).
        if (invNo && accuratePrimeOwing !== undefined && hasMeaningfulCellValue(row, "Saldo") && intendedRowPayable > 0) {
            const saldo = nilai("Saldo");
            const sesudah = Math.max(0, saldo - intendedRowPayable);
            const jarakBelum = Math.abs(accuratePrimeOwing - saldo);
            const jarakSudah = accuratePrimeOwing <= 1 && sesudah <= TOLERANSI_SELISIH ? 0 : Math.abs(accuratePrimeOwing - sesudah);
            if (jarakSudah < jarakBelum && jarakSudah <= TOLERANSI_SELISIH) {
                dilewati.push({ row: indeks + 1, reason: "SUDAH_DI_ACCURATE", invoiceNo: invNo });
                return;
            }
            if (!(jarakBelum <= TOLERANSI_SELISIH && jarakBelum <= jarakSudah)) {
                dilewati.push({ row: indeks + 1, reason: "PERLU_CEK", invoiceNo: invNo,
                    detail: `Sisa piutang Accurate ${rp(accuratePrimeOwing)}; berkas: saldo ${rp(saldo)}, bayar ${rp(intendedRowPayable)}, sisa ${rp(sesudah)}. `
                        + `Sudah masuk di Accurate ${rp(saldo - accuratePrimeOwing)}.` });
                return;
            }
        }

        const adaTrxBerkas = hasMeaningfulCellValue(row, "Total.Trx");
        const hasExplicitTrxAmt = adaTrxBerkas && Math.abs(nilai("Total.Trx") - intendedRowPayable) <= 1;
        if (adaTrxBerkas && !hasExplicitTrxAmt) trxTakCocok.push(indeks + 1);
        const trxAmt = hasExplicitTrxAmt ? nilai("Total.Trx") : 0;
        let maxPayable = (hasExplicitTrxAmt ? trxAmt : intendedRowPayable) + srb.kompensasi + rjs.kompensasi;
        let selisih = 0;
        if (accuratePrimeOwing !== undefined) {
            const diff = accuratePrimeOwing - maxPayable;
            const bolehSnap = !(hasExplicitTrxAmt && trxAmt === 0) && srb.unresolved === 0 && rjs.unresolved === 0;
            if (bolehSnap && Math.abs(diff) <= TOLERANSI_SELISIH) selisih = Math.abs(diff) < SANGAT_KECIL ? 0 : diff;
            else if (maxPayable > accuratePrimeOwing) maxPayable = accuratePrimeOwing; // batas lebih bayar (walau sisa 0 = sudah lunas)
        }
        // ANTI-GHOSTING: sisa piutang TAK TERBACA dan Total.Trx kosong → batas = dana yang masuk. Sisa terbaca 0 = sudah lunas → tidak ada alokasi.
        if (!hasExplicitTrxAmt && maxPayable === 0 && accuratePrimeOwing === undefined) maxPayable = intendedRowPayable;

        // 6. Alokasi: Potongan → Retur → Uang (urutan Tunai, Trf, BG, PPN)
        let owed = Math.max(0, maxPayable);
        const usedDisc = Math.min(totalDisc, owed); owed -= usedDisc;
        const usedSrb = Math.min(srb.avail, owed); owed -= usedSrb;
        const usedRjs = Math.min(rjs.avail, owed); owed -= usedRjs;
        for (const p of payments) { p.used = Math.min(p.amt, owed); owed -= p.used; }
        if (totalDisc > usedDisc) {
            // Potongan dipotong berurutan sampai sebesar yang terpakai.
            let leftover = usedDisc;
            for (const d of potongan) {
                if (leftover <= 0) { d.amount = 0; continue; }
                if (d.amount > leftover) { d.amount = leftover; leftover = 0; } else leftover -= d.amount;
            }
        }
        const potonganFinal = potongan.filter((d) => d.amount > 0);
        if (selisih !== 0) potonganFinal.push({ amount: selisih, accountNo: akun.selisih });

        if (srb.unresolved > 0 || rjs.unresolved > 0) {
            const unresolvedKey = `${customerNo}|${invNo}|${srbDesc}|${rjsDesc}`;
            if (!unresolvedReturKeys.has(unresolvedKey)) {
                unresolvedReturKeys.add(unresolvedKey);
                unresolvedReturWarnings.push({
                    invoiceNo: invNo,
                    customerNo,
                    refs: [srb.number === "NOT_FOUND" ? srbDesc : "", rjs.number === "NOT_FOUND" ? rjsDesc : ""].filter(Boolean) as string[],
                    unresolvedSrbAmt: srb.unresolved,
                    unresolvedRjsAmt: rjs.unresolved,
                    tunaiAmt, trfAmt, bgAmt, biayaBg,
                    ketAllTrx: String(getVal(row, "Ket. All Trx") || "")
                });
            }
        }

        // 7. Susun pelunasan per jenis pembayaran
        let terlunasi = 0;
        const hostSr: Map<Bayar, Bebas> = new Map();
        for (const pmt of payments) {
            const groupKey = `${custReceipt}_${pmt.type}_${pmt.cNo}`;
            if (!groupedMap.has(groupKey)) {
                const newSrObj: Bebas = {
                    bankNo: pmt.bank || "",
                    chequeAmount: 0,
                    customerNo: custReceipt,
                    transDate: tanggal,
                    branchName: branchName || "",
                    chequeDate: tanggal,
                    chequeNo: pmt.cNo || "",
                    // Praktik Accurate: pelunasan tanpa uang berketerangan teks kwitansi/klaim (mis. "RAFAKSI JULI", "019/SUPER-PR/08/2026").
                    description: pmt.type === "PPN" ? (ketPotRaw || "PPN RETUR")
                        : (pmt.type === "RETUR_ONLY" && [getTextVal(row, "Ket Kwitansi"), klaimAmt > 0 ? ketPotRaw : ""].filter(Boolean).join(", "))
                            || getVal(row, "Ket. All Trx") || "Pelunasan Batch",
                    paymentMethod: pmt.pMeth,
                    typeAutoNumber: pmt.code || "",
                    detailInvoice: []
                };
                if (branchId) newSrObj.branchId = branchId;
                groupedMap.set(groupKey, newSrObj);
            }
            const sr = groupedMap.get(groupKey)!;
            hostSr.set(pmt, sr);
            if (!invNo) continue;

            const disc = pmt === discountHost ? potonganFinal.map((d) => ({ ...d })) : [];
            const retur = pmt === returHost ? usedSrb + usedRjs : 0;
            let paymentAmount = pmt.used + retur + disc.reduce((s, d) => s + d.amount, 0);
            if (paymentAmount < 0) {
                // Selisih negatif lebih besar dari isi pelunasan ini: buang selisih, jangan kirim baris negatif.
                const i = disc.findIndex((d) => d.accountNo === akun.selisih);
                if (i >= 0) { paymentAmount -= disc[i].amount; disc.splice(i, 1); }
            }
            sr.chequeAmount += pmt.used;
            sr.DEBUG_INFO = {
                availSrb: srb.avail, usedSrb, availRjs: rjs.avail, usedRjs, usedDisc, selisih, maxPayable, intendedRowPayable,
                accuratePrimeOwing, invoiceLookupDebug: debugFaktur, accurateSrbNumber: srb.number, accurateSrbOutstanding: srb.outstanding,
                accurateRjsNumber: rjs.number, accurateRjsOutstanding: rjs.outstanding, unresolvedSrbAmt: srb.unresolved,
                unresolvedRjsAmt: rjs.unresolved, srbAmt, trxAmt,
            };
            if (!(paymentAmount > SANGAT_KECIL) && disc.length === 0) continue;
            // Accurate mewajibkan paymentAmount (uang + retur + potongan), walau 0 untuk pelunasan penuh lewat potongan.
            const existing = sr.detailInvoice.find((d: Bebas) => d.invoiceNo === invNo);
            if (existing) {
                existing.paymentAmount += paymentAmount;
                if (disc.length) existing.detailDiscount = [...(existing.detailDiscount ?? []), ...disc];
            } else {
                sr.detailInvoice.push(disc.length ? { invoiceNo: invNo, paymentAmount, detailDiscount: disc } : { invoiceNo: invNo, paymentAmount });
            }
            terlunasi += paymentAmount;
        }

        // 8. Dokumen retur: pelanggan sama → baris negatif di pelunasan Kas; beda pelanggan → pasangan ayat silang 110120.
        const sr = returHost ? hostSr.get(returHost) : undefined;
        const kurangRetur = { srb: 0, rjs: 0 };
        const prosesRetur = (desc: string, finalAmt: number, jenis: "srb" | "rjs") => {
            if (!sr || !invNo || !desc || finalAmt <= 0) return;
            const matchedRetObj = returMap.get(buildReturLookupKey(customerNo.trim(), desc.trim()));
            if (!matchedRetObj || matchedRetObj.number === "NOT_FOUND") return;

            let remainingToCover = finalAmt;
            const returnsToProcess = matchedRetObj.isArray ? matchedRetObj.returns : [matchedRetObj];
            const groupedAllocations = new Map<string, { customerNo: string, branchId?: number, branchName?: string, chequeAmount: number, detailInvoice: Array<{ invoiceNo: string, paymentAmount: number }> }>();
            for (const retItem of returnsToProcess) {
                if (remainingToCover <= 0) break;
                const limit = Number(retItem.primeOwing || 0);
                if (limit <= 0) continue; // sudah terpakai baris sebelumnya
                const allocated = Math.min(limit, remainingToCover);
                remainingToCover -= allocated;
                retItem.primeOwing -= allocated;
                const targetCustomerNo = retItem.customer?.customerNo || retItem.customer?.no || custReceipt;
                const targetBranchId = retItem.branch?.id || undefined;
                const groupKey = `${targetCustomerNo}|${targetBranchId || 0}`;
                if (!groupedAllocations.has(groupKey)) {
                    groupedAllocations.set(groupKey, { customerNo: targetCustomerNo, branchId: targetBranchId, branchName: retItem.branch?.name || undefined, chequeAmount: 0, detailInvoice: [] });
                }
                const group = groupedAllocations.get(groupKey)!;
                group.chequeAmount += Math.abs(allocated);
                group.detailInvoice.push({ invoiceNo: retItem.number, paymentAmount: -Math.abs(allocated) });
            }

            const lineInv = sr.detailInvoice.find((d: Bebas) => d.invoiceNo === invNo);
            // `pindah` = dibayar dokumen ayat silang (faktur tetap terlunasi); selain itu nilai itu memang tidak terlunasi.
            const kurangiFaktur = (n: number, pindah: boolean) => { if (lineInv) { lineInv.paymentAmount -= n; if (!pindah) terlunasi -= n; } };
            for (const group of groupedAllocations.values()) {
                if (String(group.customerNo).trim().toUpperCase() === custReceipt.trim().toUpperCase()) {
                    for (const d of group.detailInvoice) {
                        const ada = sr.detailInvoice.find((x: Bebas) => x.invoiceNo === d.invoiceNo);
                        if (ada) ada.paymentAmount += d.paymentAmount; else sr.detailInvoice.push({ ...d });
                    }
                    continue;
                }
                // Faktur dibayar dokumen ayat silang, jadi nilai ini keluar dari pelunasan Kas.
                kurangiFaktur(group.chequeAmount, true);
                ayatSilangDocs.push({
                    bankNo: "110120", chequeAmount: group.chequeAmount, customerNo: custReceipt, transDate: tanggal,
                    branchId: branchId || undefined, branchName: branchName || undefined, chequeDate: tanggal,
                    description: `Ayat Silang Faktur ${invNo} - ${desc}`, paymentMethod: "OTHERS",
                    detailInvoice: [{ invoiceNo: invNo, paymentAmount: group.chequeAmount }]
                });
                ayatSilangDocs.push({
                    bankNo: "110120", chequeAmount: -Math.abs(group.chequeAmount), customerNo: group.customerNo, transDate: tanggal,
                    branchId: group.branchId, branchName: group.branchName, chequeDate: tanggal,
                    description: `Ayat Silang Retur ${desc}`, paymentMethod: "OTHERS", detailInvoice: group.detailInvoice
                });
            }
            // Retur yang tidak tertutup dokumen (sisa retur Accurate habis di antara baris) tidak boleh ikut membayar faktur.
            if (remainingToCover > SANGAT_KECIL) { kurangiFaktur(remainingToCover, false); kurangRetur[jenis] = remainingToCover; }
            if (lineInv && !(lineInv.paymentAmount > SANGAT_KECIL) && !lineInv.detailDiscount) sr.detailInvoice.splice(sr.detailInvoice.indexOf(lineInv), 1);
        };
        prosesRetur(srbDesc, usedSrb, "srb");
        prosesRetur(rjsDesc, usedRjs, "rjs");
        if (kurangRetur.srb > 0 || kurangRetur.rjs > 0) {
            // Retur ketemu, tetapi sisanya di Accurate sudah terpakai baris lain: bagian itu tidak dilunasi dan masuk laporan manual.
            unresolvedReturWarnings.push({
                invoiceNo: invNo, customerNo, refs: [kurangRetur.srb > 0 ? srbDesc : "", kurangRetur.rjs > 0 ? rjsDesc : ""].filter(Boolean),
                unresolvedSrbAmt: kurangRetur.srb, unresolvedRjsAmt: kurangRetur.rjs, tunaiAmt, trfAmt, bgAmt, biayaBg,
                ketAllTrx: String(getVal(row, "Ket. All Trx") || "")
            });
        }

        // Sisa piutang lokal agar baris berikutnya atas faktur yang sama tidak mengalokasikan berlebih.
        if (invNo && invoiceBranchMap.has(invNo.trim())) invoiceBranchMap.get(invNo.trim())!.outstanding -= terlunasi;
    });

    return { groupedMap, ayatSilangDocs, unresolvedReturWarnings, dilewati, trxTakCocok };
}
