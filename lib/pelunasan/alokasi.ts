/**
 * Tujuan: mesin alokasi Pelunasan per baris Excel — dipindah UTUH dari W:1038-1573 `app/(dashboard)/api-wrapper/page.tsx`
 *   basis 5d6cc936 (S6e-1): healing potongan/retur ke piutang (toleransi Rp 100), jenis bayar Tunai/Trf/BG/RETUR_ONLY,
 *   waterfall Diskon → Retur → Kas, snap ke piutang, sisa piutang lokal antar-baris, dokumen Ayat Silang, peringatan retur
 *   yang belum ketemu. Perilaku dikunci golden lib/pelunasan/uji/golden.json.
 * Caller: lib/pelunasan/parser.ts (parsePelunasan).
 * Main Functions: alokasikan.
 * Side Effects: tidak ada I/O. Memutasi baris masukan (suntik SRB/RJS dari Ket. Pot, `_mutatedSrb/_mutatedRjs`), sisa
 *   piutang di `invoiceBranchMap`, dan `primeOwing` retur di `returMap` — sama dengan kode lama.
 * Akun keras (110102/110104/110105/110107/110120/600123/600126, AutoNum 300/350/550/950) dan placeholder
 *   `ISI_KODE_AKUN_POT*_DI_UI` TETAP (dipindah ke langkah Akun di S6e-2, bukan di sini).
 */
import { getTextVal, getVal, hasMeaningfulCellValue, type Bebas } from "./sel.ts";
import { buildReturLookupKey } from "./retur.ts";

export type PetaAkun = {
    mapTunaiAutoNum: string; mapTunaiBank: string;
    mapTrfAutoNum: string; mapTrfBank: string;
    mapBgAutoNum: string; mapBgBank: string;
    mapPot1Account: string; mapPot2Account: string; mapPot3Account: string;
};

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

