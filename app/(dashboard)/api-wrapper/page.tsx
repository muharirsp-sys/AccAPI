/**
 * Tujuan: UI API Wrapper Accurate termasuk parser Excel bulk yang membentuk payload transaksi manual/bulk-save.
 * Caller: App Router dashboard `app/(dashboard)/api-wrapper/page.tsx` dan interaksi user di halaman API Wrapper.
 * Dependensi: `accurateRoutes`, `accurateFetch`, parser workbook per-route, Accurate OAuth/session dari browser, parser `xlsx`, toast `sonner`, route idempotency Next.
 * Main Functions: `Home`, `handleLoginAccurate`, `fetchDatabases`, `handleOpenDatabase`, `handleDownloadTemplate`, `handleExecute`.
 * Side Effects: HTTP call ke Accurate route handler/proxy, baca file Excel lokal, dispatch parser workbook khusus per route, deteksi format pelunasan walau `Total.Trx` kosong, normalisasi lookup invoice/retur termasuk variasi SRB tanpa spasi, susun payload bulk-save, keluarkan laporan manual follow-up untuk retur/pot.lain yang gagal diproses, preview/lock idempotency SQLite, cek histori sales receipt Accurate, konfirmasi hasil error ke histori Accurate, tampilkan review duplicate, logging debug ke response UI.
 */
"use client";

import { useState, useEffect } from "react";
import { Key, Upload, FileJson, Play, ServerCrash, ExternalLink, Settings2, Database, FileSpreadsheet, CheckCircle2, Loader2, LogOut, CalendarIcon } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { accurateRoutes } from "@/config/accurateRoutes";
import { accurateFetch, AccurateError } from "@/lib/apiFetcher";
import { workbookRouteParsers } from "./parsers";

type RouteKey = keyof typeof accurateRoutes;

type LogState = {
  status: "success" | "error";
  message?: string;
  data?: any;
};

type DuplicateConflictReason = "DUPLICATE_IN_UPLOAD" | "ALREADY_SUCCESS" | "STILL_PROCESSING" | "ACCURATE_HISTORY";

