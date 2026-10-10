/* eslint-disable @typescript-eslint/no-explicit-any, prefer-const, @typescript-eslint/no-unused-vars -- SEMENTARA (S6e-1 tahap 1): salinan VERBATIM kode lama, dihapus di tahap 2 */
/**
 * ORACLE SEMENTARA S6e-1 tahap 1 — BUKAN kode produksi. Dihapus di tahap 2 setelah lib/pelunasan lulus golden.
 * Isi blok bertanda VERBATIM disalin mekanis dari `git show 5d6cc936:app/(dashboard)/api-wrapper/page.tsx`:
 *   W:30-45 (tipe duplikat), W:80-87 (normalizePayloadMoney), W:275-1629 (helper retur + parser Pelunasan),
 *   W:1903-2053 (previewAccurateSalesReceiptHistory + previewSalesReceiptDuplicates).
 * Verifikasi: bandingkan tiap blok VERBATIM dengan `sed -n A,Bp` berkas basis — harus identik byte demi byte.
 * Yang BUKAN verbatim hanya pembungkus: toast/setPayloadStr/XLSX/setTimeout/fetch diganti perekam.
 */
import { buildSalesReceiptIdempotencyPayload } from "../../sales-receipt-fingerprint.ts";

export type OpsiLama = {
    trxDate: string;
    isKeySaved: boolean;
    mapTunaiAutoNum: string; mapTunaiBank: string;
    mapTrfAutoNum: string; mapTrfBank: string;
    mapBgAutoNum: string; mapBgBank: string;
    mapPot1Account: string; mapPot2Account: string; mapPot3Account: string;
    accurateFetch: (path: string, method: string, payload?: unknown) => Promise<any>;
};