export function alokasikan(cleanedData: Bebas[], ctx: {
    trxDate: string;
    peta: PetaAkun;
    returMap: Map<string, Bebas>;
    invoiceBranchMap: Map<string, Bebas>;
    invoiceLookupDebugMap: Map<string, Bebas>;
}) {
    const { trxDate, returMap, invoiceBranchMap, invoiceLookupDebugMap } = ctx;
    const { mapTunaiAutoNum, mapTunaiBank, mapTrfAutoNum, mapTrfBank, mapBgAutoNum, mapBgBank,
        mapPot1Account, mapPot2Account, mapPot3Account } = ctx.peta;

    const groupedMap = new Map();
    const ayatSilangDocs: Bebas[] = [];
    const unresolvedReturWarnings: PeringatanRetur[] = [];
    const unresolvedReturKeys = new Set<string>();

    cleanedData.forEach((row: Bebas) => {
        const rawOutlet = getTextVal(row, "Code Outlet");
        let srbDesc = getTextVal(row, "No.SRB Rt Ktr");
        let rjsDesc = getTextVal(row, "No.RJS RT Gt");

        let customerNo = rawOutlet;
        let branchName = undefined;
        let branchId = undefined;

        // JIka Excel Kosong Cabangnya, manfaatkan data Retur yg sudah valid dari Map!
        if (srbDesc) {
            const retKey = buildReturLookupKey(rawOutlet.trim(), srbDesc.trim());
            if (returMap.has(retKey)) {
                const matchedRet = returMap.get(retKey)!;
                if (!customerNo) customerNo = matchedRet.customerNo;
                if (!branchName) branchName = matchedRet.branchName;
                if (!branchId) branchId = matchedRet.branchId;
            }
        }

        if (rjsDesc) {
            const retKey = buildReturLookupKey(rawOutlet.trim(), rjsDesc.trim());
            if (returMap.has(retKey)) {
                const matchedRet = returMap.get(retKey)!;
                if (!customerNo) customerNo = matchedRet.customerNo;
                if (!branchName) branchName = matchedRet.branchName;
                if (!branchId) branchId = matchedRet.branchId;
            }
        }
        // Tarik branchId dari Invoice master jika murni Tunai/Transfer/BG
        const invNoForBranch = getTextVal(row, "No. Nota");
        if (invNoForBranch && invoiceBranchMap.has(invNoForBranch) && !branchId) {
            const ib = invoiceBranchMap.get(invNoForBranch)!;
            branchId = ib.branchId;
            branchName = ib.branchName;
        }

        if (!customerNo) return;

        // 1. Ambil nominal pembayaran
        const tunaiAmt = Number(getVal(row, "Tunai")) || 0;
        const trfAmt = Number(getVal(row, "Trf")) || 0;
        const bgAmt = Number(getVal(row, "BG")) || 0;

        const TOLERANSI_SELISIH = 100;

        // 2. Ambil nominal retur & diskon untuk row ini
        let srbAmt = Number(getVal(row, "Pot.RT Ktr")) || 0;
        let rjsAmt = Number(getVal(row, "Pot. RT Gt")) || 0;

        const ketPotRaw = getTextVal(row, "Ket. Pot");
        if (ketPotRaw && (ketPotRaw.toUpperCase().includes('RJN') || ketPotRaw.toUpperCase().includes('SRT'))) {
            const potLain = Number(getVal(row, "Pot. Lain")) || 0;
            if (potLain > 0) {
                if (srbAmt === 0) {
                    row["No.SRB Rt Ktr"] = ketPotRaw; // MUST BE INJECTED FOR DOWNSTREAM!
                    row["Pot.RT Ktr"] = potLain;
                    srbAmt = potLain;
                    srbDesc = ketPotRaw;
                    row["Pot. Lain"] = 0;
                } else if (rjsAmt === 0) {
                    row["No.RJS RT Gt"] = ketPotRaw;
                    row["Pot. RT Gt"] = potLain;
                    rjsAmt = potLain;
                    rjsDesc = ketPotRaw;
                    row["Pot. Lain"] = 0;
                }
            }
        }

        let pot1 = Number(getVal(row, "Pot.1 Kwtnsi")) || 0;
        let pot2 = Number(getVal(row, "Pot.2 Kwtnsi")) || 0;
        let pot3 = Number(getVal(row, "Pot.3 Kwtnsi")) || 0;
        const potTB = Number(getVal(row, "Pot.DiscTB")) || 0;
        const biayaBg = Number(getVal(row, "BiayaTrf/BG")) || 0;

        // HEALING DISKON & RETUR
        const invNoForHeal = getTextVal(row, "No. Nota");
        if (invNoForHeal && invoiceBranchMap.has(invNoForHeal)) {
            const out = invoiceBranchMap.get(invNoForHeal)!.outstanding;
            if (typeof out === 'number') {
                if (pot1 > 0 && Math.abs(pot1 - out) <= TOLERANSI_SELISIH) pot1 = out;
                if (pot2 > 0 && Math.abs(pot2 - out) <= TOLERANSI_SELISIH) pot2 = out;
                if (pot3 > 0 && Math.abs(pot3 - out) <= TOLERANSI_SELISIH) pot3 = out;
                if (srbAmt > 0 && Math.abs(srbAmt - out) <= TOLERANSI_SELISIH) srbAmt = out;
                if (rjsAmt > 0 && Math.abs(rjsAmt - out) <= TOLERANSI_SELISIH) rjsAmt = out;
            }
        }
        const srbt = getTextVal(row, "No.SRB Rt Ktr"); // This will now correctly find the injected ketPotRaw!
        if (srbAmt > 0 && srbt) {
            const rKey = buildReturLookupKey(customerNo.trim(), srbt.trim());
            if (returMap.has(rKey)) {
                const out = returMap.get(rKey)!.outstanding;
                if (typeof out === 'number' && Math.abs(srbAmt - Math.abs(out)) <= TOLERANSI_SELISIH) srbAmt = Math.abs(out);
            }
        }
        const rjst = getTextVal(row, "No.RJS RT Gt");
        if (rjsAmt > 0 && rjst) {
            const rKey = buildReturLookupKey(customerNo.trim(), rjst.trim());
            if (returMap.has(rKey)) {
                const out = returMap.get(rKey)!.outstanding;
                if (typeof out === 'number' && Math.abs(rjsAmt - Math.abs(out)) <= TOLERANSI_SELISIH) rjsAmt = Math.abs(out);
            }
        }

        const hasReturAtauDiskon = srbAmt > 0 || rjsAmt > 0 || pot1 > 0 || pot2 > 0 || pot3 > 0 || potTB > 0 || biayaBg > 0;

        // 3. Tentukan tipe pembayaran yang ada di row ini
        const payments: Bebas[] = [];
        if (tunaiAmt > 0) payments.push({ type: 'TUNAI', amt: tunaiAmt, bank: mapTunaiBank || "110102", code: mapTunaiAutoNum, cNo: "", pMeth: "CASH_OTHER" });

        if (trfAmt > 0) {
            const ketTrf = String(getVal(row, "Ket. Trf") || getVal(row, "Ket.TF") || "").toUpperCase();
            let targetBankTrf = mapTrfBank;
            let targetAutoNumTrf = mapTrfAutoNum;

            if (ketTrf.includes("MAYBANK")) {
                targetBankTrf = "110105";
                targetAutoNumTrf = "350";
            } else if (ketTrf.includes("PRMT") || ketTrf.includes("PERMATA")) {
                targetBankTrf = "110107";
                targetAutoNumTrf = "950";
            }
            payments.push({ type: 'TRF', amt: trfAmt, bank: targetBankTrf, code: targetAutoNumTrf, cNo: ketTrf, pMeth: "BANK_TRANSFER" });
        }
        if (bgAmt > 0) payments.push({ type: 'BG', amt: bgAmt, bank: mapBgBank || "110104", code: mapBgAutoNum || "550", cNo: getVal(row, "Ket.BG") || "", pMeth: "BANK_CHEQUE" });

        if (payments.length === 0) {
            if (hasReturAtauDiskon) {
                // Tidak ada uang cair, hanya potong memotong (Retur/Diskon Only)
                // Enum API Accurate untuk Non Tunai Lainnya secara harafiah adalah OTHERS
                payments.push({ type: 'RETUR_ONLY', amt: 0, bank: mapTunaiBank || "110102", code: mapTunaiAutoNum || "300", cNo: "", pMeth: "OTHERS" });
            } else {
                return; // baris kosong beneran
            }
        }

        // 4. Cari payment terbesar untuk menampung Retur/Diskon agar paymentAmount di tagihan tidak minus
        let largestIdx = 0;
        let maxAmt = -1;
        payments.forEach((p, idx) => {
            // Jika ada Retur/Diskon yang besar, prioritaskan payment yang ammount-nya paling stabil
            if (p.amt > maxAmt) { maxAmt = p.amt; largestIdx = idx; }
        });

        // 5. Proses setiap jenis pembayaran
        const invNo = getTextVal(row, "No. Nota");
        const hasExplicitTrxAmt = hasMeaningfulCellValue(row, "Total.Trx");
        const trxAmt = hasExplicitTrxAmt ? (Number(getVal(row, "Total.Trx")) || 0) : 0;

        payments.forEach((pmt, idx) => {
            const isLargest = (idx === largestIdx);
            // Bikin unique grouping key. Pembayaran dipecah per bank/tipe.
            const groupKey = `${customerNo}_${pmt.type}_${pmt.cNo}`;

            if (!groupedMap.has(groupKey)) {
                const newSrObj: Bebas = {
                    bankNo: pmt.bank || "",
                    chequeAmount: 0,
                    customerNo: customerNo,
                    transDate: trxDate.split('-').reverse().join('/'),
                    branchName: branchName || "",
                    chequeDate: trxDate.split('-').reverse().join('/'),
                    chequeNo: pmt.cNo || "",
                    description: getVal(row, "Ket. All Trx") || "Pelunasan Batch",
                    paymentMethod: pmt.pMeth,
                    typeAutoNumber: pmt.code || "",
                    detailInvoice: []
                };
                if (branchId) newSrObj.branchId = branchId;
                groupedMap.set(groupKey, newSrObj);
            }

            const sr = groupedMap.get(groupKey);

            if (invNo) {
                const dtInv: Bebas = {
                    invoiceNo: invNo,
                    paymentAmount: 0,
                    detailDiscount: []
                };

                // Siapkan array diskon dari excel
                if (isLargest) {
                    if (pot1 > 0) dtInv.detailDiscount.push({ amount: pot1, accountNo: mapPot1Account || "ISI_KODE_AKUN_POT1_DI_UI" });
                    if (pot2 > 0) dtInv.detailDiscount.push({ amount: pot2, accountNo: mapPot2Account || "ISI_KODE_AKUN_POT2_DI_UI" });
                    if (pot3 > 0) dtInv.detailDiscount.push({ amount: pot3, accountNo: mapPot3Account || "ISI_KODE_AKUN_POT3_DI_UI" });
                    if (potTB > 0) dtInv.detailDiscount.push({ amount: potTB, discountNotes: "Pot.DiscTB" });
                    if (biayaBg > 0) {
                        let acct = "600126"; // Default as TRF
                        if (bgAmt > 0) acct = "600123"; // If BG exists, prioritize BG account
                        else if (trfAmt > 0) acct = "600126";

                        dtInv.detailDiscount.push({ amount: biayaBg, accountNo: acct });
                    }
                }
                const totalDisc = dtInv.detailDiscount.reduce((sum: number, d: Bebas) => sum + d.amount, 0);

                // `Total.Trx` hanya dipakai sebagai batas pelunasan invoice, bukan sebagai sumber nominal kas.
                // Jika `Total.Trx` kosong, nominal dasar tetap persis dari Tunai/Trf/BG + potongan/retur,
                // dan outstanding Accurate hanya boleh menjadi batas atas, bukan menaikkan pembayaran agar invoice langsung lunas.
                // MESIN WATERFALL ALLOCATION & AUTO-HEALING
                const intendedRowPayable = totalDisc + srbAmt + rjsAmt + tunaiAmt + trfAmt + bgAmt;
                let maxPayable = hasExplicitTrxAmt ? trxAmt : intendedRowPayable;
                const invoiceMeta = invoiceBranchMap.get(invNo.trim());
                const invoiceLookupDebug = invoiceLookupDebugMap.get(invNo.trim());
                const accuratePrimeOwing = invoiceMeta?.outstanding != null && !isNaN(Number(invoiceMeta.outstanding))
                    ? Number(invoiceMeta.outstanding)
                    : undefined;
                if (invoiceMeta) {
                    const rawOut = invoiceMeta.outstanding;

                    // Jika API Mengamuk: outstanding Invoice di Accurate mungkin Rp 0 (karena sudah lunas atau data asimetris)
                    // Toleransi Snap
                    if (rawOut != null && !isNaN(Number(rawOut))) {
                        const invOut = Number(rawOut);
                        if (!hasExplicitTrxAmt) {
                            const diff = invOut - maxPayable;
                            if (Math.abs(diff) <= TOLERANSI_SELISIH) {
                                maxPayable = invOut; // Selisih kecil wajib disesuaikan agar invoice bisa langsung lunas tepat sesuai Accurate.
                                if (isLargest) pmt.amt = Math.max(0, pmt.amt + diff);
                            } else if (maxPayable > invOut) {
                                const overpayDiff = maxPayable - invOut;
                                maxPayable = invOut; // Tanpa Total.Trx, outstanding tetap menjadi batas atas overpayment besar.
                                if (isLargest) pmt.amt = Math.max(0, pmt.amt - overpayDiff);
                            }
                        } else if (trxAmt !== 0 && Math.abs(maxPayable - invOut) <= TOLERANSI_SELISIH) {
                            const diff = invOut - maxPayable;
                            maxPayable = invOut; // Snap
                            if (isLargest) pmt.amt += diff; // Bump payment to match exactly
                        } else if (maxPayable > invOut) {
                            maxPayable = invOut; // Cap overpayments (bahkan jika invOut 0, Lunas)
                        }
                    }
                }

                // ANTI-GHOSTING PROTOCOL: Jika API Gagal Tarik Data Outstanding,
                // dan Total.Trx di Excel Kosong (0), JANGAN BUNUH baris ini! Limit Payabel = Total Dana Yg Masuk.
                if (!hasExplicitTrxAmt && maxPayable === 0) {
                    maxPayable = intendedRowPayable;
                }

                // Deteksi kapasitas riil Retur
                let availSrb = 0;
                let accurateSrbOutstanding: number | undefined = undefined;
                let accurateSrbNumber: string | undefined = undefined;
                let unresolvedSrbAmt = 0;
                if (srbAmt > 0 && srbDesc) {
                    const srbKey = buildReturLookupKey(customerNo.trim(), srbDesc.trim());
                    if (returMap.has(srbKey)) {
                        const retData = returMap.get(srbKey)!;
                        accurateSrbNumber = retData.number;
                        const rawOut = retData.outstanding;
                        if (retData.number === "NOT_FOUND") {
                            unresolvedSrbAmt = srbAmt;
                            availSrb = 0;
                        } else if (rawOut != null && !isNaN(Number(rawOut))) {
                            const retOut = Math.abs(Number(rawOut));
                            accurateSrbOutstanding = retOut;
                            if (Math.abs(srbAmt - retOut) <= TOLERANSI_SELISIH) {
                                availSrb = retOut; // Snap up/down
                                maxPayable += (retOut - srbAmt); // Kompensasi kapasitor
                            } else if (retOut === 0 || retOut < 0.01) {
                                availSrb = srbAmt; // ANTI-GHOSTING RETUR: Jangan bunuh jika API sudah Lunas
                            } else {
                                availSrb = Math.min(srbAmt, retOut);
                            }
                        } else {
                            availSrb = srbAmt;
                        }
                    } else {
                        unresolvedSrbAmt = srbAmt;
                        availSrb = 0;
                    }
                }

                let availRjs = 0;
                let accurateRjsOutstanding: number | undefined = undefined;
                let accurateRjsNumber: string | undefined = undefined;
                let unresolvedRjsAmt = 0;
                if (rjsAmt > 0 && rjsDesc) {
                    const rjsKey = buildReturLookupKey(customerNo.trim(), rjsDesc.trim());
                    if (returMap.has(rjsKey)) {
                        const retData = returMap.get(rjsKey)!;
                        accurateRjsNumber = retData.number;
                        const rawOut = retData.outstanding;
                        if (retData.number === "NOT_FOUND") {
                            unresolvedRjsAmt = rjsAmt;
                            availRjs = 0;
                        } else if (rawOut != null && !isNaN(Number(rawOut))) {
                            const rjsOut = Math.abs(Number(rawOut));
                            accurateRjsOutstanding = rjsOut;
                            if (Math.abs(rjsAmt - rjsOut) <= TOLERANSI_SELISIH) {
                                availRjs = rjsOut; // Snap up/down
                                maxPayable += (rjsOut - rjsAmt); // Kompensasi kapasitor
                            } else if (rjsOut === 0 || rjsOut < 0.01) {
                                availRjs = rjsAmt;  // ANTI-GHOSTING RETUR: Jangan bunuh jika API sudah Lunas
                            } else {
                                availRjs = Math.min(rjsAmt, rjsOut);
                            }
                        } else {
                            availRjs = rjsAmt;
                        }
                    } else {
                        unresolvedRjsAmt = rjsAmt;
                        availRjs = 0;
                    }
                }

                // Alokasi Pelunasan Prioritas: Diskon -> Retur -> Kas Fisik (Tunai/BG/Trf)
                let owed = maxPayable;
                let usedDisc = 0, usedSrb = 0, usedRjs = 0;

                if (isLargest) {
                    usedDisc = Math.min(totalDisc, owed);
                    owed -= usedDisc;

                    usedSrb = Math.min(availSrb, owed);
                    owed -= usedSrb;

                    usedRjs = Math.min(availRjs, owed);
                    owed -= usedRjs;

                    row._mutatedSrb = usedSrb;
                    row._mutatedRjs = usedRjs;
                }

                const remainingBeforeCash = owed;
                // Khusus alokasi Kas Fisik dari line ini
                const usedCash = Math.min(pmt.amt, owed);
                const remainingAfterCash = Math.max(0, remainingBeforeCash - usedCash);

                // Modifikasi struktur final API
                sr.chequeAmount += usedCash;
                dtInv.paymentAmount = usedCash + usedSrb + usedRjs + usedDisc; // Accurate API mewajibkan paymentAmount = total semua (Cash + Return + Diskon)

                const sKeyDEBUG = srbDesc ? buildReturLookupKey(customerNo.trim(), srbDesc.trim()) : "NO_SRB";
                sr.DEBUG_INFO = {
                    availSrb,
                    usedSrb,
                    owed: remainingAfterCash,
                    remainingBeforeCash,
                    maxPayable,
                    intendedRowPayable,
                    accuratePrimeOwing,
                    invoiceLookupDebug,
                    accurateSrbNumber,
                    accurateSrbOutstanding,
                    accurateRjsNumber,
                    accurateRjsOutstanding,
                    unresolvedSrbAmt,
                    unresolvedRjsAmt,
                    srbAmt,
                    trxAmt,
                    returLookupKey: sKeyDEBUG,
                    returMapHit: returMap.has(sKeyDEBUG),
                    returData: returMap.get(sKeyDEBUG)
                };

                if (isLargest && (unresolvedSrbAmt > 0 || unresolvedRjsAmt > 0)) {
                    const unresolvedKey = `${customerNo}|${invNo}|${srbDesc}|${rjsDesc}`;
                    if (!unresolvedReturKeys.has(unresolvedKey)) {
                        unresolvedReturKeys.add(unresolvedKey);
                        unresolvedReturWarnings.push({
                            invoiceNo: invNo,
                            customerNo,
                            refs: [
                                accurateSrbNumber === "NOT_FOUND" ? srbDesc : "",
                                accurateRjsNumber === "NOT_FOUND" ? rjsDesc : ""
                            ].filter(Boolean) as string[],
                            unresolvedSrbAmt,
                            unresolvedRjsAmt,
                            tunaiAmt,
                            trfAmt,
                            bgAmt,
                            biayaBg,
                            ketAllTrx: String(getVal(row, "Ket. All Trx") || "")
                        });
                    }
                }


                // Scale-down array diskon secara proporsional sesuai uang diskon yang terpakai
                if (isLargest && totalDisc > usedDisc) {
                    let leftover = usedDisc;
                    for (const d of dtInv.detailDiscount) {
                        if (leftover <= 0) { d.amount = 0; continue; }
                        if (d.amount > leftover) { d.amount = leftover; leftover = 0; }
                        else { leftover -= d.amount; }
                    }
                    dtInv.detailDiscount = dtInv.detailDiscount.filter((d: Bebas) => d.amount > 0);
                }

                if (dtInv.detailDiscount && dtInv.detailDiscount.length === 0) delete dtInv.detailDiscount;

                if (dtInv.paymentAmount <= 0 && !dtInv.detailDiscount && (unresolvedSrbAmt > 0 || unresolvedRjsAmt > 0)) {
                    return;
                }

                // Accurate API REQUIRES paymentAmount to exist, even if it is 0 (for full discount settlements).
                // Do not delete dtInv.paymentAmount.

                // Push ke payload bila ada nilai pembayaran (atau pembayaran 0 tapi terbayar lunas via diskon)
                if (dtInv.paymentAmount > 0 || dtInv.detailDiscount) {
                    const existingDtInv = sr.detailInvoice.find((d: Bebas) => d.invoiceNo === dtInv.invoiceNo);
                    if (existingDtInv) {
                        existingDtInv.paymentAmount += dtInv.paymentAmount;
                        if (dtInv.detailDiscount) {
                            if (!existingDtInv.detailDiscount) existingDtInv.detailDiscount = [];
                            existingDtInv.detailDiscount.push(...dtInv.detailDiscount);
                        }
                    } else {
                        sr.detailInvoice.push(dtInv);
                    }

                    // HACK Keterbatasan Saldo: Update sisa piutang di memori lokal agar baris Excel berikutnya tidak over-allocate
                    if (invoiceBranchMap.has(invNo.trim())) {
                        invoiceBranchMap.get(invNo.trim())!.outstanding -= dtInv.paymentAmount;
                    }
                }
            }

            // JIKA INI PAYMENT TERBESAR, PISAHKAN FAKTUR RETUR MENJADI DOKUMEN AYAT SILANG!
            if (isLargest) {
                const finalSrb = row._mutatedSrb !== undefined ? row._mutatedSrb : srbAmt;
                const finalRjs = row._mutatedRjs !== undefined ? row._mutatedRjs : rjsAmt;

                const processAyatSilang = (desc: string, finalAmt: number) => {
                    if (!desc || finalAmt <= 0) return;
                    const key = buildReturLookupKey(customerNo.trim(), desc.trim());
                    if (!returMap.has(key)) return;

                    const matchedRetObj = returMap.get(key)!;
                    if (matchedRetObj.number === "NOT_FOUND") return;

                    let remainingToCover = finalAmt;
                    const returnsToProcess = matchedRetObj.isArray ? matchedRetObj.returns : [matchedRetObj];
                    const groupedAllocations = new Map<string, {
                        customerNo: string,
                        branchId?: number,
                        branchName?: string,
                        chequeAmount: number,
                        detailInvoice: Array<{ invoiceNo: string, paymentAmount: number }>
                    }>();

                    for (const retItem of returnsToProcess) {
                        if (remainingToCover <= 0) break;

                        const limit = Number(retItem.primeOwing || 0);
                        if (limit <= 0) continue; // Already covered by previous rows

                        const allocated = Math.min(limit, remainingToCover);
                        remainingToCover -= allocated;

                        // UPDATE local memory
                        retItem.primeOwing -= allocated;
                        const targetCustomerNo = retItem.customer?.customerNo || retItem.customer?.no || customerNo;
                        const targetBranchId = retItem.branch?.id || undefined;
                        const targetBranchName = retItem.branch?.name || undefined;
                        const groupKey = `${targetCustomerNo}|${targetBranchId || 0}`;

                        if (!groupedAllocations.has(groupKey)) {
                            groupedAllocations.set(groupKey, {
                                customerNo: targetCustomerNo,
                                branchId: targetBranchId,
                                branchName: targetBranchName,
                                chequeAmount: 0,
                                detailInvoice: []
                            });
                        }

                        const group = groupedAllocations.get(groupKey)!;
                        group.chequeAmount += Math.abs(allocated);
                        group.detailInvoice.push({
                            invoiceNo: retItem.number,
                            paymentAmount: -Math.abs(allocated)
                        });
                    }

                    for (const group of groupedAllocations.values()) {
                        // Sisi faktur asal: satu JSON per kelompok customer/cabang retur
                        ayatSilangDocs.push({
                            bankNo: "110120",
                            chequeAmount: group.chequeAmount,
                            customerNo: customerNo,
                            transDate: trxDate.split('-').reverse().join('/'),
                            branchId: branchId || undefined,
                            branchName: branchName || undefined,
                            chequeDate: trxDate.split('-').reverse().join('/'),
                            description: `Ayat Silang Faktur ${invNo} - ${desc}`,
                            paymentMethod: "OTHERS",
                            detailInvoice: [{
                                invoiceNo: invNo,
                                paymentAmount: group.chequeAmount
                            }]
                        });

                        // Sisi retur: gabungkan semua retur dengan customer+branch yang sama
                        ayatSilangDocs.push({
                            bankNo: "110120",
                            chequeAmount: -Math.abs(group.chequeAmount),
                            customerNo: group.customerNo,
                            transDate: trxDate.split('-').reverse().join('/'),
                            branchId: group.branchId,
                            branchName: group.branchName,
                            chequeDate: trxDate.split('-').reverse().join('/'),
                            description: `Ayat Silang Retur ${desc}`,
                            paymentMethod: "OTHERS",
                            detailInvoice: group.detailInvoice
                        });
                    }
                };

                processAyatSilang(srbDesc, finalSrb);
                processAyatSilang(rjsDesc, finalRjs);
            }
        });
    });

    return { groupedMap, ayatSilangDocs, unresolvedReturWarnings };
}