type DuplicateReviewEntry = {
  reviewId: string;
  key: string;
  row: any;
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

type DuplicateReviewState = {
  routeKey: RouteKey;
  passthroughRows: Array<{ originalIndex: number; row: any }>;
  reviewRows: DuplicateReviewEntry[];
  selections: Record<string, boolean>;
};

// Pastikan mengarah ke client ID yang sama di .env
const NEXT_PUBLIC_CLIENT_ID = process.env.NEXT_PUBLIC_ACCURATE_CLIENT_ID || "c1c0a2f0-b80e-435b-8065-c929e74aad1a";
const REDIRECT_URI = process.env.NEXT_PUBLIC_ACCURATE_REDIRECT_URI || "http://localhost:3000/api/auth/callback";

export default function Home() {

  const [apiKey, setApiKey] = useState("");
  const [dbHost, setDbHost] = useState("");
  const [dbSession, setDbSession] = useState("");

  const [isKeySaved, setIsKeySaved] = useState(false);
  const [isMounted, setIsMounted] = useState(false); // To prevent hydration mismatch

  // Database Selection State
  const [databases, setDatabases] = useState<any[]>([]);
  const [selectedDb, setSelectedDb] = useState("");
  const [isFetchingDbs, setIsFetchingDbs] = useState(false);

  const [selectedRoute, setSelectedRoute] = useState<RouteKey>("salesInvoice");
  const [inputMode, setInputMode] = useState<"manual" | "excel">("manual");
  const [payloadStr, setPayloadStr] = useState("");
  const [responseLog, setResponseLog] = useState<LogState | null>(null);
  const [duplicateReview, setDuplicateReview] = useState<DuplicateReviewState | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const normalizePayloadMoney = (value: any) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    // Simpan presisi sampai 6 desimal agar selisih kecil seperti 0.002 tidak hilang,
    // tapi tetap rapikan noise floating-point Excel.
    const normalized = Number(num.toFixed(6));
    return Math.abs(normalized) < 0.000001 ? 0 : normalized;
  };

  // Format Pelunasan Mapping States
  const [mapTunaiAutoNum, setMapTunaiAutoNum] = useState("");
  const [mapTunaiBank, setMapTunaiBank] = useState("");
  const [mapTrfAutoNum, setMapTrfAutoNum] = useState("");
  const [mapTrfBank, setMapTrfBank] = useState("");
  const [mapBgAutoNum, setMapBgAutoNum] = useState("");
  const [mapBgBank, setMapBgBank] = useState("");
  const [mapPot1Account, setMapPot1Account] = useState("");
  const [mapPot2Account, setMapPot2Account] = useState("");
  const [mapPot3Account, setMapPot3Account] = useState("");

  const getYesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  };
  const [trxDate, setTrxDate] = useState<string>(getYesterday());

  // Initial Load & OAuth Callback handler
  useEffect(() => {
    setIsMounted(true); // Ensure client-side only rendering for heavy interactive parts

    // Check if we came back from OAuth
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const tokenFromHash = hashParams.get("access_token");

    if (tokenFromHash) {
      sessionStorage.setItem("accurateApiKey", tokenFromHash);
      setApiKey(tokenFromHash);
      toast.success("Login Accurate Berhasil! Silakan pilih database.");
      // Clear hash for cleanliness
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      fetchDatabases(tokenFromHash);
    } else {
      // Normal Load
      const storedKey = sessionStorage.getItem("accurateApiKey");
      const storedHost = sessionStorage.getItem("accurateHost");
      const storedSession = sessionStorage.getItem("accurateSession");

      if (storedKey) setApiKey(storedKey);
      if (storedHost && storedSession) {
        setDbHost(storedHost);
        setDbSession(storedSession);
        setIsKeySaved(true);
      } else if (storedKey) {
        // Logged in but no DB selected
        fetchDatabases(storedKey);
      }
    }

    setPayloadStr(JSON.stringify(accurateRoutes[selectedRoute].samplePayload, null, 2));
  }, []);

  const handleLoginAccurate = () => {
    const params = new URLSearchParams({
      client_id: NEXT_PUBLIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "auto_number_save auto_number_view branch_save branch_view currency_save currency_view customer_save customer_view customer_category_save customer_category_view customer_claim_save customer_claim_view delivery_order_save delivery_order_view department_save department_view employee_view employee_save finished_good_slip_save finished_good_slip_view item_save item_view item_adjustment_save item_adjustment_view item_category_save item_category_view item_transfer_save item_transfer_view job_order_save job_order_view material_adjustment_save material_adjustment_view payment_term_save payment_term_view project_save project_view purchase_invoice_save purchase_invoice_view purchase_order_save purchase_order_view purchase_payment_save purchase_payment_view purchase_requisition_save purchase_requisition_view purchase_return_save purchase_return_view receive_item_save receive_item_view sales_invoice_save sales_invoice_view sales_order_save sales_order_view sales_quotation_save sales_quotation_view sales_receipt_save sales_receipt_view sales_return_save sales_return_view stock_opname_order_save stock_opname_order_view stock_opname_result_save stock_opname_result_view tax_save tax_view vendor_save vendor_view vendor_category_save vendor_category_view vendor_claim_save vendor_claim_view vendor_price_save vendor_price_view warehouse_view warehouse_save bank_statement_view bank_statement_save",
    });
    window.location.href = `https://account.accurate.id/oauth/authorize?${params.toString()}`;
  };

  const handleLogout = () => {
    sessionStorage.removeItem("accurateApiKey");
    sessionStorage.removeItem("accurateHost");
    sessionStorage.removeItem("accurateSession");
    setApiKey("");
    setDbHost("");
    setDbSession("");
    setIsKeySaved(false);
    setDatabases([]);
    toast.info("Anda telah log out dari sesi aplikasi.");
  };

  const fetchDatabases = async (token: string) => {
    setIsFetchingDbs(true);
    try {
      const res = await fetch(`/api/auth/db-list?access_token=${token}`);
      const data = await res.json();
      if (data.error || !data.d) throw new Error(data.error || "Gagal mengambil database.");
      setDatabases(data.d);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsFetchingDbs(false);
    }
  };

  const handleOpenDatabase = async () => {
    if (!selectedDb) {
      toast.error("Pilih database terlebih dahulu");
      return;
    }
    const tId = toast.loading("Membuka database...");
    try {
      const res = await fetch(`/api/auth/open-db?access_token=${apiKey}&id=${selectedDb}`);
      const data = await res.json();
      if (data.error || !data.host || !data.session) throw new Error(data.error || "Gagal membuka database.");

      sessionStorage.setItem("accurateHost", data.host);
      sessionStorage.setItem("accurateSession", data.session);
      setDbHost(data.host);
      setDbSession(data.session);
      setIsKeySaved(true);

      toast.success("Database berhasil terhubung!", { id: tId });
    } catch (e: any) {
      toast.error(e.message, { id: tId });
    }
  };

  const handleChangeRoute = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const route = e.target.value as RouteKey;
    setSelectedRoute(route);
    setPayloadStr(JSON.stringify(accurateRoutes[route].samplePayload, null, 2));
    setResponseLog(null);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (workbookRouteParsers[selectedRoute] && !isKeySaved) {
      toast.error("Parser bulk ini butuh login Accurate dan database yang sudah terbuka sebelum upload.");
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const workbookParser = workbookRouteParsers[selectedRoute];
        if (workbookParser) {
            toast.loading(`Menganalisis workbook khusus untuk ${accurateRoutes[selectedRoute].label}...`, { id: "parse" });
            const parserResult = await workbookParser({
                workbook: wb,
                routeKey: selectedRoute,
                trxDate,
                accurateFetch,
            });
            setPayloadStr(JSON.stringify(parserResult.payload, null, 2));
            setInputMode("manual");
            setResponseLog({
                status: "success",
                data: {
                    s: true,
                    d: parserResult.reportRows,
                    _note: parserResult.summaryMessage,
                    _warnings: parserResult.warnings,
                    _meta: parserResult.meta,
                },
            });
            if (parserResult.warnings.length > 0) {
                toast.warning(`${parserResult.summaryMessage} ${parserResult.warnings.slice(0, 2).join(" | ")}`, { id: "parse" });
            } else {
                toast.success(parserResult.summaryMessage, { id: "parse" });
            }
            e.target.value = '';
            return;
        }
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        let rawData = XLSX.utils.sheet_to_json(ws);
        
        // Bersihkan (*wajib) dari header bila ada
        let cleanedData = rawData.map((row: any) => {
           const newRow: any = {};
           for (const key in row) {
               const cleanKey = key.replace(/\s\(\*wajib\)$/i, '').trim();
               newRow[cleanKey] = row[key];
           }
           return newRow;
        });

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

        // Grouping Engine: Check if user uses ID_Grouping or ID_Pelunasan
        const groupingKeys = ["ID_Grouping", "ID_Pelunasan", "No", "ID_Transaksi"];
        let groupingKey = null;
        if (cleanedData.length > 0) {
            groupingKey = groupingKeys.find(k => k in cleanedData[0]);
        }

        if (groupingKey) {
            // Kita lakukan agregasi cerdas! Multiple baris Excel menjadi Array JSON Detail
            const groupedMap = new Map();
            
            cleanedData.forEach((row: any) => {
                const grpId = row[groupingKey!];
                if (!groupedMap.has(grpId)) {
                    // Ini kemunculan pertama ID tersebut (Header transaction)
                    const headerData: any = {};
                    for (const key in row) {
                        if (key !== groupingKey! && !key.includes('[')) {
                            // Ambil field utama
                            headerData[key] = row[key];
                        }
                    }
                    groupedMap.set(grpId, headerData);
                }
                
                // Helper to deep set object properties (handles [0], [1], [n] strings)
                const setDeep = (obj: any, path: string, value: any) => {
                    // Replace [n] with [0] generically for the main array item per row
                    const normalizedPath = path.replace(/\[n\]/g, '[0]');
                    const parts = normalizedPath.split(/[\.\[\]]+/).filter(Boolean);
                    let current = obj;
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        const nextPart = parts[i + 1];
                        if (i === parts.length - 1) {
                            current[part] = value;
                        } else {
                            if (!current[part]) {
                                current[part] = isNaN(nextPart as any) ? {} : [];
                            }
                            current = current[part];
                        }
                    }
                };
                
                // Helper to deeply clean array gaps (e.g., if user inputs [1], [2], leaving 0 undefined -> null inside Array)
                const cleanNulls = (obj: any): any => {
                    if (Array.isArray(obj)) {
                        return obj.filter(item => item !== null && item !== undefined).map(cleanNulls);
                    } else if (typeof obj === 'object' && obj !== null) {
                        for (const key in obj) {
                            obj[key] = cleanNulls(obj[key]);
                        }
                    }
                    return obj;
                };

                let parsedRow: any = {};
                for (const key in row) {
                    if (key !== groupingKey!) {
                        setDeep(parsedRow, key, row[key]);
                    }
                }
                
                parsedRow = cleanNulls(parsedRow);

                const parentObj = groupedMap.get(grpId);
                
                // Merge parsedRow into parentObj
                for (const key in parsedRow) {
                    if (Array.isArray(parsedRow[key])) {
                        if (!parentObj[key]) parentObj[key] = [];
                        // parsedRow[key] is an array.
                        // We push all elements of it to parentObj's array.
                        parsedRow[key].forEach((item: any) => {
                             if (item !== undefined && item !== null) {
                                 parentObj[key].push(item);
                             }
                        });
                    } else if (!parentObj[key]) {
                        parentObj[key] = parsedRow[key];
                    }
                }
            });
            cleanedData = Array.from(groupedMap.values());
            toast.success(`Data dikelompokkan: ${rawData.length} baris Excel menjadi ${cleanedData.length} transaksi bersarang.`);
        } else {
            toast.success(`Berhasil menyedot ${cleanedData.length} baris data Flat dari Excel.`);
        }
        
        setPayloadStr(JSON.stringify(cleanedData, null, 2));
        setInputMode("manual");
      } catch (err) {
        console.error("[HANDLE FILE UPLOAD ERROR]", err);
        const actualMessage = err instanceof Error ? err.message : String(err);
        toast.dismiss("parse");
        setResponseLog({ status: "error", message: actualMessage });
        toast.error(`Gagal menganalisis workbook: ${actualMessage}`);
      }
    };
    reader.readAsBinaryString(file);
    // Reset file input
    e.target.value = '';
  };

  const handleDownloadTemplate = async () => {
    const routeConfig = accurateRoutes[selectedRoute] as any;
    const headersConfig = routeConfig.templateHeaders;
    const isBulk = routeConfig.isBulk;
    
    if (!headersConfig || headersConfig.length === 0) {
      toast.error("Endpoint ini tidak memiliki template input yang didukung.");
      return;
    }

    const tId = toast.loading("Menyiapkan template dan memuat data sampel riil dari database...");
    let realData: any[] = [];
    
    try {
        if (isKeySaved) {
            // Coba ambil data list asli sebagai sampel referensi
            const basePath = routeConfig.path.replace('/save.do', '').replace('/bulk-save.do', '');
            const listPath = basePath + '/list.do';
            const fetchFields = headersConfig.map((h: any) => h.key).slice(0, 20).join(','); // Batasi request 20 field agar query params tidak tumpah
            
            const payload = {
                fields: fetchFields,
                "sp.sort": "id|desc",
                "sp.pageSize": isBulk ? 6 : 1
            };
            
            const res = await accurateFetch(listPath, "GET", payload);
            if (res && res.d && Array.isArray(res.d)) {
                realData = res.d;
            }
        }
    } catch (e) {
        console.log("Could not fetch real data, fallback to static dummies.");
    }
    
    // Create dummy rows depending on endpoint type
    const rowCount = isBulk ? 4 : 1; 
    const rows = [];
    
    // Siapkan kolom khusus Grouping di AWAL jika ini bulk operation yang rentan array details
    let hasArrayRefs = headersConfig.some((h: any) => h.key.includes('['));
    
    for (let i = 0; i < rowCount; i++) {
       const dummyRow: any = {};
       const srcData = realData[isBulk && hasArrayRefs ? Math.floor(i/2) : i] || {}; // Math.floor agar Tiap 2 baris Excel dikelompokkan ke 1 srcData
       
       if (isBulk && hasArrayRefs) dummyRow["ID_Grouping"] = `GRP-00${Math.floor(i/2)+1}`;

       headersConfig.forEach((h: any) => { 
           // Beri tanda wajib di header
           const headerName = h.required && !h.key.includes('[') ? `${h.key} (*wajib)` : h.key;
           
           // Jika ini adalah baris array [1], tapi row excel kita genap, biarkan blank untuk memberi efek menurun
           const isIndexOneField = headerName.includes('[1]');
           if (isIndexOneField && i % 2 === 0) return; // Skip buat ilusi baris baru
           
           // Isi dengan data live bila ada, bila kosong fallback ke static
           let val: any = srcData[h.key];
           
           if (val === undefined || val === null) {
               if (h.type === 'string') val = `contoh_text_${Math.floor(i/2)+1}`;
               else if (h.type === 'number' || h.type === 'integer') val = i + 1;
               else if (h.type === 'boolean') val = true;
               else if (h.type === 'array') val = '[ ... ] (Array/List)';
               else if (h.type === 'object') val = '{ ... } (Detail Object)';
               else val = "";
               
               if (h.key === 'transDate') val = new Date().toISOString().split('T')[0].split('-').reverse().join('/');
           } else if (typeof val === 'object') {
               val = JSON.stringify(val);
           }
           
           if (h.key === "chequeAmount") val = 0;
           dummyRow[headerName] = val;
       });
       rows.push(dummyRow);
    }

    const ws1 = XLSX.utils.json_to_sheet(rows);
    
    // Sheet 2: Penjelasan Kolom
    const infoRows = headersConfig.map((h: any) => ({
        "Nama Kolom API": h.key,
        "Wajib Diisi?": h.required ? "Ya (*wajib)" : "Opsional",
        "Tipe Data": h.type,
        "Keterangan Lengkap": h.description || "Tidak terdokumentasi."
    }));
    const ws2 = XLSX.utils.json_to_sheet(infoRows);

    // Sheet 3: Daftar Referensi ID
    const refRows: any[] = [];
    try {
        if (isKeySaved) {
            toast.loading("Mengumpulkan Referensi Master Data...", { id: tId });
            
            const checks = [
                { key: 'branchId', path: '/api/branch/list.do', nameField: 'name', typeName: 'Cabang' },
                { key: 'branchName', path: '/api/branch/list.do', nameField: 'name', typeName: 'Cabang' },
                { key: 'currencyId', path: '/api/currency/list.do', nameField: 'name', typeName: 'Mata Uang' },
                { key: 'currencyName', path: '/api/currency/list.do', nameField: 'name', typeName: 'Mata Uang' },
                { key: 'departmentId', path: '/api/department/list.do', nameField: 'name', typeName: 'Departemen' },
                { key: 'departmentNo', path: '/api/department/list.do', nameField: 'departmentNo', typeName: 'Departemen' },
                { key: 'projectId', path: '/api/project/list.do', nameField: 'name', typeName: 'Proyek' },
                { key: 'projectNo', path: '/api/project/list.do', nameField: 'projectNo', typeName: 'Proyek' },
                { key: 'warehouseId', path: '/api/warehouse/list.do', nameField: 'name', typeName: 'Gudang' },
                { key: 'typeAutoNumber', path: '/api/auto-number/list.do', nameField: 'name', typeName: 'Penomoran Otomatis' },
                { key: 'paymentTermId', path: '/api/payment-term/list.do', nameField: 'name', typeName: 'Syarat Pembayaran' },
                { key: 'defaultTerm', path: '/api/payment-term/list.do', nameField: 'name', typeName: 'Syarat Pembayaran' },
                { key: 'salesmanId', path: '/api/employee/list.do', nameField: 'name', typeName: 'Karyawan / Penjual' },
                { key: 'personInChargeId', path: '/api/employee/list.do', nameField: 'name', typeName: 'Karyawan / Penjual' },
                { key: 'accountNo', path: '/api/glaccount/list.do', nameField: 'name', typeName: 'Daftar Akun Perkiraan (GL)' },
                { key: 'bankNo', path: '/api/glaccount/list.do', nameField: 'name', typeName: 'Daftar Kas/Bank' }
            ];

            const headerKeys = headersConfig.map((h: any) => h.key);
            const fetchPromises = checks
                .filter(check => headerKeys.some((k: string) => k.includes(check.key))) // supports nested like [n].accountNo
                .filter((v, i, a) => a.findIndex(t => (t.path === v.path)) === i) // Unique paths
                .map(async (check) => {
                    // Ambil maksimal 2000 record untuk memastikan master data ketarik semua
                    // Request field 'no' tambahan untuk glaccount
                    const fetchExtFields = check.path.includes('glaccount') ? `id,${check.nameField},no` : `id,${check.nameField}`;
                    const res = await accurateFetch(check.path, "GET", { "sp.pageSize": 2000, "fields": fetchExtFields });
                    
                    if (res && res.d && Array.isArray(res.d)) {
                        res.d.forEach((item: any) => {
                            refRows.push({
                                "Tipe Referensi": check.typeName,
                                "ID / Nilai Input": item.no ? item.no : item.id, // Jika punya 'no' (seperti GLAccount), gunakan nomor akunnya sbg input
                                "Nama / Deskripsi": item[check.nameField] || "-"
                            });
                        });
                    }
                });
                
            await Promise.allSettled(fetchPromises);
        }
    } catch (e) {
        console.log("Error fetching references", e);
    }
    
    if (refRows.length === 0) {
        refRows.push({"Info": "Tidak ada data referensi khusus (seperti Branch/Currency) yang dibutuhkan atau ditemukan untuk template ini."});
    }

    const ws3 = XLSX.utils.json_to_sheet(refRows);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Data Upload");
    XLSX.utils.book_append_sheet(wb, ws2, "Penjelasan Kolom");
    XLSX.utils.book_append_sheet(wb, ws3, "Referensi ID");

    const fileName = `Template_${selectedRoute}.xlsx`;
    XLSX.writeFile(wb, fileName);
    toast.success(`Template ${fileName} dengan 3 Sheet berhasil diunduh!`, { id: tId });
  };

  const getDuplicateReasonLabel = (reason: DuplicateConflictReason) => {
    if (reason === "DUPLICATE_IN_UPLOAD") return "Duplikat dalam upload ini";
    if (reason === "ALREADY_SUCCESS") return "Sudah pernah sukses diupload";
    if (reason === "ACCURATE_HISTORY") return "Mirip histori Accurate";
    return "Masih diproses dalam 15 menit terakhir";
  };

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

  const executeBulkPayload = async (
    rows: any[],
    routeConfig: typeof accurateRoutes[RouteKey],
    duplicateOptions?: { allowDuplicateKeys?: string[]; allowLockedKeys?: string[] }
  ) => {
    if (document.location.pathname.includes('/sales-receipt')) {
      toast.loading("Mengunci batch idempotency...", { id: 'exec' });
      const keysPayload = rows.map((row: any) => buildSalesReceiptIdempotencyPayload(row));
      const lockRes = await fetch('/api/idempotency/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: keysPayload,
          allowDuplicateKeys: duplicateOptions?.allowDuplicateKeys || [],
          allowLockedKeys: duplicateOptions?.allowLockedKeys || []
        })
      });
      const lockData = await lockRes.json();
      if (!lockRes.ok) throw new Error(lockData.error || "Gagal mengunci idempotency.");
      if (Array.isArray(lockData.blockedKeys) && lockData.blockedKeys.length > 0) {
        throw new Error("Beberapa baris berubah status duplikat saat review. Buka ulang review lalu pilih kembali.");
      }
    }

    if (rows.length === 0) {
      toast.dismiss('exec');
      return;
    }

    const totalRows = rows.length;
    const chunkSize = 100;
    const totalChunks = Math.ceil(totalRows / chunkSize);

    if (totalChunks > 1) {
      toast.loading(`Mengeksekusi ${totalRows} data dalam ${totalChunks} tahap pemrosesan...`, { id: 'exec' });
    } else {
      toast.loading(`Mengeksekusi ${totalRows} data...`, { id: 'exec' });
    }

    let combinedResults: any[] = [];
    let errorLogForExcel: any[] = [];
    let errorCount = 0;
    const overrideLockedKeySet = new Set(duplicateOptions?.allowLockedKeys || []);
    const confirmedReceiptNumbersByKey = new Map<string, string[]>();

    const markIdempotency = async (row: any, isSuccess: boolean) => {
      if (!document.location.pathname.includes('/sales-receipt')) return;
      try {
        const rowKey = buildSalesReceiptIdempotencyPayload(row).key;
        if (overrideLockedKeySet.has(rowKey)) return;
        fetch('/api/idempotency/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: [rowKey], status: isSuccess ? 'SUCCESS' : 'FAILED' })
        });
      } catch (e) {}
    };

    const confirmRowsPostedInAccurate = async (rowsToCheck: any[]) => {
      const uncheckedRows = rowsToCheck.filter((row) => !confirmedReceiptNumbersByKey.has(buildSalesReceiptIdempotencyPayload(row).key));
      if (uncheckedRows.length === 0) return confirmedReceiptNumbersByKey;

      const matchedMap = await previewAccurateSalesReceiptHistory(uncheckedRows);
      uncheckedRows.forEach((row) => {
        const rowKey = buildSalesReceiptIdempotencyPayload(row).key;
        confirmedReceiptNumbersByKey.set(rowKey, matchedMap.get(rowKey) || []);
      });

      return confirmedReceiptNumbersByKey;
    };

    const getConfirmedReceiptNumbers = async (row: any) => {
      const rowKey = buildSalesReceiptIdempotencyPayload(row).key;
      if (!confirmedReceiptNumbersByKey.has(rowKey)) {
        await confirmRowsPostedInAccurate([row]);
      }
      return confirmedReceiptNumbersByKey.get(rowKey) || [];
    };

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalRows);
      const chunkPayload = rows.slice(start, end);

      toast.loading(`[Tahap ${i+1}/${totalChunks}] Memproses baris ${start+1}-${end}...`, { id: 'exec' });

      try {
        const data = await accurateFetch(routeConfig.path, routeConfig.method, chunkPayload);

        if (Array.isArray(data)) {
          combinedResults = combinedResults.concat(data);
          data.forEach((r, idx) => {
            markIdempotency(chunkPayload[idx], !!r.s);
          });
        } else if (data && data.d && Array.isArray(data.d)) {
          combinedResults = combinedResults.concat(data.d);
          data.d.forEach((r: any, idx: number) => {
            markIdempotency(chunkPayload[idx], !!r.s);
          });
        } else if (data && data.s === true) {
          combinedResults.push(data);
          chunkPayload.forEach((r: any) => markIdempotency(r, true));
        } else {
          combinedResults.push(data);
          chunkPayload.forEach((r: any) => markIdempotency(r, !!data?.s));
        }
      } catch (chunkErr: any) {
        console.error(`Chunk ${i+1} Failed:`, chunkErr);
        let chunkHadUnresolvedFailure = false;

        if (chunkErr.rawDetails && Array.isArray(chunkErr.rawDetails)) {
          const isSingleOverallError = chunkErr.rawDetails.length === 1 && chunkPayload.length > 1;

          const extractReasonStr = (resultObj: any, fallbackStr: string) => {
            if (!resultObj || !resultObj.d) return fallbackStr;
            if (Array.isArray(resultObj.d)) {
              const firstItem = resultObj.d[0];
              if (typeof firstItem === 'object' && firstItem !== null) {
                if (firstItem.d && Array.isArray(firstItem.d)) {
                  return String(firstItem.d[0]);
                }
                return JSON.stringify(firstItem);
              }
              return String(firstItem);
            }
            return String(resultObj.d || fallbackStr);
          };

          if (isSingleOverallError) {
            const singleResult = chunkErr.rawDetails[0];
            const reasonStr = extractReasonStr(singleResult, chunkErr.message);

            toast.loading(`Tahap ${i+1} dicekal keseluruhan. Mulai Mode Penguraian Individu...`, { id: 'exec' });

            for (let idx = 0; idx < chunkPayload.length; idx++) {
              const row = chunkPayload[idx];
              try {
                const indData = await accurateFetch(routeConfig.path, routeConfig.method, [row]);
                const isSuccess = Array.isArray(indData) ? indData[0]?.s : indData.s;

                if (isSuccess) {
                  combinedResults.push(Array.isArray(indData) ? indData[0] : indData);
                } else {
                  const indReasonStr = extractReasonStr(Array.isArray(indData) ? indData[0] : indData, "Error validasi individual");
                  const match = indReasonStr.match(/"([^"]+)"/);
                  await processAutoHeal(row, match ? match[1] : null, indReasonStr, i, start, idx, false);
                }
              } catch (indErr: any) {
                const indReasonStr = indErr.rawDetails && indErr.rawDetails.length > 0 ? extractReasonStr(indErr.rawDetails[0], indErr.message) : indErr.message;
                const match = indReasonStr.match(/"([^"]+)"/);
                await processAutoHeal(row, match ? match[1] : null, indReasonStr, i, start, idx, false);
              }
            }
          } else {
            for (let idx = 0; idx < chunkPayload.length; idx++) {
              const row = chunkPayload[idx];
              const result = chunkErr.rawDetails[idx];

              if (result && result.s === false) {
                const reasonStr = extractReasonStr(result, chunkErr.message);
                const match = reasonStr.match(/"([^"]+)"/);
                const failedInvoiceNo = match ? match[1] : null;

                await processAutoHeal(row, failedInvoiceNo, reasonStr, i, start, idx, false);
              }
            }
          }

          async function processAutoHeal(row: any, failedInvoiceNo: string | null, reasonStr: string, chunkIdx: number, startIdx: number, rowIdx: number, isOverall: boolean) {
            const mainId = row.invoiceNo || row.customerNo || row.bankNo || row.description || `Baris Eksekusi ${startIdx + rowIdx + 1}`;
            let isHealed = false;

            if (failedInvoiceNo && reasonStr.includes("melebihi nilai piutang")) {
              toast.loading(`Mencoba Auto-Correction untuk ${failedInvoiceNo}...`, { id: `heal-${failedInvoiceNo}` });
              try {
                const invoiceCheck = await accurateFetch('/api/sales-invoice/list.do', 'GET', {
                  fields: "id,number,primeOwing",
                  "filter.number.op": "EQUAL",
                  "filter.number.val": failedInvoiceNo
                });

                if (invoiceCheck && invoiceCheck.d && invoiceCheck.d.length > 0) {
                  const actualPrimeOwing = invoiceCheck.d[0].primeOwing || 0;

                  let userAmount = 0;
                  if (row.detailInvoice && Array.isArray(row.detailInvoice)) {
                    const detail = row.detailInvoice.find((d: any) => d.invoiceNo === failedInvoiceNo);
                    if (detail) userAmount = Number(detail.paymentAmount) || 0;
                  }
                  if (userAmount === 0) userAmount = Number(row.chequeAmount) || 0;

                  const diff = Math.abs(userAmount - actualPrimeOwing);
                  if (diff > 0 && diff <= 100) {
                    const healedRow = JSON.parse(JSON.stringify(row));
                    const amountToDeduct = userAmount - actualPrimeOwing;
                    const currentChequeAmount = Number(healedRow.chequeAmount) || 0;
                    healedRow.chequeAmount = normalizePayloadMoney(currentChequeAmount - amountToDeduct);

                    if (healedRow.detailInvoice && Array.isArray(healedRow.detailInvoice)) {
                      const detail = healedRow.detailInvoice.find((d: any) => d.invoiceNo === failedInvoiceNo);
                      if (detail) {
                        detail.paymentAmount = normalizePayloadMoney(actualPrimeOwing);
                      }
                    } else if (!healedRow.detailInvoice || healedRow.detailInvoice.length === 0) {
                      healedRow.chequeAmount = normalizePayloadMoney(actualPrimeOwing);
                    }

                    const retryData = await accurateFetch(routeConfig.path, routeConfig.method, [healedRow]);
                    const isRetrySuccess = Array.isArray(retryData) ? retryData[0]?.s : retryData.s;

                    if (isRetrySuccess) {
                      isHealed = true;
                      combinedResults.push(Array.isArray(retryData) ? retryData[0] : retryData);
                      markIdempotency(row, true);
                      toast.success(`Self-Healing Berhasil! ${failedInvoiceNo} dikoreksi ke ${actualPrimeOwing}`, { id: `heal-${failedInvoiceNo}` });

                      errorLogForExcel.push({
                        "Paket/Batch": `Tahap ${chunkIdx+1}`,
                        "Baris Ke": startIdx + rowIdx + 1,
                        "Ref / Invoice No": mainId,
                        "Status": "BERHASIL (AUTO-CORRECTED)",
                        "Pesan Error Accurate": `Awalnya gagal selisih Rp ${normalizePayloadMoney(diff)} (Tertulis: ${normalizePayloadMoney(userAmount)}, AOL: ${normalizePayloadMoney(actualPrimeOwing)}). Dikoreksi PWA.`
                      });
                    } else {
                      toast.error(`Auto-Correct gagal diposting ulang untuk ${failedInvoiceNo}`, { id: `heal-${failedInvoiceNo}` });
                    }
                  } else {
                    toast.error(`Selisih terlalu besar (Rp ${normalizePayloadMoney(diff)}) untuk ${failedInvoiceNo}. Batal Auto-Correct.`, { id: `heal-${failedInvoiceNo}` });
                  }
                }
              } catch (healErr) {
                console.error("Self-healing error:", healErr);
                toast.error(`Gagal mengecek referensi invoice ${failedInvoiceNo}`, { id: `heal-${failedInvoiceNo}` });
              }
            }

            if (!isHealed) {
              const matchedReceiptNumbers = await getConfirmedReceiptNumbers(row);
              if (matchedReceiptNumbers.length > 0) {
                markIdempotency(row, true);
                combinedResults.push({
                  s: true,
                  _confirmedFromHistory: true,
                  _matchedReceiptNumbers: matchedReceiptNumbers,
                  _originalError: reasonStr
                });
                errorLogForExcel.push({
                  "Paket/Batch": `Tahap ${chunkIdx+1}`,
                  "Baris Ke": startIdx + rowIdx + 1 + (isOverall ? " (Penyebab Blok)" : ""),
                  "Ref / Invoice No": mainId,
                  "Status": "BERHASIL (TERKONFIRMASI HISTORI ACCURATE)",
                  "Pesan Error Accurate": `${reasonStr} | Receipt ditemukan: ${matchedReceiptNumbers.join(", ")}`
                });
                return;
              }

              markIdempotency(row, false);
              chunkHadUnresolvedFailure = true;
              errorLogForExcel.push({
                "Paket/Batch": `Tahap ${chunkIdx+1}`,
                "Baris Ke": startIdx + rowIdx + 1 + (isOverall ? " (Penyebab Blok)" : ""),
                "Ref / Invoice No": mainId,
                "Status": "Gagal",
                "Pesan Error Accurate": reasonStr
              });
            }
          }
        } else {
          const confirmedMap = await confirmRowsPostedInAccurate(chunkPayload);
          chunkPayload.forEach((row: any, idx: number) => {
            const mainId = row.invoiceNo || row.customerNo || row.bankNo || row.description || `Baris Asli ke-${start + idx + 1}`;
            const rowKey = buildSalesReceiptIdempotencyPayload(row).key;
            const matchedReceiptNumbers = confirmedMap.get(rowKey) || [];

            if (matchedReceiptNumbers.length > 0) {
              markIdempotency(row, true);
              combinedResults.push({
                s: true,
                _confirmedFromHistory: true,
                _matchedReceiptNumbers: matchedReceiptNumbers,
                _originalError: chunkErr.message || "Unknown error parsing chunk return"
              });
              errorLogForExcel.push({
                "Paket/Batch": `Tahap ${i+1}`,
                "Baris Ke": start + idx + 1,
                "Ref / Invoice No": mainId,
                "Status": "BERHASIL (TERKONFIRMASI HISTORI ACCURATE)",
                "Pesan Error Accurate": `${chunkErr.message || "Unknown error parsing chunk return"} | Receipt ditemukan: ${matchedReceiptNumbers.join(", ")}`
              });
              return;
            }

            markIdempotency(row, false);
            chunkHadUnresolvedFailure = true;
            errorLogForExcel.push({
              "Paket/Batch": `Tahap ${i+1}`,
              "Baris Ke": start + idx + 1,
              "Ref / Invoice No": mainId,
              "Status": "Gagal",
              "Pesan Error Accurate": chunkErr.message || "Unknown error parsing chunk return"
            });
          });
        }

        if (chunkHadUnresolvedFailure) {
          errorCount++;
        }
      }
    }

    if (errorCount === 0) {
      setResponseLog({ status: "success", data: { s: true, d: combinedResults, _note: "Digabung dari beberapa request otomatis." } });
      toast.success(`Eksekusi brutal berhasil! ${combinedResults.length} data telah terposting.`, { id: 'exec' });
    } else {
      setResponseLog({ status: "error", message: `Selesai dengan ${errorCount} error tahap. Periksa console log untuk rincian error di beberapa baris. Data yang berhasil: ${combinedResults.length}` });
      toast.error(`Selesai dengan peringatan (${errorCount} Tahap Gagal).`, { id: 'exec' });

      if (errorLogForExcel.length > 0) {
        setTimeout(() => {
          toast("Mengunduh Excel Log Error...", { icon: "📥" });
          try {
            const wsErr = XLSX.utils.json_to_sheet(errorLogForExcel);
            const wbErr = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wbErr, wsErr, "Error Log");
            XLSX.writeFile(wbErr, `Laporan_Error_Upload_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
          } catch(e) { console.error("Gagal buat xlsx error", e); }
        }, 2000);
      }
    }
  };

  const handleDuplicateSelectionChange = (reviewId: string, checked: boolean) => {
    setDuplicateReview((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        selections: {
          ...prev.selections,
          [reviewId]: checked
        }
      };
    });
  };

  const handleConfirmDuplicateReview = async () => {
    if (!duplicateReview) return;

    const selectedReviewRows = duplicateReview.reviewRows
      .filter((item) => duplicateReview.selections[item.reviewId])
      .map((item) => ({ originalIndex: item.originalIndex, row: item.row, key: item.key, reasons: item.reasons }));

    const finalRows = [...duplicateReview.passthroughRows, ...selectedReviewRows]
      .sort((a, b) => a.originalIndex - b.originalIndex)
      .map((item) => item.row);

    if (finalRows.length === 0) {
      toast.error("Tidak ada baris yang dipilih untuk diproses.");
      return;
    }

    const allowDuplicateKeys = Array.from(new Set(selectedReviewRows
      .filter((item) => item.reasons.includes("DUPLICATE_IN_UPLOAD"))
      .map((item) => item.key)));
    const allowLockedKeys = Array.from(new Set(selectedReviewRows
      .filter((item) => item.reasons.includes("ALREADY_SUCCESS") || item.reasons.includes("STILL_PROCESSING"))
      .map((item) => item.key)));

    const routeConfig = accurateRoutes[duplicateReview.routeKey];
    setDuplicateReview(null);
    setIsLoading(true);

    try {
      await executeBulkPayload(finalRows, routeConfig, { allowDuplicateKeys, allowLockedKeys });
    } catch (err: unknown) {
      if (err instanceof Error) {
        setResponseLog({ status: "error", message: err.message });
        toast.error(`Eksekusi gagal: ${err.message}`, { id: 'exec' });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!isKeySaved) {
      toast.error("Silakan login dan pilih database terlebih dahulu.");
      return;
    }

    let payloadObj: any = null;
    if (inputMode === "manual") {
      try {
        payloadObj = JSON.parse(payloadStr);
      } catch (e) {
        toast.error("Format JSON tidak valid. Silakan periksa kembali.");
        return;
      }
    } else {
      payloadObj = accurateRoutes[selectedRoute].samplePayload;
    }

    setIsLoading(true);
    const routeConfig = accurateRoutes[selectedRoute];
    const isBulk = routeConfig.path.includes('bulk-save');
    
    try {
      // Chunking Engine for Bulk Save (Handles both Max 100 Limit bypass AND Auto-Healing logic for any size)
      if (isBulk && Array.isArray(payloadObj)) {
          if (document.location.pathname.includes('/sales-receipt')) {
              toast.loading("Menganalisis potensi pembayaran ganda...", { id: 'exec' });
              const reviewState = await previewSalesReceiptDuplicates(payloadObj, selectedRoute);
              if (reviewState) {
                  setDuplicateReview(reviewState);
                  toast.dismiss('exec');
                  return;
              }
          }
          await executeBulkPayload(payloadObj, routeConfig);
      } else {
          // Normal Execution
          toast.loading(`Mengeksekusi ${routeConfig.label}...`, { id: 'exec' });
          const data = await accurateFetch(routeConfig.path, routeConfig.method, payloadObj);
          setResponseLog({ status: "success", data });
          toast.success("Eksekusi berhasil!", { id: 'exec' });
      }

    } catch (err: unknown) {
      if (err instanceof Error) {
        setResponseLog({ status: "error", message: err.message });
        toast.error(`Eksekusi gagal: ${err.message}`, { id: 'exec' });
      }
    } finally {
      setIsLoading(false);
    }
  };

  // SSR strictly returns loading state to prevent hydration error
  if (!isMounted) {
    return (
      <div className="min-h-screen bg-[#0f1015] flex items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-3 text-indigo-400">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p className="text-sm border border-white/10 bg-white/5 backdrop-blur-md px-4 py-2 rounded-full font-medium text-slate-300 animate-pulse shadow-[0_0_15px_rgba(79,70,229,0.2)]">Menghubungkan ke Workspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header Section */}
        <header className="flex items-center justify-between pb-6 border-b border-white/10">
          <div>
            <h1 className="text-3xl font-extrabold text-white tracking-tight flex items-center gap-2 drop-shadow-md">
              <Database className="w-8 h-8 text-indigo-400 drop-shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
              AOL API Wrapper
            </h1>
            <p className="text-sm text-slate-400 mt-1">SaaS & Internal IT Execution Dashboard</p>
          </div>
          {isKeySaved && (
            <button onClick={handleLogout} className="text-sm font-medium text-red-400 hover:text-red-300 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 px-4 py-2 rounded-xl flex items-center gap-2 transition-all backdrop-blur-md shadow-[0_0_15px_rgba(239,68,68,0.1)]">
              <LogOut className="w-4 h-4" /> Disconnect
            </button>
          )}
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          {/* Left Column - Configuration */}
          <div className="lg:col-span-4 space-y-6">

            {/* Authenticated State Card */}
            <div className="bg-[#1e1f29]/40 backdrop-blur-xl rounded-2xl p-6 shadow-2xl border border-white/10 relative overflow-hidden text-slate-300">
              <div className={`absolute top-0 left-0 w-1 h-full rounded-l-2xl shadow-[0_0_15px_currentColor] ${isKeySaved ? "bg-emerald-500 text-emerald-500" : "bg-indigo-500 text-indigo-500"}`}></div>
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4 text-white">
                <Key className={`w-5 h-5 ${isKeySaved ? "text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "text-indigo-400 drop-shadow-[0_0_8px_rgba(99,102,241,0.8)]"}`} />
                {isKeySaved ? "Sesi Terhubung" : "Autentikasi Aplikasi"}
              </h2>

              {!apiKey ? (
                <div className="space-y-4 text-center">
                  <p className="text-sm text-white/50 mb-2">Aplikasi ini membutuhkan akses Secure OAuth ke Accurate Online Anda.</p>
                  <button
                    onClick={handleLoginAccurate}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm py-3 rounded-xl transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] hover:shadow-[0_0_25px_rgba(79,70,229,0.5)] flex items-center justify-center gap-2"
                  >
                    Login dengan Accurate
                  </button>
                </div>
              ) : !isKeySaved ? (
                <div className="space-y-4">
                  <p className="text-sm text-white/60">Pilih Database yang ingin dikelola:</p>
                  {isFetchingDbs ? (
                    <div className="flex items-center gap-2 text-indigo-400 text-sm font-medium">
                      <Loader2 className="w-4 h-4 animate-spin drop-shadow-[0_0_5px_currentColor]" /> Mengambil daftar database...
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <select
                        value={selectedDb}
                        onChange={(e) => setSelectedDb(e.target.value)}
                        className="w-full px-4 py-3 text-sm rounded-xl border border-white/10 bg-black/40 text-white focus:ring-2 focus:ring-indigo-500/50 appearance-none bg-no-repeat"
                        style={{ backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>')`, backgroundPosition: 'right 16px center' }}
                      >
                        <option value="" className="bg-[#1e1f29] text-white">-- Pilih Database --</option>
                        {databases.map((db, i) => (
                          <option key={i} value={db.id} className="bg-[#1e1f29] text-white">{db.alias}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleOpenDatabase}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm py-3 rounded-xl transition-all shadow-[0_0_20px_rgba(5,150,105,0.3)] hover:shadow-[0_0_25px_rgba(5,150,105,0.5)]"
                      >
                        Buka Database
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3 mt-2">
                  <div className="bg-emerald-500/20 text-emerald-300 text-xs font-semibold px-4 py-3 rounded-xl border border-emerald-500/30 flex items-center gap-2 shadow-[0_0_15px_rgba(52,211,153,0.1)]">
                    <CheckCircle2 className="w-4 h-4 drop-shadow-[0_0_5px_currentColor]" /> Ready to serve
                  </div>
                  <div className="text-xs break-all text-white/50 bg-black/40 p-3 rounded-xl font-mono border border-white/5">
                    <span className="font-semibold text-white/70 block mb-1">Host Endpoint:</span>
                    {dbHost}
                  </div>
                </div>
              )}
            </div>

            {/* Route Selector Card */}
            <div className={`bg-[#1e1f29]/40 backdrop-blur-xl rounded-2xl p-6 shadow-2xl border border-white/10 transition-opacity ${!isKeySaved ? "opacity-40 pointer-events-none grayscale blur-[1px]" : ""}`}>
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4 text-white">
                <Settings2 className="w-5 h-5 text-indigo-400 drop-shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                Modul Endpoint
              </h2>
              <div className="space-y-5">
                <div>
                  <label className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2 block">Pilih Endpoint API</label>
                  <select
                    value={selectedRoute}
                    onChange={handleChangeRoute}
                    className="w-full px-4 py-3 text-sm rounded-xl border border-white/10 bg-black/40 hover:bg-black/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all text-white cursor-pointer appearance-none shadow-inner"
                    style={{ backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>')`, backgroundPosition: 'right 16px center', backgroundRepeat: 'no-repeat', paddingRight: '40px' }}
                  >
                    {(Object.keys(accurateRoutes) as RouteKey[]).map((key) => (
                      <option key={key} value={key} className="bg-[#1e1f29] text-white">
                        {accurateRoutes[key].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bg-indigo-500/10 rounded-xl p-4 border border-indigo-500/20 shadow-inner">
                  <p className="text-xs text-indigo-300 font-medium break-all flex justify-between items-center">
                    <span className="opacity-90 font-bold bg-indigo-500/20 px-2 py-1 rounded">{accurateRoutes[selectedRoute].method}</span>
                    <span className="font-mono opacity-80">{accurateRoutes[selectedRoute].path}</span>
                  </p>
                  <p className="text-xs text-white/60 mt-3 italic">{accurateRoutes[selectedRoute].description}</p>
                </div>
              </div>
            </div>

          </div>

          {/* Right Column - Input & Execution */}
          <div className={`lg:col-span-8 flex flex-col gap-6 transition-opacity ${!isKeySaved ? "opacity-50 pointer-events-none grayscale" : ""}`}>

            {/* Input Mode Tabs & Payload Area */}
            <div className="bg-[#1e1f29]/40 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 flex flex-col overflow-hidden">
              <div className="flex items-center border-b border-white/10 bg-black/20 px-2 py-2">
                <button
                  onClick={() => setInputMode("manual")}
                  className={`flex-1 flex justify-center items-center gap-2 py-2.5 text-sm font-medium rounded-xl transition-all ${inputMode === "manual" ? "bg-indigo-600 text-white shadow-[0_0_15px_rgba(79,70,229,0.3)] border border-transparent" : "text-white/50 hover:text-white hover:bg-white/5"}`}
                >
                  <FileJson className="w-4 h-4" />
                  JSON / Parameter Manual
                </button>
                <button
                  onClick={() => setInputMode("excel")}
                  className={`flex-1 flex justify-center items-center gap-2 py-2.5 text-sm font-medium rounded-xl transition-all ${inputMode === "excel" ? "bg-indigo-600 text-white shadow-[0_0_15px_rgba(79,70,229,0.3)] border border-transparent" : "text-white/50 hover:text-white hover:bg-white/5"}`}
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Excel Import (Batch)
                </button>
              </div>

              <div className="p-0 flex-1 flex flex-col">
                {inputMode === "manual" ? (
                  <textarea
                    value={payloadStr}
                    onChange={(e) => setPayloadStr(e.target.value)}
                    className="w-full flex-1 p-6 text-sm font-mono text-emerald-300 bg-black/20 focus:outline-none focus:ring-inset focus:ring-1 focus:ring-indigo-500/50 resize-y min-h-[300px]"
                    spellCheck={false}
                  />
                ) : (
                  <>
                  <div className="mx-6 mt-6 p-5 bg-[#1e1f29]/80 shadow-inner border border-white/10 rounded-2xl flex flex-col sm:flex-row sm:items-center gap-4">
                     <div>
                       <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                          <CalendarIcon className="w-4 h-4 text-emerald-400" />
                          Tanggal Transaksi Default
                       </h3>
                       <p className="text-xs text-white/50 mt-1">Tanggal H-1 secara default. Akan disuntikkan ke seluruh tagihan dari Excel.</p>
                     </div>
                     <div className="sm:ml-auto">
                        <input 
                           type="date" 
                           value={trxDate} 
                           onChange={e => setTrxDate(e.target.value)} 
                           className="px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                     </div>
                  </div>

                  {selectedRoute === "salesReceiptBulkSave" && (
                     <div className="mx-6 mt-6 p-5 bg-indigo-900/20 shadow-inner border border-indigo-500/30 rounded-2xl">
                        <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                           <Settings2 className="w-4 h-4 text-indigo-400" />
                           Mapping Format Pelunasan Internal (Hanya Berlaku Excel Internal)
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                           <div className="space-y-2">
                              <label className="text-xs text-white/50 font-medium">Tunai (No Kas/Bank & Penomoran)</label>
                              <div className="flex gap-2">
                                 <input type="text" placeholder="ID/No Akun Bank" value={mapTunaiBank} onChange={e => setMapTunaiBank(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                                 <input type="text" placeholder="ID AutoNumber" value={mapTunaiAutoNum} onChange={e => setMapTunaiAutoNum(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                              </div>
                           </div>
                           <div className="space-y-2">
                              <label className="text-xs text-white/50 font-medium">Trf (No Kas/Bank & Penomoran)</label>
                              <div className="flex gap-2">
                                 <input type="text" placeholder="ID/No Akun Bank" value={mapTrfBank} onChange={e => setMapTrfBank(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                                 <input type="text" placeholder="ID AutoNumber" value={mapTrfAutoNum} onChange={e => setMapTrfAutoNum(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                              </div>
                           </div>
                           <div className="space-y-2">
                              <label className="text-xs text-white/50 font-medium">BG (No Kas/Bank & Penomoran)</label>
                              <div className="flex gap-2">
                                 <input type="text" placeholder="ID/No Akun Bank" value={mapBgBank} onChange={e => setMapBgBank(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                                 <input type="text" placeholder="ID AutoNumber" value={mapBgAutoNum} onChange={e => setMapBgAutoNum(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                              </div>
                           </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-white/10">
                           <div className="space-y-2">
                              <label className="text-xs text-white/50 font-medium">Pot.1 (Akun GL Diskon)</label>
                              <input type="text" placeholder="No. Akun GL (Biarkan kosong bila tdk digunakan)" value={mapPot1Account} onChange={e => setMapPot1Account(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                           </div>
                           <div className="space-y-2">
                              <label className="text-xs text-white/50 font-medium">Pot.2 (Akun GL Diskon)</label>
                              <input type="text" placeholder="No. Akun GL" value={mapPot2Account} onChange={e => setMapPot2Account(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                           </div>
                           <div className="space-y-2">
                              <label className="text-xs text-white/50 font-medium">Pot.3 (Akun GL Diskon)</label>
                              <input type="text" placeholder="No. Akun GL" value={mapPot3Account} onChange={e => setMapPot3Account(e.target.value)} className="w-full px-3 py-2 text-xs bg-black/40 border border-white/10 rounded-lg text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                           </div>
                        </div>
                     </div>
                  )}
                  <div className="p-12 flex flex-col items-center justify-center text-center min-h-[300px] bg-black/20 border-2 border-dashed border-white/10 m-6 rounded-2xl">
                    <div className="w-16 h-16 bg-indigo-500/20 text-indigo-400 rounded-full flex items-center justify-center mb-4 shadow-[0_0_15px_rgba(99,102,241,0.2)]">
                      <Upload className="w-8 h-8 drop-shadow-[0_0_8px_currentColor]" />
                    </div>
                    <h3 className="text-sm font-semibold text-white">Pilih File Excel Anda</h3>
                    <p className="text-xs text-white/50 mt-1 mb-6">Pastikan nama kolom Excel di Baris Pertama (Header) PERSIS sama persis dengan nama parameter API Accurate.</p>
                    <div className="flex items-center gap-3">
                      <button onClick={handleDownloadTemplate} className="px-5 py-2.5 bg-indigo-900/40 border border-indigo-500/30 rounded-xl text-sm font-medium text-indigo-300 hover:bg-indigo-800/60 hover:text-indigo-200 transition-all shadow-[0_0_15px_rgba(79,70,229,0.1)] inline-flex items-center gap-2">
                        <FileSpreadsheet className="w-4 h-4" />
                        Download Template Excel
                      </button>
                      <label className="px-5 py-2.5 bg-[#ffffff]/10 backdrop-blur-md border border-white/20 rounded-xl text-sm font-medium text-white hover:bg-white/20 transition-all cursor-pointer inline-flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.05)]">
                        <input type="file" className="hidden" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} />
                        Upload Data (.xlsx)
                      </label>
                    </div>
                  </div>
                  </>
                )}
              </div>

              <div className="p-5 border-t border-white/5 bg-black/20 flex justify-end">
                <button
                  disabled={isLoading || !isKeySaved}
                  onClick={handleExecute}
                  className={`px-8 py-3 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${isLoading ? "bg-indigo-900/50 cursor-not-allowed text-white/50" : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.4)] hover:shadow-[0_0_30px_rgba(99,102,241,0.6)]"}`}
                >
                  <Play className={`w-4 h-4 ${isLoading ? "animate-pulse" : "fill-current"}`} />
                  {isLoading ? "Mengeksekusi..." : "Eksekusi Endpoint"}
                </button>
              </div>
            </div>

            {/* Response Viewer */}
            <div className="bg-[#1e1f29]/30 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 overflow-hidden flex flex-col min-h-[300px]">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-black/20">
                <h3 className="text-sm font-semibold text-white/80 flex items-center gap-2">
                  <ExternalLink className="w-4 h-4 text-emerald-400 drop-shadow-[0_0_5px_currentColor]" />
                  Terminal Log & Response Viewer
                </h3>
              </div>
              <div className="p-5 overflow-auto flex-1 font-mono text-xs text-slate-300 bg-black/10">
                {!responseLog ? (
                  <div className="h-full flex flex-col opacity-50 items-center justify-center text-white/40">
                    <p>Menunggu eksekusi endpoint...</p>
                  </div>
                ) : (
                  responseLog.status === "error" ? (
                    <div className="text-red-400 flex flex-col gap-2">
                      <div className="flex items-center gap-2 font-semibold">
                        <ServerCrash className="w-4 h-4" /> Error Eksekusi:
                      </div>
                      <pre className="whitespace-pre overflow-x-auto bg-red-950/20 p-4 rounded-xl border border-red-500/20 shadow-inner text-red-300">
                        {responseLog.message}
                      </pre>
                    </div>
                  ) : (
                    <div className="text-emerald-400 flex flex-col gap-2">
                      <div className="flex items-center gap-2 font-semibold text-emerald-300 mb-2 drop-shadow-[0_0_5px_currentColor]">
                        <CheckCircle2 className="w-4 h-4" /> Eksekusi Sukses
                      </div>
                      {typeof responseLog.data?._note === "string" && responseLog.data._note.trim() ? (
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/10 px-4 py-3 text-emerald-300">
                          {responseLog.data._note}
                        </div>
                      ) : null}
                      {Array.isArray(responseLog.data?._warnings) && responseLog.data._warnings.length > 0 ? (
                        <div className="rounded-xl border border-amber-500/20 bg-amber-950/10 px-4 py-3 text-amber-200">
                          <p className="font-semibold text-amber-300">Peringatan Parser / Eksekusi</p>
                          <div className="mt-2 flex flex-col gap-1 text-[11px]">
                            {responseLog.data._warnings.slice(0, 20).map((warning: string, index: number) => (
                              <p key={`${warning}-${index}`}>{warning}</p>
                            ))}
                            {responseLog.data._warnings.length > 20 ? (
                              <p className="text-amber-300/80">
                                +{responseLog.data._warnings.length - 20} peringatan lain.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      {Array.isArray(responseLog.data?.d) && responseLog.data.d.length > 0 ? (
                        <div className="overflow-x-auto border border-emerald-500/20 rounded-xl mt-2 mb-2 pb-2 bg-black/20 shadow-inner">
                          <table className="w-full text-left text-emerald-400 border-collapse">
                            <thead className="bg-emerald-900/30 text-emerald-300 border-b border-emerald-500/20">
                              <tr>
                                {Array.from(new Set(responseLog.data.d.flatMap((row: any) => Object.keys(row || {})))).map(key => (
                                  <th key={key as string} className="px-5 py-3 font-semibold border-b border-emerald-900/50 whitespace-nowrap">{String(key)}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {responseLog.data.d.slice(0, 50).map((row: any, i: number) => (
                                <tr key={i} className="hover:bg-emerald-900/20 transition-colors border-b border-emerald-900/20 last:border-0">
                                  {Array.from(new Set(responseLog.data.d.flatMap((row: any) => Object.keys(row || {})))).map(key => {
                                    const k = key as string;
                                    return (
                                    <td key={k} className="px-5 py-2.5 opacity-90 whitespace-nowrap" title={typeof row[k] === "object" ? JSON.stringify(row[k]) : String(row[k])}>
                                      {typeof row[k] === "object" ? JSON.stringify(row[k]) : String(row[k])}
                                    </td>
                                  )})}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="mt-3 text-emerald-500/70 text-[10px] text-center italic w-full">
                            Menampilkan mode Tabel ({responseLog.data.d.length} Baris Data). Filter kolom terbatas 50 row visualisasi.
                          </p>
                        </div>
                      ) : (
                        <pre className="whitespace-pre overflow-x-auto text-emerald-400 bg-emerald-950/10 p-4 rounded-xl border border-emerald-500/20 shadow-inner">
                          {JSON.stringify(responseLog.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  )
                )}
              </div>
            </div>

          </div>
        </div>

        {duplicateReview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-5xl rounded-2xl border border-amber-400/20 bg-[#15161f] shadow-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-amber-500/10">
                <h3 className="text-lg font-semibold text-white">Review Potensi Pembayaran Ganda</h3>
                <p className="text-sm text-white/60 mt-1">
                  Sistem menemukan baris yang mirip dengan upload lain atau muncul lebih dari sekali di batch ini.
                  Centang baris yang tetap ingin diproses.
                </p>
              </div>
              <div className="px-6 py-4 text-xs text-white/60 border-b border-white/10 bg-black/20 flex items-center justify-between">
                <span>{duplicateReview.reviewRows.length} kandidat perlu direview</span>
                <span>{Object.values(duplicateReview.selections).filter(Boolean).length} dipilih untuk lanjut</span>
              </div>
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full text-left text-sm text-slate-200">
                  <thead className="sticky top-0 bg-[#1b1c26] border-b border-white/10 text-white/70">
                    <tr>
                      <th className="px-4 py-3">Pilih</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Invoice</th>
                          <th className="px-4 py-3">Tanggal</th>
                          <th className="px-4 py-3">Nilai</th>
                          <th className="px-4 py-3">Alasan</th>
                          <th className="px-4 py-3">Referensi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicateReview.reviewRows
                      .sort((a, b) => a.originalIndex - b.originalIndex)
                      .map((item) => (
                        <tr key={item.reviewId} className="border-b border-white/5 hover:bg-white/[0.03]">
                          <td className="px-4 py-3 align-top">
                            <input
                              type="checkbox"
                              checked={!!duplicateReview.selections[item.reviewId]}
                              onChange={(e) => handleDuplicateSelectionChange(item.reviewId, e.target.checked)}
                              className="h-4 w-4 rounded border-white/20 bg-black/40 text-amber-400 focus:ring-amber-400"
                            />
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="font-medium text-white">{item.customerNo || "-"}</div>
                            <div className="text-xs text-white/45">{item.paymentMethod}</div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="font-mono text-xs break-all">{item.invoiceNo || "-"}</div>
                            {item.recommended && (
                              <div className="mt-2 inline-flex rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                                Rekomendasi
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top">{item.transDate || "-"}</td>
                          <td className="px-4 py-3 align-top">{item.amount.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-wrap gap-2">
                              {item.reasons.map((reason) => (
                                <span key={`${item.reviewId}-${reason}`} className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                  {getDuplicateReasonLabel(reason)}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            {item.matchedReceiptNumbers.length > 0 ? (
                              <div className="space-y-1">
                                {item.matchedReceiptNumbers.slice(0, 5).map((receiptNo) => (
                                  <div key={`${item.reviewId}-${receiptNo}`} className="font-mono text-[11px] text-white/75 break-all">
                                    {receiptNo}
                                  </div>
                                ))}
                                {item.matchedReceiptNumbers.length > 5 && (
                                  <div className="text-[10px] text-white/45">
                                    +{item.matchedReceiptNumbers.length - 5} receipt lain
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-white/35">Log lokal saja</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-black/20 px-6 py-4">
                <p className="text-xs text-white/45">
                  Baris yang tidak dicentang tidak akan diproses pada eksekusi ini.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setDuplicateReview(null)}
                    className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-white/70 hover:bg-white/5"
                  >
                    Tutup
                  </button>
                  <button
                    onClick={handleConfirmDuplicateReview}
                    className="rounded-xl bg-amber-500 px-5 py-2 text-sm font-bold text-slate-950 hover:bg-amber-400"
                  >
                    Lanjutkan Yang Dicentang
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
  const buildSalesReceiptIdempotencyPayload = (row: any) => {
    const normalizeMoney = (value: any) => Number((Number(value) || 0).toFixed(2));
    const detailSignature = (row.detailInvoice || [])
      .map((detail: any) => {
        const discountSignature = (detail.detailDiscount || [])
          .map((discount: any) => [
            String(discount.accountNo || "").trim(),
            String(discount.discountNotes || "").trim(),
            normalizeMoney(discount.amount)
          ].join(":"))
          .sort()
          .join("&");
        return [
          String(detail.invoiceNo || "").trim(),
          normalizeMoney(detail.paymentAmount),
          discountSignature
        ].join("|");
      })
      .sort()
      .join(";");

    const invoices = (row.detailInvoice || [])
      .map((detail: any) => String(detail.invoiceNo || "").trim())
      .filter(Boolean)
      .sort()
      .join(",");

    const appliedAmount = Number(
      (row.detailInvoice || []).reduce((sum: number, detail: any) => {
        const discountTotal = (detail.detailDiscount || []).reduce((discountSum: number, discount: any) => discountSum + normalizeMoney(discount.amount), 0);
        return sum + normalizeMoney(detail.paymentAmount) + discountTotal;
      }, 0).toFixed(2)
    );

    return {
      key: `PAY_${String(row.customerNo || "").trim()}_${String(row.transDate || "").trim()}_${detailSignature}`,
      invoiceNo: invoices,
      customerNo: row.customerNo,
      amount: appliedAmount,
      transDate: String(row.transDate || "").trim(),
      paymentMethod: row.paymentMethod,
      source: 'Excel Upload'
    };
  };
