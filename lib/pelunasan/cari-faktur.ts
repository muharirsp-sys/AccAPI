/**
 * Tujuan: mencari faktur penjualan (cabang + sisa piutang) per No. Nota untuk Pelunasan — dipindah dari W:928-1036
 *   `app/(dashboard)/api-wrapper/page.tsx` basis 5d6cc936 (S6e-1). Urutan per faktur tetap: list.do EQUAL → keyword →
 *   CONTAIN nomor penuh → CONTAIN ekor. Perilaku dikunci golden lib/pelunasan/uji/golden.json.
 * Caller: lib/pelunasan/parser.ts (parsePelunasan).
 * Main Functions: cariFaktur.
 * Side Effects: GET Accurate `sales-invoice/list.do` lewat `accurateFetch` DIINJEKSI. S6e-1: dulu `Promise.all` tanpa
 *   batas (N No. Nota = N pencarian serentak → risiko 429 Accurate); kini kolam `konkurensi` (bawaan 4).
 *   Hasil tidak bergantung urutan selesai: kedua peta hanya dibaca per kunci (get), tidak pernah diiterasi.
 */
import type { Bebas } from "./sel.ts";
import type { AccurateFetch } from "./retur.ts";

export const KONKURENSI_CARI_FAKTUR = 4;

/** Jalankan `kerja` atas tiap butir, paling banyak `n` berjalan bersamaan. `kerja` tidak boleh melempar (cariSatu menangkap sendiri). */
async function kolam<T>(items: T[], n: number, kerja: (item: T) => Promise<void>) {
    let berikut = 0;
    const pekerja = Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
        while (berikut < items.length) await kerja(items[berikut++]);
    });
    await Promise.all(pekerja);
}

export async function cariFaktur(invoiceNos: Set<string>, accurateFetch: AccurateFetch, konkurensi = KONKURENSI_CARI_FAKTUR) {
    const invoiceBranchMap = new Map<string, Bebas>();
    const invoiceLookupDebugMap = new Map<string, Bebas>();
    try {
        const invArray = Array.from(invoiceNos);
        // Pencarian individual per nama invoice, dibatasi kolam `konkurensi`.
        await kolam(invArray, konkurensi, async (invNo) => {
            const cleanInvNo = invNo.trim();
            try {
                let invObj: Bebas | null | undefined = null;
                let lookupSource = "NONE";
                const matchFn = (i: Bebas) => {
                    const rawApiInv = (i.number || "").toUpperCase();
                    const cInv = cleanInvNo.toUpperCase();
                    return rawApiInv.trim() === cInv || rawApiInv.trim().includes(cInv) || cInv.includes(rawApiInv.trim());
                };
                const invTailToken = cleanInvNo.split('/').pop()?.trim() || cleanInvNo;

                const exactRes = await accurateFetch('/api/sales-invoice/list.do', 'GET', {
                    fields: "number,branch,primeOwing,customer,charField1",
                    "filter.number.op": "EQUAL",
                    "filter.number.val": cleanInvNo
                });

                if (exactRes && exactRes.d && exactRes.d.length > 0) {
                    invObj = exactRes.d.find((item: Bebas) => String(item.number || "").trim().toUpperCase() === cleanInvNo.toUpperCase()) || exactRes.d[0];
                    if (invObj) lookupSource = "NUMBER_EQUAL";
                }

                if (!invObj) {
                    const res = await accurateFetch('/api/sales-invoice/list.do', 'GET', {
                        fields: "number,branch,primeOwing,customer,charField1",
                        "keyword": cleanInvNo
                    });

                    if (res && res.d && res.d.length > 0) {
                        // Mencegah pembajakan data! Pastikan tagihan yg ditarik adalah RELEVAN (Bukan faktur kesasar SHINZUI dll)
                        invObj = res.d.find(matchFn);
                        if (invObj) lookupSource = "KEYWORD_FULL";
                    }
                }

                // FALLBACK: Jika global keyword menyerah akibat slashes (/), tembak spesifik dengan CONTAIN
                if (!invObj) {
                    const fbRes = await accurateFetch('/api/sales-invoice/list.do', 'GET', {
                        fields: "number,branch,primeOwing,customer,charField1",
                        "filter.number.op": "CONTAIN",
                        "filter.number.val": cleanInvNo
                    });
                    if (fbRes && fbRes.d && fbRes.d.length > 0) {
                        invObj = fbRes.d.find(matchFn);
                        if (invObj) lookupSource = "NUMBER_CONTAIN_FULL";
                    }
                }

                if (!invObj && invTailToken && invTailToken !== cleanInvNo) {
                    const tailRes = await accurateFetch('/api/sales-invoice/list.do', 'GET', {
                        fields: "number,branch,primeOwing,customer,charField1",
                        "filter.number.op": "CONTAIN",
                        "filter.number.val": invTailToken
                    });
                    if (tailRes && tailRes.d && tailRes.d.length > 0) {
                        invObj = tailRes.d.find(matchFn)
                            || tailRes.d.find((item: Bebas) => String(item.number || "").toUpperCase().includes(invTailToken.toUpperCase()));
                        if (invObj) lookupSource = "NUMBER_CONTAIN_TAIL";
                    }
                }

                if (invObj) {
                    invoiceBranchMap.set(cleanInvNo, {
                        invoiceNo: invObj.number || cleanInvNo,
                        branchId: invObj.branch?.id,
                        branchName: invObj.branch?.name,
                        outstanding: invObj.primeOwing,
                        // Tidak dibaca di mana pun: pencarian retur (satu-satunya pembaca, W:683-691) jalan SEBELUM peta ini diisi.
                        charField1: invObj.charField1 || invObj.customer?.charField1 || "",
                        lookupSource
                    });
                    invoiceLookupDebugMap.set(cleanInvNo, {
                        found: true,
                        lookupSource,
                        matchedInvoiceNo: invObj.number || cleanInvNo,
                        branchName: invObj.branch?.name || "",
                        primeOwing: invObj.primeOwing
                    });
                } else {
                    invoiceLookupDebugMap.set(cleanInvNo, {
                        found: false,
                        lookupSource,
                        matchedInvoiceNo: "",
                        branchName: "",
                        primeOwing: null
                    });
                }
            } catch (e: unknown) {
                invoiceLookupDebugMap.set(cleanInvNo, {
                    found: false,
                    lookupSource: "ERROR",
                    matchedInvoiceNo: "",
                    branchName: "",
                    primeOwing: null,
                    error: (e as Bebas)?.message || String(e)
                });
            }
        });
    } catch (e) {
        console.error("Gagal menarik data cabang invoice", e);
    }
    return { invoiceBranchMap, invoiceLookupDebugMap };
}
