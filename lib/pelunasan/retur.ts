/**
 * Tujuan: pencarian & penilaian Retur Penjualan / dokumen Ayat Silang untuk Pelunasan — dipindah UTUH dari W:294-598
 *   (helper + skor kandidat) dan W:667-926 (loop pencarian) `app/(dashboard)/api-wrapper/page.tsx` basis 5d6cc936 (S6e-1).
 *   Perilaku dikunci golden lib/pelunasan/uji/golden.json.
 * Caller: lib/pelunasan/parser.ts (parsePelunasan).
 * Main Functions: parseReturReference, buildReturLookupKey, buildReturSearchVariants, returDocumentMatches,
 *   scoreReturCandidate, cariRetur.
 * Side Effects: GET Accurate lewat `accurateFetch` yang DIINJEKSI (sales-return/list.do, sales-invoice/list.do & detail.do);
 *   memutasi `returMap` milik pemanggil; console.error per kueri yang galat (sama dengan kode lama).
 */
import { getTextVal, type Bebas } from "./sel.ts";

export type AccurateFetch = (path: string, method: string, payload?: unknown) => Promise<Bebas>;

export type KueriRetur = { desc: string, invNos: Set<string>, sourceCustomerNo: string, isAyatSilang: boolean };

export const normalizeLookupText = (value: string) => value.toUpperCase().replace(/[\s.,-]+/g, "");
export const matchesReturTokenBoundary = (rawValue: string, token: string) => {
    if (!rawValue || !token) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, "i").test(rawValue);
};