export async function jalankanPelunasanLama(cleanedDataMasuk: any[], opsi: OpsiLama) {
    const { trxDate, isKeySaved, mapTunaiAutoNum, mapTunaiBank, mapTrfAutoNum, mapTrfBank, mapBgAutoNum, mapBgBank,
        mapPot1Account, mapPot2Account, mapPot3Account, accurateFetch } = opsi;
    const keluaran = { payloadStr: null as string | null, manualRows: null as any[] | null, toasts: [] as any[][] };
    const catat = (jenis: string) => (...args: any[]) => { keluaran.toasts.push([jenis, ...args]); };
    const toast = { loading: catat("loading"), success: catat("success"), warning: catat("warning"), error: catat("error") };
    const setPayloadStr = (s: string) => { keluaran.payloadStr = s; };
    const setInputMode = (_m: string) => {};
    const e = { target: { value: "" as string } };
    const XLSX = {
        utils: { json_to_sheet: (rows: any[]) => { keluaran.manualRows = rows; return {}; }, book_new: () => ({}), book_append_sheet: (..._a: any[]) => {} },
        writeFile: (..._a: any[]) => {},
    };
    const setTimeout = (fn: () => void, _ms?: number) => { fn(); };

    // ---- VERBATIM W:80-87
  const normalizePayloadMoney = (value: unknown) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    // Simpan presisi sampai 6 desimal agar selisih kecil seperti 0.002 tidak hilang,
    // tapi tetap rapikan noise floating-point Excel.
    const normalized = Number(num.toFixed(6));
    return Math.abs(normalized) < 0.000001 ? 0 : normalized;
  };
    // ---- akhir VERBATIM W:80-87

    const jalan = async () => {
        let cleanedData = cleanedDataMasuk;
        // ---- VERBATIM W:275-1629
        const getVal = (row: any, keyMatch: string) => {
            const foundKey = Object.keys(row).find(k => k.trim() === keyMatch);
            return foundKey ? row[foundKey] : undefined;
        };

        const getTextVal = (row: any, keyMatch: string) => {
            const rawVal = getVal(row, keyMatch);
            if (rawVal === undefined || rawVal === null) return "";
            const text = String(rawVal).replace(/\u00A0/g, " ").trim();
            if (!text || ["nan", "undefined", "null"].includes(text.toLowerCase())) return "";
            return text;
        };
        const hasMeaningfulCellValue = (row: any, keyMatch: string) => {
            const rawVal = getVal(row, keyMatch);
            if (rawVal === undefined || rawVal === null) return false;
            const text = String(rawVal).replace(/\u00A0/g, " ").trim();
            return !!text && !["nan", "undefined", "null"].includes(text.toLowerCase());
        };

        const normalizeLookupText = (value: string) => value.toUpperCase().replace(/[\s.,-]+/g, "");
        const matchesReturTokenBoundary = (rawValue: string, token: string) => {
            if (!rawValue || !token) return false;
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, "i").test(rawValue);
        };

        const parseReturReference = (rawDesc: string) => {
            const desc = getTextVal({ value: rawDesc }, "value");
            if (!desc) {
                return {
                    prefix: "",
                    srtTokens: [] as string[],
                    fullDocTokens: [] as string[],
                    codeTokens: [] as string[],
                    searchKeywords: [] as string[],
                };
            }

            const slashParts = desc.split('/').map((part) => part.trim()).filter(Boolean);
            const prefix = slashParts[0] && /^[A-Z]+$/i.test(slashParts[0]) ? slashParts[0].toUpperCase() : "";
            let currentPeriod = "";
            const srtTokens: string[] = [];
            const fullDocTokens: string[] = [];
            const codeTokens: string[] = [];
            const seen = new Set<string>();
            const pushUnique = (bucket: string, target: string[], value: string) => {
                const cleanValue = value.trim();
                if (!cleanValue) return;
                const key = `${bucket}|${cleanValue.toUpperCase()}`;
                if (seen.has(key)) return;
                seen.add(key);
                target.push(cleanValue);
            };

            slashParts.forEach((part, index) => {
                if (index === 0 && prefix) return;
                if (/^\d{4}$/.test(part)) {
                    currentPeriod = part;
                    return;
                }

                const commaParts = part.split(',').map((item) => item.trim()).filter(Boolean);
                commaParts.forEach((item) => {
                    if (/^\d{4}$/.test(item)) {
                        currentPeriod = item;
                        return;
                    }
                    if (/^SRT[.\-/]/i.test(item)) {
                        pushUnique("S", srtTokens, item.toUpperCase());
                        return;
                    }

                    const upperItem = item.toUpperCase();
                    if (currentPeriod) {
                        if (prefix) pushUnique("F", fullDocTokens, `${prefix}/${currentPeriod}/${upperItem}`);
                        else pushUnique("F", fullDocTokens, `${currentPeriod}/${upperItem}`);
                    }
                    pushUnique("C", codeTokens, upperItem);
                });
            });

            const searchKeywords = Array.from(new Set([
                ...srtTokens,
                ...fullDocTokens,
                ...codeTokens,
                desc,
            ]));

            return {
                prefix,
                srtTokens,
                fullDocTokens,
                codeTokens,
                searchKeywords,
            };
        };

        const SALES_RETURN_SEARCH_FIELDS = "number,customer,branch,description,primeOwing,keywords,returnDocumentNumber,documentCode,charField1";
        const AYAT_SILANG_SEARCH_FIELDS = "number,customer,branch,description,primeOwing,keywords,charField1";
        const isAyatSilangReference = (desc: string) => {
            const normalized = String(desc || "").toUpperCase().trim();
            return normalized.includes("RJN/") || normalized.includes("/RJN/") || normalized.includes("SRT.");
        };
        const buildReturLookupKey = (customerNo: string, desc: string) => {
            const cleanDesc = String(desc || "").trim();
            if (!cleanDesc) return "";
            if (isAyatSilangReference(cleanDesc)) return `DOC|${cleanDesc}`;
            return `${String(customerNo || "").trim()}|${cleanDesc}`;
        };
        const buildReturSearchVariants = (documentNo: string) => {
            const base = String(documentNo || "").trim().toUpperCase();
            if (!base) return [] as string[];
            const variants = [base];
            const compact = base.replace(/\s+/g, "");
            if (compact && compact !== base) variants.push(compact);
            const codeOnly = base.split('/').pop()?.trim() || "";
            if (codeOnly && codeOnly !== base) variants.push(codeOnly);
            const srbMatch = base.match(/^SRB\s*(.+)$/i);
            if (srbMatch) {
                const rawSuffix = srbMatch[1].trim();
                const compactSuffix = rawSuffix.replace(/\s+/g, "");
                variants.push(`SRB${compactSuffix}`);
                variants.push(`SRB ${compactSuffix}`);
                const yearExpanded = compactSuffix.replace(/^(\d{2})(?=[.\-/]|$)/, "20$1");
                if (yearExpanded !== compactSuffix) {
                    variants.push(`SRB${yearExpanded}`);
                    variants.push(`SRB ${yearExpanded}`);
                }
            }
            return Array.from(new Set(variants));
        };
        const extractReturLookupTexts = (ret: any) => {
            return [
                String(ret?.number || ""),
                String(ret?.keywords || ""),
                String(ret?.returnDocumentNumber || ""),
                String(ret?.documentCode || ""),
                String(ret?.description || ""),
            ].filter(Boolean);
        };
        const returDocumentMatches = (ret: any, documentNo: string) => {
            const lookupTexts = extractReturLookupTexts(ret);
            const variants = buildReturSearchVariants(documentNo);
            return variants.some((variant) => {
                const variantNorm = normalizeLookupText(variant);
                const isFullDocument = variant.includes("/") || /^SRT[.\-/]/i.test(variant);
                return lookupTexts.some((rawText) => {
                    const upperText = String(rawText || "").toUpperCase();
                    const textNorm = normalizeLookupText(upperText);
                    if (isFullDocument) {
                        return (
                            upperText === variant ||
                            textNorm === variantNorm ||
                            textNorm.endsWith(variantNorm) ||
                            upperText.includes(variant)
                        );
                    }
                    return (
                        matchesReturTokenBoundary(upperText, variant) ||
                        textNorm === variantNorm ||
                        textNorm.endsWith(variantNorm)
                    );
                });
            });
        };
        const fetchReturByDocument = async (documentNo: string, label: string, xrayLogs: string[]) => {
            const variants = buildReturSearchVariants(documentNo);
            const candidateMap = new Map<string, any>();
            const safeSearchFetch = async (path: string, payload: any, errLabel: string) => {
                try {
                    return await accurateFetch(path, 'GET', payload);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    xrayLogs.push(`${errLabel}_ERR:${msg.substring(0, 180)}`);
                    return null;
                }
            };

            for (const variant of variants) {
                let currentPage = 1;
                let pageCount = 1;
                let scanned = 0;

                do {
                    const res = await safeSearchFetch('/api/sales-invoice/list.do', {
                        fields: AYAT_SILANG_SEARCH_FIELDS,
                        keyword: variant,
                        "sp.pageSize": 100,
                        "sp.page": currentPage
                    }, `${label}_${variant}_AYAT`);

                    const rows = Array.isArray(res?.d) ? res.d : [];
                    scanned += rows.length;
                    rows.forEach((item: any) => {
                        const key = String(item?.number || `${variant}|${candidateMap.size}`);
                        if (!candidateMap.has(key)) candidateMap.set(key, item);
                    });

                    pageCount = Number(res?.sp?.pageCount || currentPage || 1);
                    currentPage += 1;
                } while (currentPage <= pageCount && currentPage <= 4 && candidateMap.size < 200);

                xrayLogs.push(`${label}_${variant}_KeywordPool:${candidateMap.size}_Scanned:${scanned}`);
            }

            const exactMatches = Array.from(candidateMap.values()).filter((item) => returDocumentMatches(item, documentNo));
            xrayLogs.push(`${label}_${documentNo}_Exact:[${exactMatches.map((item: any) => item.number).join('|') || '-'}]`);
            return exactMatches;
        };
        const enrichReturDetails = async (returns: any[], xrayLogs: string[]) => {
            const enriched: any[] = [];
            for (const retItem of returns) {
                const fallbackPrime = Number(retItem?.primeOwing || 0);
                const lookupNumber = String(retItem?.number || "").trim();
                const lookupId = retItem?.id;
                if (!lookupId && !lookupNumber) {
                    enriched.push(retItem);
                    continue;
                }

                try {
                    const detailRes = await accurateFetch('/api/sales-invoice/detail.do', 'GET', lookupId ? { id: lookupId } : { number: lookupNumber });
                    const detailData = detailRes?.d || detailRes || {};
                    const detailPrime = Number(detailData?.primeOwing);
                    const merged = {
                        ...retItem,
                        ...detailData,
                        number: detailData?.number || retItem?.number,
                        customer: detailData?.customer || retItem?.customer,
                        branch: detailData?.branch || retItem?.branch,
                        primeOwing: !Number.isNaN(detailPrime) ? detailPrime : fallbackPrime,
                    };
                    xrayLogs.push(`Detail_${merged.number}_Prime:${merged.primeOwing}`);
                    enriched.push(merged);
                } catch (detailErr) {
                    xrayLogs.push(`Detail_${lookupNumber || lookupId}_ERR:${detailErr instanceof Error ? detailErr.message : String(detailErr)}`);
                    enriched.push(retItem);
                }
            }
            return enriched;
        };

        const scoreReturCandidate = (ret: any, custNo: string, expectedCharField1: string, parsedRef: ReturnType<typeof parseReturReference>) => {
            const rawDesc = String(ret?.description || "");
            const rawNumber = String(ret?.number || "");
            const rawKeywords = String(ret?.keywords || "");
            const rawReturnDocumentNumber = String(ret?.returnDocumentNumber || "");
            const rawDocumentCode = String(ret?.documentCode || "");
            const rawHeaderCharField1 = String(ret?.charField1 || "");
            const descNorm = normalizeLookupText(rawDesc);
            const numberNorm = normalizeLookupText(rawNumber);
            const keywordsNorm = normalizeLookupText(rawKeywords);
            const returnDocumentNorm = normalizeLookupText(rawReturnDocumentNumber);
            const documentCodeNorm = normalizeLookupText(rawDocumentCode);
            const headerCharField1Norm = normalizeLookupText(rawHeaderCharField1);
            const apiCust = String(ret?.customer?.customerNo || ret?.customer?.no || "").toUpperCase();
            const apiCharField1 = String(ret?.customer?.charField1 || "").toUpperCase().trim();
            const cleanCust = custNo.toUpperCase();
            const expChar = expectedCharField1.toUpperCase().trim();
            const isAyatSilangRef = parsedRef.srtTokens.length > 0 || parsedRef.fullDocTokens.length > 0 || parsedRef.codeTokens.length > 0;
            const matchesAny = (norm: string) => (
                descNorm.includes(norm) ||
                numberNorm.includes(norm) ||
                keywordsNorm.includes(norm) ||
                returnDocumentNorm.includes(norm) ||
                documentCodeNorm.includes(norm) ||
                headerCharField1Norm.includes(norm)
            );
            const exactishAny = (norm: string) => (
                numberNorm === norm ||
                returnDocumentNorm === norm ||
                keywordsNorm === norm ||
                documentCodeNorm === norm ||
                numberNorm.endsWith(norm) ||
                returnDocumentNorm.endsWith(norm)
            );

            let score = 0;
            if (!isAyatSilangRef) {
                if (expChar && apiCharField1 && expChar === apiCharField1) score += 40;
                else if (cleanCust.includes(apiCust) || apiCust.includes(cleanCust)) score += 25;
            }

            parsedRef.srtTokens.forEach((token) => {
                const norm = normalizeLookupText(token);
                if (matchesAny(norm) || matchesReturTokenBoundary(rawDesc, token) || matchesReturTokenBoundary(rawNumber, token) || matchesReturTokenBoundary(rawKeywords, token) || matchesReturTokenBoundary(rawReturnDocumentNumber, token)) {
                    score += 260;
                    if (matchesReturTokenBoundary(rawNumber, token) || matchesReturTokenBoundary(rawReturnDocumentNumber, token) || exactishAny(norm)) score += 120;
                }
            });

            parsedRef.fullDocTokens.forEach((token) => {
                const norm = normalizeLookupText(token);
                if (matchesAny(norm) || matchesReturTokenBoundary(rawDesc, token) || matchesReturTokenBoundary(rawNumber, token) || matchesReturTokenBoundary(rawKeywords, token) || matchesReturTokenBoundary(rawReturnDocumentNumber, token)) {
                    score += 220;
                    if (matchesReturTokenBoundary(rawNumber, token) || matchesReturTokenBoundary(rawReturnDocumentNumber, token) || exactishAny(norm)) score += 140;
                }
            });

            parsedRef.codeTokens.forEach((token) => {
                const norm = normalizeLookupText(token);
                const tokenBoundaryHit =
                    matchesReturTokenBoundary(rawDesc, token) ||
                    matchesReturTokenBoundary(rawNumber, token) ||
                    matchesReturTokenBoundary(rawKeywords, token) ||
                    matchesReturTokenBoundary(rawReturnDocumentNumber, token) ||
                    matchesReturTokenBoundary(rawDocumentCode, token);

                if (tokenBoundaryHit) {
                     score += 140;
                     if (exactishAny(norm) || matchesReturTokenBoundary(rawNumber, token) || matchesReturTokenBoundary(rawReturnDocumentNumber, token)) score += 120;
                } else if (!isAyatSilangRef && matchesAny(norm)) {
                     score += 90;
                     if (exactishAny(norm)) score += 90;
                }
            });

            if (!isAyatSilangRef) {
                if (cleanCust.includes(apiCust) || apiCust.includes(cleanCust)) score += 40;
                if (expChar && apiCharField1 && expChar !== apiCharField1) score -= 25;
            }

            return score;
        };

        // sheet_to_json mengabaikan kolom kosong, jadi detector format harus toleran jika `Total.Trx` tidak ikut terbaca.
        const isFormatPelunasan = cleanedData.length > 0 && cleanedData.some((r: any) => {
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

        if (isFormatPelunasan) {
            toast.loading("Membedah Format Pelunasan Internal...", { id: "parse" });
            
            const returMap = new Map<string, any>(); 
            const returQueries = new Map<string, { desc: string, invNos: Set<string>, sourceCustomerNo: string, isAyatSilang: boolean }>();
            const invoiceNos = new Set<string>();
            
            cleanedData.forEach((r: any) => {
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

            const invoiceBranchMap = new Map<string, any>();
            const invoiceLookupDebugMap = new Map<string, any>();
            
            if (returQueries.size > 0 && isKeySaved) {
                toast.loading(`Mencari ${returQueries.size} referensi Retur Penjualan...`, { id: "parse" });
                try {
                    for (const [compositeKey, meta] of returQueries.entries()) {
                        try {
                            const custNo = meta.sourceCustomerNo || "";
                            const xrayLogs: string[] = [];
                            let ret: any = null;
                            const matchedReturns: any[] = [];
                            const parsedRef = parseReturReference(meta.desc);
                            const acceptScore = (parsedRef.srtTokens.length > 0 || parsedRef.fullDocTokens.length > 0 || parsedRef.codeTokens.length > 0) ? 90 : 120;
                            xrayLogs.push(`Parsed_SRT:[${parsedRef.srtTokens.join('|') || '-'}]`);
                            xrayLogs.push(`Parsed_FULLDOC:[${parsedRef.fullDocTokens.slice(0, 12).join('|') || '-'}]`);
                            xrayLogs.push(`Parsed_CODE:[${parsedRef.codeTokens.slice(0, 8).join('|') || '-'}]`);
                            xrayLogs.push(`AcceptScore:${acceptScore}`);
                             
                            let expectedCharField1 = "";
                            if (!meta.isAyatSilang && meta.invNos && meta.invNos.size > 0) {
                                for (const inv of Array.from(meta.invNos)) {
                                    if (invoiceBranchMap.has(inv)) {
                                        expectedCharField1 = invoiceBranchMap.get(inv).charField1 || "";
                                        if (expectedCharField1) break;
                                    }
                                }
                            }

                            const tryFindRetur = async (keyword: string, label: string) => {
                                if (ret && !meta.isAyatSilang) return;
                                if (!keyword) return;
                                const safeSearchFetch = async (payload: any, variantLabel: string) => {
                                    try {
                                        return await accurateFetch('/api/sales-return/list.do', 'GET', payload);
                                    } catch (err) {
                                        const msg = err instanceof Error ? err.message : String(err);
                                        xrayLogs.push(`${label}_${variantLabel}_ERR:${msg.substring(0, 180)}`);
                                        return null;
                                    }
                                };

                                if (meta.isAyatSilang) {
                                    const exactMatches = await fetchReturByDocument(keyword, label, xrayLogs);
                                    if (exactMatches.length === 0) return;
                                    exactMatches.forEach((item: any) => {
                                        if (!matchedReturns.some((existing: any) => existing.number === item.number)) {
                                            matchedReturns.push(item);
                                        }
                                    });
                                    if (!ret) ret = exactMatches[0];
                                    return;
                                }
                                
                                let res = null;
                                const isFullReturnNumber = /^[A-Z]+\/\d{4}\/[A-Z0-9.]+$/i.test(keyword) || /^SRT[.\-/]/i.test(keyword);
                                const keywordVariants = buildReturSearchVariants(keyword);
                                xrayLogs.push(`${label}_${keyword}_Variants:[${keywordVariants.join('|')}]`);

                                for (const variant of keywordVariants) {
                                    if (res && res.d && res.d.length > 0) break;
                                    if (isFullReturnNumber) {
                                        // Untuk full No. Dokumen seperti RJN/2507/RC0050 atau SRT...., cari di field number dulu.
                                        res = await safeSearchFetch({
                                            fields: SALES_RETURN_SEARCH_FIELDS,
                                            "filter.number.op": "EQUAL",
                                            "filter.number.val": variant,
                                            "sp.pageSize": 100
                                        }, `${keyword}_EQUAL_${variant}`);
                                    }
                                }

                                if (!(res && res.d && res.d.length > 0)) {
                                    for (const variant of keywordVariants) {
                                        if (res && res.d && res.d.length > 0) break;
                                        if (isFullReturnNumber) {
                                            // Fallback ringan untuk nomor retur final yang mungkin punya variasi penulisan.
                                            res = await safeSearchFetch({
                                                fields: SALES_RETURN_SEARCH_FIELDS,
                                                "filter.number.op": "CONTAIN",
                                                "filter.number.val": variant,
                                                "sp.pageSize": 100
                                            }, `${keyword}_CONTAINNUM_${variant}`);
                                        } else {
                                            // No. Dokumen pecahan ayat silang / SRB lebih sering muncul di keywords / returnDocumentNumber.
                                            res = await safeSearchFetch({
                                                fields: SALES_RETURN_SEARCH_FIELDS,
                                                "filter.keywords.op": "CONTAIN",
                                                "filter.keywords.val": variant,
                                                "sp.pageSize": 100
                                            }, `${keyword}_KEYWORDS_${variant}`);
                                            if (!(res && res.d && res.d.length > 0)) {
                                                res = await safeSearchFetch({
                                                    fields: SALES_RETURN_SEARCH_FIELDS,
                                                    "filter.returnDocumentNumber.op": "CONTAIN",
                                                    "filter.returnDocumentNumber.val": variant,
                                                    "sp.pageSize": 100
                                                }, `${keyword}_RETURDOC_${variant}`);
                                            }
                                            if (!(res && res.d && res.d.length > 0)) {
                                                res = await safeSearchFetch({
                                                    fields: SALES_RETURN_SEARCH_FIELDS,
                                                    "filter.number.op": "CONTAIN",
                                                    "filter.number.val": variant,
                                                    "sp.pageSize": 100
                                                }, `${keyword}_NUM_${variant}`);
                                            }
                                        }
                                    }
                                }

                                if (!(res && res.d && res.d.length > 0)) {
                                    // Fallback global Accurate.
                                    for (const variant of keywordVariants) {
                                        if (res && res.d && res.d.length > 0) break;
                                        res = await safeSearchFetch({
                                             fields: SALES_RETURN_SEARCH_FIELDS,
                                             "keyword": variant,
                                             "sp.pageSize": 100
                                        }, `${keyword}_KW_${variant}`);
                                    }
                                }

                                if (!(res && res.d && res.d.length > 0)) {
                                    xrayLogs.push(`${label}_${keyword}_NoRes`);
                                    return;
                                }

                                const ranked = res.d
                                    .map((item: any) => ({ item, score: scoreReturCandidate(item, custNo, expectedCharField1, parsedRef) }))
                                    .sort((a: any, b: any) => b.score - a.score);

                                xrayLogs.push(`${label}_${keyword}_Len:${res.d.length}_Best:${ranked[0]?.score || 0}`);
                                xrayLogs.push(`${label}_${keyword}_Top:[${ranked.slice(0, 3).map((r: any) => `${r.item.number}:${r.score}:${r.item.customer?.customerNo || r.item.customer?.no || '-'}`).join('|')}]`);
                                ranked.forEach((r: any) => {
                                    if (r.score >= acceptScore && !matchedReturns.some((existing: any) => existing.number === r.item.number)) {
                                        matchedReturns.push(r.item);
                                    }
                                });
                                if (matchedReturns.length > 0 && !ret) ret = matchedReturns[0];
                            };

                            for (const keyword of parsedRef.srtTokens) {
                                await tryFindRetur(keyword, "Step1_SRT");
                                if (ret && !meta.isAyatSilang) break;
                            }

                            for (const keyword of parsedRef.fullDocTokens) {
                                await tryFindRetur(keyword, "Step2_FULLDOC");
                                if (ret && !meta.isAyatSilang) break;
                            }

                            const codeTokensToSearch = meta.isAyatSilang && (parsedRef.srtTokens.length > 0 || parsedRef.fullDocTokens.length > 0)
                                ? []
                                : parsedRef.codeTokens;
                            for (const keyword of codeTokensToSearch) {
                                await tryFindRetur(keyword, "Step3_CODE");
                                if (ret && !meta.isAyatSilang) break;
                            }
                                 
                            if (!ret && !meta.isAyatSilang && meta.invNos.size > 0) {
                                 for (const inv of Array.from(meta.invNos)) {
                                     const invTokens = inv.split('/');
                                     const pureInv = invTokens.pop() || inv.replace(/[^a-zA-Z0-9]/g, '');
                                     
                                     const fbRes = await accurateFetch('/api/sales-return/list.do', 'GET', {
                                         fields: SALES_RETURN_SEARCH_FIELDS,
                                         "keyword": pureInv,
                                         "sp.pageSize": 100
                                     });
                                     if (fbRes && fbRes.d && fbRes.d.length > 0) {
                                          xrayLogs.push(`Step4_InvKey_${pureInv}_Len:${fbRes.d.length} | FirstDsc:[${fbRes.d[0]?.description}]`);
                                          const ranked = fbRes.d
                                              .map((item: any) => ({ item, score: scoreReturCandidate(item, custNo, expectedCharField1, parsedRef) }))
                                              .sort((a: any, b: any) => b.score - a.score);
                                          if (ranked.length > 0 && ranked[0].score > 0) {
                                              ret = ranked[0].item;
                                          }
                                      } else {
                                          xrayLogs.push(`Step4_InvKey_${pureInv}_NoRes`);
                                      }
                                  }
                              }
                            if (!ret && !meta.isAyatSilang) {
                                 const cleanCust = custNo.split('-').slice(0, 2).join('-');
                                 let allReturns: any[] = [];
                                 let currentPage = 1;
                                 let hasMore = true;
                                 let sanityTimeout = 0;
                                 
                                 while (hasMore && sanityTimeout < 4) {
                                     sanityTimeout++;
                                     let fallbackRes = await accurateFetch('/api/sales-return/list.do', 'GET', {
                                          fields: SALES_RETURN_SEARCH_FIELDS,
                                          "keyword": cleanCust,
                                          "sp.pageSize": 100,
                                          "sp.page": currentPage
                                     });
                                     
                                     if (fallbackRes && fallbackRes.d && fallbackRes.d.length > 0) {
                                         allReturns.push(...fallbackRes.d);
                                         if (fallbackRes.sp && fallbackRes.sp.pageCount > currentPage) {
                                             currentPage++;
                                         } else {
                                             hasMore = false;
                                         }
                                     } else {
                                         hasMore = false;
                                     }
                                 }
                                 
                                  if (allReturns.length === 0) {
                                       xrayLogs.push(`Step5_Omni_Fail`);
                                  } else {
                                       xrayLogs.push(`Step5_Omni_Total:${allReturns.length}`);
                                       const ranked = allReturns
                                            .map((item: any) => ({ item, score: scoreReturCandidate(item, custNo, expectedCharField1, parsedRef) }))
                                            .sort((a: any, b: any) => b.score - a.score);
                                       if (ranked.length > 0 && ranked[0].score > 0) {
                                            ret = ranked[0].item;
                                        }
                                  }
                            }

                            if (ret && matchedReturns.length === 0) {
                                 matchedReturns.push(ret);
                            }

                            if (matchedReturns.length > 0) {
                                const finalizedReturns = meta.isAyatSilang ? await enrichReturDetails(matchedReturns, xrayLogs) : matchedReturns;
                                const totalOutstanding = finalizedReturns.reduce((sum, item) => sum + (item.primeOwing || 0), 0);
                                returMap.set(compositeKey, { 
                                    isArray: true,
                                    returns: finalizedReturns,
                                    outstanding: totalOutstanding,
                                    number: finalizedReturns[0].number,
                                    customerNo: finalizedReturns[0].customer?.customerNo || finalizedReturns[0].customer?.no,
                                    branchName: finalizedReturns[0].branch?.name,
                                    branchId: finalizedReturns[0].branch?.id,
                                    DEBUG_RAW: `FOUND ${finalizedReturns.length} RETURNS [${finalizedReturns.map((item: any) => item.number).join('|')}] - OUT: ${totalOutstanding} | Logs: ${xrayLogs.join(';')}`
                                });
                            } else {
                                returMap.set(compositeKey, {
                                    number: "NOT_FOUND",
                                    customerNo: custNo,
                                    outstanding: 0,
                                    DEBUG_RAW: `NOT_FOUND | Logs: ${xrayLogs.join(';')}`
                                });
                            }
                        } catch(innerErr) {
                             console.error(`Error processing return query ${compositeKey}:`, innerErr);
                             returMap.set(compositeKey, {
                                 number: "NOT_FOUND",
                                 customerNo: meta.sourceCustomerNo,
                                 outstanding: 0,
                                 DEBUG_RAW: `ERROR: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`
                             });
                        }
                    }
                } catch (e) {
                    toast.error("Gagal menarik data Retur Penjualan", { id: "parse" });
                }
            }
            
            if (invoiceNos.size > 0 && isKeySaved) {
                toast.loading(`Menarik data Cabang dari ${invoiceNos.size} tagihan Invoice...`, { id: "parse" });
                try {
                    const invArray = Array.from(invoiceNos);
                    // Gunakan Promise.all dengan pencarian individual per nama invoice
                    const invPromises = invArray.map(async (invNo) => {
                        const cleanInvNo = invNo.trim();
                        try {
                            let invObj = null;
                            let lookupSource = "NONE";
                            const matchFn = (i:any) => {
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
                                invObj = exactRes.d.find((item: any) => String(item.number || "").trim().toUpperCase() === cleanInvNo.toUpperCase()) || exactRes.d[0];
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
                                        || tailRes.d.find((item: any) => String(item.number || "").toUpperCase().includes(invTailToken.toUpperCase()));
                                      if (invObj) lookupSource = "NUMBER_CONTAIN_TAIL";
                                 }
                            }
                                
                            if (invObj) {
                                invoiceBranchMap.set(cleanInvNo, {
                                    invoiceNo: invObj.number || cleanInvNo,
                                    branchId: invObj.branch?.id,
                                    branchName: invObj.branch?.name,
                                    outstanding: invObj.primeOwing,
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
                        } catch (e: any) {
                             invoiceLookupDebugMap.set(cleanInvNo, {
                                 found: false,
                                 lookupSource: "ERROR",
                                 matchedInvoiceNo: "",
                                 branchName: "",
                                 primeOwing: null,
                                 error: e?.message || String(e)
                             });
                        }
                    });
                    
                    await Promise.all(invPromises);
                } catch(e) {
                    console.error("Gagal menarik data cabang invoice", e);
                }
            }

            const groupedMap = new Map();
            const ayatSilangDocs: any[] = [];
            const unresolvedReturWarnings: Array<{
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
            }> = [];
            const unresolvedReturKeys = new Set<string>();

            cleanedData.forEach((row: any) => {
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
                         const matchedRet = returMap.get(retKey);
                         if (!customerNo) customerNo = matchedRet.customerNo;
                         if (!branchName) branchName = matchedRet.branchName;
                         if (!branchId) branchId = matchedRet.branchId;
                     }
                }

                if (rjsDesc) {
                     const retKey = buildReturLookupKey(rawOutlet.trim(), rjsDesc.trim());
                     if (returMap.has(retKey)) {
                         const matchedRet = returMap.get(retKey);
                         if (!customerNo) customerNo = matchedRet.customerNo;
                         if (!branchName) branchName = matchedRet.branchName;
                         if (!branchId) branchId = matchedRet.branchId;
                     }
                }
                // Tarik branchId dari Invoice master jika murni Tunai/Transfer/BG
                const invNoForBranch = getTextVal(row, "No. Nota");
                if (invNoForBranch && invoiceBranchMap.has(invNoForBranch) && !branchId) {
                     const ib = invoiceBranchMap.get(invNoForBranch);
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
                     let potLain = Number(getVal(row, "Pot. Lain")) || 0;
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
                let potTB = Number(getVal(row, "Pot.DiscTB")) || 0;
                let biayaBg = Number(getVal(row, "BiayaTrf/BG")) || 0;

                // HEALING DISKON & RETUR
                const invNoForHeal = getTextVal(row, "No. Nota");
                if (invNoForHeal && invoiceBranchMap.has(invNoForHeal)) {
                     const out = invoiceBranchMap.get(invNoForHeal).outstanding;
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
                         const out = returMap.get(rKey).outstanding;
                         if (typeof out === 'number' && Math.abs(srbAmt - Math.abs(out)) <= TOLERANSI_SELISIH) srbAmt = Math.abs(out);
                     }
                }
                const rjst = getTextVal(row, "No.RJS RT Gt");
                if (rjsAmt > 0 && rjst) {
                     const rKey = buildReturLookupKey(customerNo.trim(), rjst.trim());
                     if (returMap.has(rKey)) {
                         const out = returMap.get(rKey).outstanding;
                         if (typeof out === 'number' && Math.abs(rjsAmt - Math.abs(out)) <= TOLERANSI_SELISIH) rjsAmt = Math.abs(out);
                     }
                }
                
                const hasReturAtauDiskon = srbAmt > 0 || rjsAmt > 0 || pot1 > 0 || pot2 > 0 || pot3 > 0 || potTB > 0 || biayaBg > 0;

                // 3. Tentukan tipe pembayaran yang ada di row ini
                let payments = [];
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
                        const newSrObj: any = {
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
                        const dtInv: any = {
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
                        const totalDisc = dtInv.detailDiscount.reduce((sum: number, d: any) => sum + d.amount, 0);

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
                        let srbKey = "";
                        let accurateSrbOutstanding: number | undefined = undefined;
                        let accurateSrbNumber: string | undefined = undefined;
                        let unresolvedSrbAmt = 0;
                        if (srbAmt > 0 && srbDesc) {
                            srbKey = buildReturLookupKey(customerNo.trim(), srbDesc.trim());
                            if (returMap.has(srbKey)) {
                                const retData = returMap.get(srbKey);
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
                        let rjsKey = "";
                        let accurateRjsOutstanding: number | undefined = undefined;
                        let accurateRjsNumber: string | undefined = undefined;
                        let unresolvedRjsAmt = 0;
                        if (rjsAmt > 0 && rjsDesc) {
                            rjsKey = buildReturLookupKey(customerNo.trim(), rjsDesc.trim());
                            if (returMap.has(rjsKey)) {
                                const retData = returMap.get(rjsKey);
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
                        let usedDisc = 0, usedSrb = 0, usedRjs = 0, usedCash = 0;

                        if (isLargest) {
                            usedDisc = Math.min(totalDisc, owed);
                            owed -= usedDisc;

                            usedSrb = Math.min(availSrb, owed);
                            owed -= usedSrb;

                            usedRjs = Math.min(availRjs, owed);
                            owed -= usedRjs;
                            
                            (row as any)._mutatedSrb = usedSrb;
                            (row as any)._mutatedRjs = usedRjs;
                        }

                        const remainingBeforeCash = owed;
                        // Khusus alokasi Kas Fisik dari line ini
                        usedCash = Math.min(pmt.amt, owed);
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
                            for (let d of dtInv.detailDiscount) {
                                if (leftover <= 0) { d.amount = 0; continue; }
                                if (d.amount > leftover) { d.amount = leftover; leftover = 0; }
                                else { leftover -= d.amount; }
                            }
                            dtInv.detailDiscount = dtInv.detailDiscount.filter((d: any) => d.amount > 0);
                        }

                        if (dtInv.detailDiscount && dtInv.detailDiscount.length === 0) delete dtInv.detailDiscount;

                        if (dtInv.paymentAmount <= 0 && !dtInv.detailDiscount && (unresolvedSrbAmt > 0 || unresolvedRjsAmt > 0)) {
                            return;
                        }
                        
                        // Accurate API REQUIRES paymentAmount to exist, even if it is 0 (for full discount settlements).
                        // Do not delete dtInv.paymentAmount.

                        // Push ke payload bila ada nilai pembayaran (atau pembayaran 0 tapi terbayar lunas via diskon)
                        if (dtInv.paymentAmount > 0 || dtInv.detailDiscount) {
                            const existingDtInv = sr.detailInvoice.find((d: any) => d.invoiceNo === dtInv.invoiceNo);
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
                                invoiceBranchMap.get(invNo.trim()).outstanding -= dtInv.paymentAmount;
                            }
                        }
                    }
                    
                    // JIKA INI PAYMENT TERBESAR, PISAHKAN FAKTUR RETUR MENJADI DOKUMEN AYAT SILANG!
                    if (isLargest) {
                        let finalSrb = (row as any)._mutatedSrb !== undefined ? (row as any)._mutatedSrb : srbAmt;
                        let finalRjs = (row as any)._mutatedRjs !== undefined ? (row as any)._mutatedRjs : rjsAmt;

                        const processAyatSilang = (desc: string, finalAmt: number) => {
                            if (!desc || finalAmt <= 0) return;
                            const key = buildReturLookupKey(customerNo.trim(), desc.trim());
                            if (!returMap.has(key)) return;
                            
                            const matchedRetObj = returMap.get(key);
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

            let finalData = Array.from(groupedMap.values());
            finalData.push(...ayatSilangDocs);
            finalData = finalData.filter((sr: any) => sr.detailInvoice && sr.detailInvoice.length > 0);
            finalData.forEach((sr: any) => {
                 if (!sr.typeAutoNumber || sr.typeAutoNumber.trim() === "") delete sr.typeAutoNumber;
                 
                 // Rapikan noise floating-point tanpa memotong selisih riil < Rp 1 yang masih penting untuk pelunasan.
                 sr.chequeAmount = normalizePayloadMoney(sr.chequeAmount);
                 sr.detailInvoice.forEach((dt: any) => {
                      if (dt.paymentAmount) dt.paymentAmount = normalizePayloadMoney(dt.paymentAmount);
                      if (dt.detailDiscount) {
                           dt.detailDiscount.forEach((dd: any) => {
                                if (dd.amount) dd.amount = normalizePayloadMoney(dd.amount);
                           });
                      }
                 });
            });
            cleanedData = finalData;
            if (unresolvedReturWarnings.length > 0) {
                const sample = unresolvedReturWarnings
                    .slice(0, 3)
                    .map((item) => `${item.invoiceNo} [${item.refs.join(" | ")}]`)
                    .join(", ");
                toast.warning(`${unresolvedReturWarnings.length} baris retur yang belum ditemukan di Accurate dilewati sementara. Contoh: ${sample}`);
                setTimeout(() => {
                    try {
                        const manualRows = unresolvedReturWarnings.map((item) => ({
                            "Invoice No": item.invoiceNo,
                            "Code Outlet": item.customerNo,
                            "Referensi Retur/Pot.Lain": item.refs.join(" | "),
                            "Nominal SRB Belum Diproses": item.unresolvedSrbAmt,
                            "Nominal RJS Belum Diproses": item.unresolvedRjsAmt,
                            "Tunai Tetap Diproses": item.tunaiAmt,
                            "Transfer Tetap Diproses": item.trfAmt,
                            "BG Tetap Diproses": item.bgAmt,
                            "Biaya Tetap Diproses": item.biayaBg,
                            "Ket. All Trx": item.ketAllTrx,
                            "Aksi Manual": "Retur/Pot.Lain perlu diproses manual di Accurate"
                        }));
                        const wsManual = XLSX.utils.json_to_sheet(manualRows);
                        const wbManual = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(wbManual, wsManual, "Retur Manual");
                        XLSX.writeFile(wbManual, `Retur_PotLain_Manual_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
                    } catch (manualErr) {
                        console.error("Gagal membuat laporan retur manual", manualErr);
                    }
                }, 800);
            }
            
            toast.success(`Format Pelunasan dikonversi menjadi ${cleanedData.length} Sales Receipt.`, { id: "parse" });
            setPayloadStr(JSON.stringify(cleanedData, null, 2));
            setInputMode("manual");
            e.target.value = '';
            return;
        }
        // ---- akhir VERBATIM W:275-1629
    };
    await jalan();
    return keluaran;
}

// ---- VERBATIM W:30-45
type DuplicateConflictReason = "DUPLICATE_IN_UPLOAD" | "ALREADY_SUCCESS" | "STILL_PROCESSING" | "UNKNOWN_OUTCOME" | "ACCURATE_HISTORY";

type DuplicateReviewEntry = {
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
// ---- akhir VERBATIM W:30-45

export async function jalankanPratinjauLama(rows: any[], routeKey: string, opsi: {
    blockedEntries: any[];
    accurateFetch: (path: string, method: string, payload?: unknown) => Promise<any>;
}) {
    type RouteKey = string;
    const { accurateFetch } = opsi;
    const fetch = async (_url: string, _init: any) => ({ ok: true, json: async () => ({ blockedEntries: opsi.blockedEntries }) });

    // ---- VERBATIM W:1903-2053
  const previewAccurateSalesReceiptHistory = async (rows: any[]) => {
    const rowKeys = rows.map((row: any) => buildSalesReceiptIdempotencyPayload(row));
    const targetKeys = new Set(rowKeys.map((item) => item.key));
    const groupedTargets = new Map<string, { customerNo: string; transDate: string; keys: Set<string> }>();

    rowKeys.forEach((item) => {
      const groupKey = `${item.customerNo}|${item.transDate}`;
      if (!groupedTargets.has(groupKey)) {
        groupedTargets.set(groupKey, {
          customerNo: item.customerNo,
          transDate: item.transDate,
          keys: new Set<string>()
        });
      }
      groupedTargets.get(groupKey)!.keys.add(item.key);
    });

    const matchedReceiptsByKey = new Map<string, string[]>();

    try {
      for (const group of groupedTargets.values()) {
        let currentPage = 1;
        let pageCount = 1;
        const candidateReceipts: any[] = [];

        do {
          const listRes = await accurateFetch('/api/sales-receipt/list.do', 'GET', {
            fields: "id,number,customer,branch,transDate,chequeAmount,paymentMethod,description",
            "filter.customerNo": group.customerNo,
            "filter.transDate.op": "EQUAL",
            "filter.transDate.val": group.transDate,
            "sp.pageSize": 100,
            "sp.page": currentPage
          });

          const pageRows = Array.isArray(listRes?.d) ? listRes.d : [];
          candidateReceipts.push(...pageRows);
          pageCount = Number(listRes?.sp?.pageCount || currentPage || 1);
          currentPage += 1;
        } while (currentPage <= pageCount && currentPage <= 5 && candidateReceipts.length < 300);

        for (const candidate of candidateReceipts) {
          try {
            const detailRes = await accurateFetch('/api/sales-receipt/detail.do', 'GET', candidate?.id ? { id: candidate.id } : { number: candidate.number });
            const detail = detailRes?.d || detailRes;
            if (!detail) continue;

            const detailPayload = {
              customerNo: detail.customerNo || detail.customer?.customerNo || group.customerNo,
              transDate: detail.transDate || group.transDate,
              paymentMethod: detail.paymentMethod || "",
              chequeAmount: detail.chequeAmount || 0,
              detailInvoice: Array.isArray(detail.detailInvoice) ? detail.detailInvoice : []
            };

            const detailKey = buildSalesReceiptIdempotencyPayload(detailPayload).key;
            if (!targetKeys.has(detailKey) || !group.keys.has(detailKey)) continue;

            if (!matchedReceiptsByKey.has(detailKey)) matchedReceiptsByKey.set(detailKey, []);
            const targetList = matchedReceiptsByKey.get(detailKey)!;
            const receiptNumber = String(detail.number || candidate.number || "").trim();
            if (receiptNumber && !targetList.includes(receiptNumber)) {
              targetList.push(receiptNumber);
            }
          } catch (detailErr) {
            console.error("Accurate history preview detail error:", detailErr);
          }
        }
      }
    } catch (historyErr) {
      console.error("Accurate history preview skipped:", historyErr);
    }

    return matchedReceiptsByKey;
  };

  const previewSalesReceiptDuplicates = async (rows: any[], routeKey: RouteKey) => {
    const keysPayload = rows.map((row: any) => buildSalesReceiptIdempotencyPayload(row));
    const uploadDuplicateIndexes = new Map<string, number[]>();
    keysPayload.forEach((item, index) => {
      if (!uploadDuplicateIndexes.has(item.key)) uploadDuplicateIndexes.set(item.key, []);
      uploadDuplicateIndexes.get(item.key)!.push(index);
    });

    const previewRes = await fetch('/api/idempotency/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: keysPayload, preview: true })
    });
    const previewData = await previewRes.json();
    if (!previewRes.ok) throw new Error(previewData.error || "Gagal membaca kandidat duplikat.");
    const accurateHistoryMap = await previewAccurateSalesReceiptHistory(rows);

    const blockedReasonMap = new Map<string, DuplicateConflictReason[]>();
    (previewData.blockedEntries || []).forEach((entry: any) => {
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

    const passthroughRows: Array<{ originalIndex: number; row: any }> = [];
    const reviewRows: DuplicateReviewEntry[] = [];
    const selections: Record<string, boolean> = {};

    rows.forEach((row: any, index: number) => {
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
    // ---- akhir VERBATIM W:1903-2053

    return previewSalesReceiptDuplicates(rows, routeKey);
}