export const parseReturReference = (rawDesc: string) => {
    // "RJN2607/VI00015, …" (salah tulis admin, bukti P.27-11-2026 INV/2607/RB00025) = "RJN/2607/VI00015, …"; dulu periode hilang dan
    // nomor-nomor itu tidak pernah dicari.
    const desc = getTextVal({ value: rawDesc }, "value").replace(/\bRJN(\d{4})\//gi, "RJN/$1/");
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
            // "…HZ00248,RJN/2606/HZ00008": potongan "RJN" = awal dokumen berikutnya, BUKAN nomor. Dulu jadi token "RJN/2605/RJN" yang
            // (lewat pencarian longgar) mencocokkan RJN terbaru pelanggan lain. Bukti P.27-11-2026: RJN/2611/M100748–M100750 terpakai di 6 faktur.
            if (/^(RJN|SRT)$/i.test(item)) return;

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

export const SALES_RETURN_SEARCH_FIELDS = "number,customer,branch,description,primeOwing,keywords,returnDocumentNumber,documentCode,charField1";
export const AYAT_SILANG_SEARCH_FIELDS = "number,customer,branch,description,primeOwing,keywords,charField1";
export const isAyatSilangReference = (desc: string) => {
    const normalized = String(desc || "").toUpperCase().trim();
    return normalized.includes("RJN/") || normalized.includes("/RJN/") || normalized.includes("SRT.");
};
export const buildReturLookupKey = (customerNo: string, desc: string) => {
    const cleanDesc = String(desc || "").trim();
    if (!cleanDesc) return "";
    if (isAyatSilangReference(cleanDesc)) return `DOC|${cleanDesc}`;
    return `${String(customerNo || "").trim()}|${cleanDesc}`;
};
export const buildReturSearchVariants = (documentNo: string) => {
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
const extractReturLookupTexts = (ret: Bebas) => {
    return [
        String(ret?.number || ""),
        String(ret?.keywords || ""),
        String(ret?.returnDocumentNumber || ""),
        String(ret?.documentCode || ""),
        String(ret?.description || ""),
    ].filter(Boolean);
};
export const returDocumentMatches = (ret: Bebas, documentNo: string) => {
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
const fetchReturByDocument = async (accurateFetch: AccurateFetch, documentNo: string, label: string, xrayLogs: string[]) => {
    const variants = buildReturSearchVariants(documentNo);
    const candidateMap = new Map<string, Bebas>();
    const safeSearchFetch = async (path: string, payload: Bebas, errLabel: string) => {
        try {
            return await accurateFetch(path, 'GET', payload);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            xrayLogs.push(`${errLabel}_ERR:${msg.substring(0, 180)}`);
            return null;
        }
    };

    // Nomor dokumen lengkap (RJN/2609/GD00062, SRT.2025.12.02413): cari TEPAT lewat filter.number. Bukti 25 Nov 2026: Accurate
    // MENGABAIKAN `keyword` bergaris miring di sales-invoice/list.do (jawaban = seluruh 282.992 faktur), jadi pindaian keyword di bawah
    // hanya menemukan retur yang kebetulan ada di 400 faktur terbaru. filter.number EQUAL memuat dokumen retur beserta primeOwing-nya.
    if (documentNo.includes("/") || /^SRT[.\-/]/i.test(documentNo)) {
        const exact = await safeSearchFetch('/api/sales-invoice/list.do', {
            fields: AYAT_SILANG_SEARCH_FIELDS,
            "filter.number.op": "EQUAL",
            "filter.number.val": documentNo.trim().toUpperCase(),
        }, `${label}_${documentNo}_EQUAL`);
        // Hanya dokumen yang nomornya PERSIS nomor yang dicari. Tidak ketemu = tidak ada di Accurate → retur manual. Dulu jatuh ke pindaian
        // keyword di bawah: keyword bergaris miring diabaikan Accurate (jawaban = faktur/RJN terbaru), lalu varian ekor ("RJN", "HZ00187")
        // dicocokkan longgar → RJN pelanggan lain, bahkan faktur biasa, bisa terpakai sebagai retur (bukti P.27-11-2026, 28 Nov).
        const hit = (Array.isArray(exact?.d) ? exact.d : [])
            .filter((item: Bebas) => normalizeLookupText(String(item?.number ?? "")) === normalizeLookupText(documentNo));
        xrayLogs.push(`${label}_${documentNo}_Equal:[${hit.map((item: Bebas) => item.number).join('|') || '-'}]`);
        return hit;
    }

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
            rows.forEach((item: Bebas) => {
                const key = String(item?.number || `${variant}|${candidateMap.size}`);
                if (!candidateMap.has(key)) candidateMap.set(key, item);
            });

            pageCount = Number(res?.sp?.pageCount || currentPage || 1);
            currentPage += 1;
        } while (currentPage <= pageCount && currentPage <= 4 && candidateMap.size < 200);

        xrayLogs.push(`${label}_${variant}_KeywordPool:${candidateMap.size}_Scanned:${scanned}`);
    }

    const exactMatches = Array.from(candidateMap.values()).filter((item) => returDocumentMatches(item, documentNo));
    xrayLogs.push(`${label}_${documentNo}_Exact:[${exactMatches.map((item: Bebas) => item.number).join('|') || '-'}]`);
    return exactMatches;
};
const enrichReturDetails = async (accurateFetch: AccurateFetch, returns: Bebas[], xrayLogs: string[]) => {
    const enriched: Bebas[] = [];
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

/**
 * Jalur SRB: dokumen dari `sales-return/list.do` TIDAK membawa primeOwing (bukti 28 Nov 2026, RJN/2611/AB00216), sehingga sisaDok = 0 dan
 * setiap retur SRB jatuh ke retur manual. Sisa yang benar ada di dokumen RJN yang sama di `sales-invoice/list.do` (primeOwing NEGATIF =
 * Belum Lunas). Hanya dokumen tanpa primeOwing yang dibaca ulang; nomor tak ketemu = tetap tanpa sisa (retur manual, seperti dulu).
 */
const sisaDariDokumenRjn = async (accurateFetch: AccurateFetch, returns: Bebas[], xrayLogs: string[]) => {
    const hasil: Bebas[] = [];
    for (const retItem of returns) {
        const nomor = String(retItem?.number || "").trim();
        if (retItem?.primeOwing != null || !nomor) { hasil.push(retItem); continue; }
        try {
            const res = await accurateFetch('/api/sales-invoice/list.do', 'GET', {
                fields: AYAT_SILANG_SEARCH_FIELDS, "filter.number.op": "EQUAL", "filter.number.val": nomor,
            });
            // Hanya dokumen retur: RJN Belum Lunas bersisa NEGATIF (0 = terpakai). Sisa positif = faktur biasa → tidak dipakai sebagai retur.
            const dok = (Array.isArray(res?.d) ? res.d : []).find((x: Bebas) => normalizeLookupText(String(x?.number ?? "")) === normalizeLookupText(nomor)
                && Number(x?.primeOwing) <= 0);
            xrayLogs.push(`SisaRJN_${nomor}:${dok ? dok.primeOwing : "-"}`);
            hasil.push(dok ? { ...retItem, primeOwing: dok.primeOwing } : retItem);
        } catch (err) {
            xrayLogs.push(`SisaRJN_${nomor}_ERR:${(err instanceof Error ? err.message : String(err)).substring(0, 120)}`);
            hasil.push(retItem);
        }
    }
    return hasil;
};

/**
 * Skor kandidat retur (W:517-598, apa adanya). CATATAN S6e-1 (dibuktikan uji, TIDAK diubah):
 * - `isAyatSilangRef` di sini = "referensi punya token apa pun" — benar untuk SETIAP referensi tak-kosong yang wajar
 *   (kode tanpa garis miring pun menjadi codeTokens). Jadi blok pelanggan/charField1 (+40/+25/+40/-25) praktis TIDAK
 *   PERNAH jalan, begitu pula cabang `matchesAny` (+90): kandidat hanya lolos bila token mentah menempel di batas kata.
 * - `expectedCharField1` selalu "" dari cariRetur (lihat catatan di sana).
 */
export const scoreReturCandidate = (ret: Bebas, custNo: string, expectedCharField1: string, parsedRef: ReturnType<typeof parseReturReference>) => {
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
        // Berkas menulis "SRB 2653.57", Accurate menyimpan "…_SRB2653.57_…" (bukti 25 Nov 2026, RJN/2609/GD00062): bentuk rapat ikut dicocokkan.
        const rapat = token.replace(/\s+/g, "");
        const kenaBatas = (raw: string) => matchesReturTokenBoundary(raw, token) || (rapat !== token && matchesReturTokenBoundary(raw, rapat));
        const tokenBoundaryHit =
            kenaBatas(rawDesc) ||
            kenaBatas(rawNumber) ||
            kenaBatas(rawKeywords) ||
            kenaBatas(rawReturnDocumentNumber) ||
            kenaBatas(rawDocumentCode);

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

/**
 * Loop pencarian retur per kueri (W:670-922), mengisi `returMap` (kunci = buildReturLookupKey). Berurutan, satu kueri
 * satu per satu — seperti kode lama.
 *
 * `expectedCharField1` (W:683-691) di kode lama dibaca dari peta faktur yang BARU diisi SESUDAH loop ini (W:928+), jadi
 * selalu "". Di sini dibuat eksplisit "" — perilaku identik (dibuktikan uji "urutan: retur sebelum faktur").
 */
export async function cariRetur(returQueries: Map<string, KueriRetur>, returMap: Map<string, Bebas>, accurateFetch: AccurateFetch) {
    for (const [compositeKey, meta] of returQueries.entries()) {
        try {
            const custNo = meta.sourceCustomerNo || "";
            const xrayLogs: string[] = [];
            let ret: Bebas | null = null;
            const matchedReturns: Bebas[] = [];
            const parsedRef = parseReturReference(meta.desc);
            const acceptScore = (parsedRef.srtTokens.length > 0 || parsedRef.fullDocTokens.length > 0 || parsedRef.codeTokens.length > 0) ? 90 : 120;
            xrayLogs.push(`Parsed_SRT:[${parsedRef.srtTokens.join('|') || '-'}]`);
            xrayLogs.push(`Parsed_FULLDOC:[${parsedRef.fullDocTokens.slice(0, 12).join('|') || '-'}]`);
            xrayLogs.push(`Parsed_CODE:[${parsedRef.codeTokens.slice(0, 8).join('|') || '-'}]`);
            xrayLogs.push(`AcceptScore:${acceptScore}`);

            const expectedCharField1 = "";
            // Jalur SRB (retur pelanggan yang sama, bukan ayat silang): retur WAJIB milik pelanggan baris ini. Bukti 28 Nov 2026 (P.27-11-2026):
            // berkas menulis SRB2676.47 untuk INV/2609/AB00896 (SINAR ABADI C-SIN172), padahal SRB2676.47 = RJN/2611/AB00216 milik H.MAMING
            // (C-MAM075); retur AB00896 yang benar RJN/2611/AB00217 "INV/2609/AB00896_SRB2676.48_…".
            const samaPelanggan = (item: Bebas) => {
                const c = String(item?.customer?.customerNo || item?.customer?.no || "").toUpperCase().trim();
                const k = custNo.toUpperCase().trim();
                return Boolean(c && k) && (c === k || c.startsWith(`${k}-`));
            };
            // Keterangan RJN di Accurate berpola "<faktur>_<SRB>_input…": nomor faktur baris ini di keterangan = retur untuk faktur ini.
            const menyebutFaktur = (item: Bebas) => Array.from(meta.invNos).some((inv) => matchesReturTokenBoundary(String(item?.description || ""), inv.trim()));

            const tryFindRetur = async (keyword: string, label: string) => {
                if (ret && !meta.isAyatSilang) return;
                if (!keyword) return;
                const safeSearchFetch = async (payload: Bebas, variantLabel: string) => {
                    try {
                        const res = await accurateFetch('/api/sales-return/list.do', 'GET', payload);
                        // Bukti 25 Nov 2026: Accurate MENGABAIKAN filter.returnDocumentNumber / filter.number di sales-return/list.do dan
                        // menjawab retur terbaru acak. Jawaban itu tidak kosong, jadi varian berikutnya (mis. "SRB2667.57" tanpa spasi, yang
                        // ketemu lewat filter.keywords) tidak pernah dicoba → NOT_FOUND. Hanya baris yang memuat nilai yang dicari dihitung.
                        const dicari = normalizeLookupText(String(payload["filter.keywords.val"] ?? payload["filter.returnDocumentNumber.val"]
                            ?? payload["filter.number.val"] ?? payload.keyword ?? ""));
                        if (!dicari || !Array.isArray(res?.d)) return res;
                        return { ...res, d: res.d.filter((item: Bebas) => extractReturLookupTexts(item).some((t) => normalizeLookupText(t).includes(dicari))) };
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        xrayLogs.push(`${label}_${variantLabel}_ERR:${msg.substring(0, 180)}`);
                        return null;
                    }
                };

                if (meta.isAyatSilang) {
                    const exactMatches = await fetchReturByDocument(accurateFetch, keyword, label, xrayLogs);
                    if (exactMatches.length === 0) return;
                    exactMatches.forEach((item: Bebas) => {
                        if (!matchedReturns.some((existing: Bebas) => existing.number === item.number)) {
                            matchedReturns.push(item);
                        }
                    });
                    if (!ret) ret = exactMatches[0];
                    return;
                }

                let res: Bebas | null = null;
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
                    .map((item: Bebas) => ({ item, score: scoreReturCandidate(item, custNo, expectedCharField1, parsedRef) }))
                    .sort((a: Bebas, b: Bebas) => b.score - a.score);

                xrayLogs.push(`${label}_${keyword}_Len:${res.d.length}_Best:${ranked[0]?.score || 0}`);
                xrayLogs.push(`${label}_${keyword}_Top:[${ranked.slice(0, 3).map((r: Bebas) => `${r.item.number}:${r.score}:${r.item.customer?.customerNo || r.item.customer?.no || '-'}`).join('|')}]`);
                ranked.forEach((r: Bebas) => {
                    if (r.score >= acceptScore && samaPelanggan(r.item) && !matchedReturns.some((existing: Bebas) => existing.number === r.item.number)) {
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
                            .map((item: Bebas) => ({ item, score: scoreReturCandidate(item, custNo, expectedCharField1, parsedRef) }))
                            .sort((a: Bebas, b: Bebas) => b.score - a.score);
                        // Nomor faktur di keterangan (pelanggan sama) didahulukan: tetap ketemu walau nomor SRB di berkas salah tulis.
                        const pilih = ranked.find((r: Bebas) => samaPelanggan(r.item) && menyebutFaktur(r.item))
                            ?? ranked.find((r: Bebas) => r.score > 0 && samaPelanggan(r.item));
                        if (pilih) ret = pilih.item;
                    } else {
                        xrayLogs.push(`Step4_InvKey_${pureInv}_NoRes`);
                    }
                }
            }
            // Step4b: Accurate MENGABAIKAN `keyword` di sales-return/list.do (bukti 28 Nov 2026: jawaban = 44 rb retur terbaru, 444 halaman),
            // jadi Step4/Step5 tidak pernah menemukan apa pun di produksi. `filter.keywords CONTAIN <ekor faktur>` bekerja: retur pelanggan yang
            // sama yang keterangannya menyebut nomor faktur LENGKAP baris ini (mis. INV/2609/AB00896 → RJN/2611/AB00217) diterima.
            if (!ret && !meta.isAyatSilang && meta.invNos.size > 0) {
                for (const inv of Array.from(meta.invNos)) {
                    if (ret) break;
                    const ekor = inv.split('/').pop()?.trim() || "";
                    if (!ekor) continue;
                    try {
                        const res = await accurateFetch('/api/sales-return/list.do', 'GET', {
                            fields: SALES_RETURN_SEARCH_FIELDS, "filter.keywords.op": "CONTAIN", "filter.keywords.val": ekor, "sp.pageSize": 100,
                        });
                        const pilih = (Array.isArray(res?.d) ? res.d : []).find((item: Bebas) => samaPelanggan(item) && menyebutFaktur(item));
                        xrayLogs.push(`Step4b_${ekor}:${pilih?.number ?? "-"}`);
                        if (pilih) ret = pilih;
                    } catch (err) {
                        xrayLogs.push(`Step4b_${ekor}_ERR:${(err instanceof Error ? err.message : String(err)).substring(0, 120)}`);
                    }
                }
            }
            if (!ret && !meta.isAyatSilang) {
                const cleanCust = custNo.split('-').slice(0, 2).join('-');
                const allReturns: Bebas[] = [];
                let currentPage = 1;
                let hasMore = true;
                let sanityTimeout = 0;

                while (hasMore && sanityTimeout < 4) {
                    sanityTimeout++;
                    const fallbackRes = await accurateFetch('/api/sales-return/list.do', 'GET', {
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
                        .map((item: Bebas) => ({ item, score: scoreReturCandidate(item, custNo, expectedCharField1, parsedRef) }))
                        .sort((a: Bebas, b: Bebas) => b.score - a.score);
                    const pilih = ranked.find((r: Bebas) => samaPelanggan(r.item) && menyebutFaktur(r.item))
                        ?? ranked.find((r: Bebas) => r.score > 0 && samaPelanggan(r.item));
                    if (pilih) ret = pilih.item;
                }
            }

            if (ret && matchedReturns.length === 0) {
                matchedReturns.push(ret);
            }

            if (matchedReturns.length > 0) {
                const finalizedReturns = meta.isAyatSilang ? await enrichReturDetails(accurateFetch, matchedReturns, xrayLogs)
                    : await sisaDariDokumenRjn(accurateFetch, matchedReturns, xrayLogs);
                // RJN Belum Lunas = primeOwing NEGATIF di Accurate (27 Nov 2026): dijumlah besarnya, bukan saling meniadakan.
                const totalOutstanding = finalizedReturns.reduce((sum, item) => sum + Math.abs(Number(item.primeOwing) || 0), 0);
                returMap.set(compositeKey, {
                    isArray: true,
                    returns: finalizedReturns,
                    outstanding: totalOutstanding,
                    number: finalizedReturns[0].number,
                    customerNo: finalizedReturns[0].customer?.customerNo || finalizedReturns[0].customer?.no,
                    branchName: finalizedReturns[0].branch?.name,
                    branchId: finalizedReturns[0].branch?.id,
                    DEBUG_RAW: `FOUND ${finalizedReturns.length} RETURNS [${finalizedReturns.map((item: Bebas) => item.number).join('|')}] - OUT: ${totalOutstanding} | Logs: ${xrayLogs.join(';')}`
                });
            } else {
                returMap.set(compositeKey, {
                    number: "NOT_FOUND",
                    customerNo: custNo,
                    outstanding: 0,
                    DEBUG_RAW: `NOT_FOUND | Logs: ${xrayLogs.join(';')}`
                });
            }
        } catch (innerErr) {
            console.error(`Error processing return query ${compositeKey}:`, innerErr);
            returMap.set(compositeKey, {
                number: "NOT_FOUND",
                customerNo: meta.sourceCustomerNo,
                outstanding: 0,
                DEBUG_RAW: `ERROR: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`
            });
        }
    }
}
