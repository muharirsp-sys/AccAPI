/**
 * Tujuan: UI API Wrapper Accurate termasuk parser Excel bulk yang membentuk payload transaksi manual/bulk-save.
 * Caller: App Router dashboard `app/(dashboard)/api-wrapper/page.tsx` dan interaksi user di halaman API Wrapper.
 * Dependensi: `accurateRoutes`, `accurateFetch`, parser workbook per-route, Accurate OAuth/session dari browser, parser `xlsx`, toast `sonner`, route idempotency Next, `DatePickerField`, `Dialog` native bersama, `lib/pelunasan/*` (parser Format Pelunasan, retur, cari faktur, alokasi, payload, pratinjau duplikat — dipindah dari halaman ini di S6e-1).
 * Main Functions: `Home`, `handleLoginAccurate`, `fetchDatabases`, `handleOpenDatabase`, `handleDownloadTemplate`, `handleExecute`.
 * Side Effects: HTTP call ke Accurate route handler/proxy, baca file Excel lokal, dispatch parser workbook khusus per route, deteksi format pelunasan walau `Total.Trx` kosong, normalisasi lookup invoice/retur termasuk variasi SRB tanpa spasi, susun payload bulk-save, keluarkan laporan manual follow-up untuk retur/pot.lain yang gagal diproses, preview/lock idempotency SQLite, cek histori sales receipt Accurate, konfirmasi hasil error ke histori Accurate, tampilkan review duplicate, logging debug ke response UI.
 */
"use client";

import { useState, useEffect } from "react";
import { Key, Upload, FileJson, Play, ServerCrash, ExternalLink, Settings2, Database, FileSpreadsheet, CheckCircle2, Loader2, LogOut, CalendarIcon } from "lucide-react";
import { toast } from "sonner";
import { accurateRoutes } from "@/config/accurateRoutes";
import { accurateFetch, classifyWriteError } from "@/lib/apiFetcher";
import { buildSalesReceiptIdempotencyPayload } from "@/lib/sales-receipt-fingerprint";
import { isLockRequired, overrideKeysNeeded, salesReceiptRowReports } from "@/lib/sales-receipt-upload";
import DatePickerField from "@/components/ui/DatePickerField";
import Dialog from "@/components/ui/Dialog";
import { deteksiFormatPelunasan, parsePelunasan } from "@/lib/pelunasan/parser";
import { normalizePayloadMoney, tanggalKemarin } from "@/lib/pelunasan/payload";
import { pratinjauDuplikat, pratinjauRiwayatAccurate, type DuplicateConflictReason, type DuplicateReviewEntry } from "@/lib/pelunasan/pratinjau-ganda";
import { workbookRouteParsers } from "./parsers";

type RouteKey = keyof typeof accurateRoutes;

type LogState = {
  status: "success" | "error";
  message?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
};


type DuplicateReviewState = {
  routeKey: RouteKey;
  passthroughRows: Array<{ originalIndex: number; row: Record<string, unknown> }>;
  reviewRows: DuplicateReviewEntry[];
  selections: Record<string, boolean>;
};

// Pastikan mengarah ke client ID yang sama di .env
// ponytail: fallback client id hardcoded dihapus — kalau env belum di-set, Accurate menolak
// dengan "Client ID tidak tepat" dan penyebabnya tidak kelihatan. Lebih baik gagal bersuara.
const NEXT_PUBLIC_CLIENT_ID = process.env.NEXT_PUBLIC_ACCURATE_CLIENT_ID || "";
const REDIRECT_URI = process.env.NEXT_PUBLIC_ACCURATE_REDIRECT_URI || "http://localhost:3000/api/auth/callback";

export default function Home() {

  const [isAccurateConnected, setIsAccurateConnected] = useState(false);
  const [dbHost, setDbHost] = useState("");

  const [isKeySaved, setIsKeySaved] = useState(false);
  const [isMounted, setIsMounted] = useState(false); // To prevent hydration mismatch

  // Database Selection State
  const [databases, setDatabases] = useState<Array<{ id: string | number; alias: string }>>([]);
  const [selectedDb, setSelectedDb] = useState("");
  const [isFetchingDbs, setIsFetchingDbs] = useState(false);

  const [selectedRoute, setSelectedRoute] = useState<RouteKey>("salesInvoice");
  const [inputMode, setInputMode] = useState<"manual" | "excel">("manual");
  const [payloadStr, setPayloadStr] = useState("");
  const [responseLog, setResponseLog] = useState<LogState | null>(null);
  const [duplicateReview, setDuplicateReview] = useState<DuplicateReviewState | null>(null);
  const [isLoading, setIsLoading] = useState(false);


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

  const [trxDate, setTrxDate] = useState<string>(tanggalKemarin());

  // Initial Load & OAuth Callback handler
  useEffect(() => {
    setIsMounted(true); // Ensure client-side only rendering for heavy interactive parts

    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("accurate") === "connected") {
      toast.success("Login Accurate Berhasil! Silakan pilih database.");
      window.history.replaceState(null, "", window.location.pathname);
    }

    loadAccurateSession();
    setPayloadStr(JSON.stringify(accurateRoutes[selectedRoute].samplePayload, null, 2));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoginAccurate = () => {
    if (!NEXT_PUBLIC_CLIENT_ID) {
      toast.error("NEXT_PUBLIC_ACCURATE_CLIENT_ID belum di-set. Isi di .env.local lalu restart server.");
      return;
    }
    const params = new URLSearchParams({
      client_id: NEXT_PUBLIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "auto_number_save auto_number_view branch_save branch_view currency_save currency_view customer_save customer_view customer_category_save customer_category_view customer_claim_save customer_claim_view delivery_order_save delivery_order_view department_save department_view employee_view employee_save finished_good_slip_save finished_good_slip_view item_save item_view item_adjustment_save item_adjustment_view item_category_save item_category_view item_transfer_save item_transfer_view job_order_save job_order_view material_adjustment_save material_adjustment_view payment_term_save payment_term_view project_save project_view purchase_invoice_save purchase_invoice_view purchase_order_save purchase_order_view purchase_payment_save purchase_payment_view purchase_requisition_save purchase_requisition_view purchase_return_save purchase_return_view receive_item_save receive_item_view sales_invoice_save sales_invoice_view sales_order_save sales_order_view sales_quotation_save sales_quotation_view sales_receipt_save sales_receipt_view sales_return_save sales_return_view stock_opname_order_save stock_opname_order_view stock_opname_result_save stock_opname_result_view tax_save tax_view vendor_save vendor_view vendor_category_save vendor_category_view vendor_claim_save vendor_claim_view vendor_price_save vendor_price_view warehouse_view warehouse_save bank_statement_view bank_statement_save",
    });
    window.location.href = `https://account.accurate.id/oauth/authorize?${params.toString()}`;
  };

  const loadAccurateSession = async () => {
    try {
      const res = await fetch("/api/auth/accurate-session");
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Gagal memuat sesi Accurate.");

      setIsAccurateConnected(Boolean(data.connected));
      setIsKeySaved(Boolean(data.databaseConnected));
      setDbHost(data.sessionHost || "");

      if (data.connected && !data.databaseConnected) {
        fetchDatabases();
      }
    } catch (e: unknown) {
      setIsAccurateConnected(false);
      setIsKeySaved(false);
      setDbHost("");
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/accurate-session", { method: "DELETE" });
    } catch {
      // UI state is cleared even if server session has already expired.
    }
    setIsAccurateConnected(false);
    setDbHost("");
    setIsKeySaved(false);
    setDatabases([]);
    toast.info("Anda telah log out dari sesi aplikasi.");
  };

  const fetchDatabases = async () => {
    setIsFetchingDbs(true);
    try {
      const res = await fetch("/api/auth/db-list");
      const data = await res.json();
      if (data.error || !data.d) throw new Error(data.error || "Gagal mengambil database.");
      setDatabases(data.d);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
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
      const dbMeta = databases.find((db) => String(db.id) === String(selectedDb));
      const res = await fetch("/api/auth/open-db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedDb, alias: dbMeta?.alias || null }),
      });
      const data = await res.json();
      if (data.error || !data.host || !data.session) throw new Error(data.error || "Gagal membuka database.");

      setDbHost(data.host);
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
        const XLSX = await import("xlsx");
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

        // S6e-1: parser Format Pelunasan dipindah ke lib/pelunasan/ (W:275-1629 lama). Halaman hanya menampilkan
        // progres (toast), memasang payload, dan mengunduh laporan Retur Manual.
        if (deteksiFormatPelunasan(cleanedData)) {
            const hasil = await parsePelunasan(cleanedData, {
                trxDate,
                isKeySaved,
                peta: { mapTunaiAutoNum, mapTunaiBank, mapTrfAutoNum, mapTrfBank, mapBgAutoNum, mapBgBank, mapPot1Account, mapPot2Account, mapPot3Account },
                accurateFetch,
                lapor: (jenis, pesan, opsi) => { toast[jenis](pesan, opsi); },
            });
            const manualRows = hasil.manualRows;
            if (manualRows) {
                setTimeout(() => {
                    try {
                        const wsManual = XLSX.utils.json_to_sheet(manualRows);
                        const wbManual = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(wbManual, wsManual, "Retur Manual");
                        XLSX.writeFile(wbManual, `Retur_PotLain_Manual_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
                    } catch (manualErr) {
                        console.error("Gagal membuat laporan retur manual", manualErr);
                    }
                }, 800);
            }
            setPayloadStr(JSON.stringify(hasil.payload, null, 2));
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

    const XLSX = await import("xlsx");
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
    // AM-025: kiriman sebelumnya macet >15 menit atau tak diketahui hasilnya — mungkin SUDAH masuk Accurate.
    if (reason === "UNKNOWN_OUTCOME") return "Hasil kiriman sebelumnya tidak diketahui — cek Accurate dulu";
    return "Masih diproses dalam 15 menit terakhir";
  };

  // S6e-1: logic pratinjau dipindah ke lib/pelunasan/pratinjau-ganda.ts (W:1903-2053 lama); halaman hanya menyuntik I/O.
  const previewAccurateSalesReceiptHistory = (rows: any[]) => pratinjauRiwayatAccurate(rows, accurateFetch);

  const previewSalesReceiptDuplicates = (rows: any[], routeKey: RouteKey) => pratinjauDuplikat(rows, routeKey, {
    accurateFetch,
    pratinjauKunci: async (keysPayload) => {
      const previewRes = await fetch('/api/idempotency/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keysPayload, preview: true })
      });
      const previewData = await previewRes.json();
      if (!previewRes.ok) throw new Error(previewData.error || "Gagal membaca kandidat duplikat.");
      return previewData;
    },
  });

  const executeBulkPayload = async (
    rows: any[],
    routeConfig: typeof accurateRoutes[RouteKey],
    duplicateOptions?: { allowDuplicateKeys?: string[]; allowLockedKeys?: string[]; overrideReason?: string }
  ) => {
    // AM-041: dulu `document.location.pathname` — URL HALAMAN, yang selalu "/api-wrapper",
    // sehingga lock idempotency, penandaan hasil, dan preview duplikat sales-receipt tidak
    // pernah berjalan. Yang menentukan adalah endpoint yang dieksekusi.
    const isSalesReceipt = routeConfig.path.includes('/sales-receipt/');
    // AM-050/AM-024: lock milik request ini — wajib untuk kirim lewat proxy dan untuk /complete.
    let idempotencyLockId: string | null = null;
    if (isSalesReceipt) {
      toast.loading("Mengunci batch idempotency...", { id: 'exec' });
      const keysPayload = rows.map((row: any) => buildSalesReceiptIdempotencyPayload(row));
      const lockRes = await fetch('/api/idempotency/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: keysPayload,
          allowDuplicateKeys: duplicateOptions?.allowDuplicateKeys || [],
          allowLockedKeys: duplicateOptions?.allowLockedKeys || [],
          overrideReason: duplicateOptions?.overrideReason || ""
        })
      });
      const lockData = await lockRes.json();
      if (!lockRes.ok) throw new Error(lockData.error || "Gagal mengunci idempotency.");
      if (Array.isArray(lockData.blockedKeys) && lockData.blockedKeys.length > 0) {
        throw new Error("Beberapa baris berubah status duplikat saat review. Buka ulang review lalu pilih kembali.");
      }
      if (!lockData.lockId) throw new Error("Lock idempotency tidak diterbitkan server — tidak ada yang dikirim.");
      idempotencyLockId = lockData.lockId;
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
    const confirmedReceiptNumbersByKey = new Map<string, string[]>();

    // outcome "UNKNOWN": galat tanpa jawaban Accurate (timeout/jaringan) — kiriman MUNGKIN sudah tersimpan,
    // jadi upload berikutnya diblokir sampai manusia mengecek (dulu FAILED -> dicoba ulang otomatis).
    const markIdempotency = async (row: any, outcome: boolean | "UNKNOWN") => {
      if (!isSalesReceipt) return;
      try {
        const rowKey = buildSalesReceiptIdempotencyPayload(row).key;
        // AM-025: key yang di-override kini dikunci ulang oleh lock, jadi hasilnya WAJIB dicatat;
        // SUCCESS yang dikirim ulang tidak tersentuh (complete hanya menaikkan, tak pernah menurunkan).
        fetch('/api/idempotency/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: [rowKey], lockId: idempotencyLockId, status: outcome === "UNKNOWN" ? 'UNKNOWN' : outcome ? 'SUCCESS' : 'FAILED' })
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

      // Tinjauan S6-0a + C11: hasil sales-receipt dicatat SERVER (proxy, classifySalesReceiptReply); di sini hanya
      // laporan. Penolakan Accurate = TIDAK PASTI (bukan "berhasil terposting", bukan gagal yang dikirim ulang).
      // Mode individual & self-heal <= Rp 100 TIDAK dipakai untuk sales-receipt (proxy menolaknya tanpa override
      // Finance; kirim koreksi otomatis = risiko pelunasan ganda).
      const reportSalesReceiptChunk = async (data: unknown, noAnswer: string) => {
        let unresolved = 0;
        const reports = salesReceiptRowReports(chunkPayload.length, data, noAnswer);
        for (let idx = 0; idx < chunkPayload.length; idx++) {
          const row = chunkPayload[idx];
          const mainId = row.invoiceNo || row.customerNo || `Baris Eksekusi ${start + idx + 1}`;
          if (reports[idx].ok) {
            combinedResults.push(reports[idx].item ?? { s: true });
            markIdempotency(row, true);
            continue;
          }
          const matchedReceiptNumbers = await getConfirmedReceiptNumbers(row);
          if (matchedReceiptNumbers.length > 0) {
            markIdempotency(row, true);
            combinedResults.push({ s: true, _confirmedFromHistory: true, _matchedReceiptNumbers: matchedReceiptNumbers, _originalError: reports[idx].message });
            errorLogForExcel.push({
              "Paket/Batch": `Tahap ${i+1}`, "Baris Ke": start + idx + 1, "Ref / Invoice No": mainId,
              "Status": "BERHASIL (TERKONFIRMASI HISTORI ACCURATE)",
              "Pesan Error Accurate": `${reports[idx].message} | Receipt ditemukan: ${matchedReceiptNumbers.join(", ")}`
            });
            continue;
          }
          unresolved++;
          markIdempotency(row, "UNKNOWN");
          errorLogForExcel.push({
            "Paket/Batch": `Tahap ${i+1}`, "Baris Ke": start + idx + 1, "Ref / Invoice No": mainId,
            "Status": "TIDAK PASTI (butuh pemeriksaan/override Finance)",
            "Pesan Error Accurate": reports[idx].message
          });
        }
        if (unresolved > 0) errorCount++;
      };

      try {
        const data = await accurateFetch(routeConfig.path, routeConfig.method, chunkPayload, { idempotencyLockId });

        if (isSalesReceipt) {
          await reportSalesReceiptChunk(data, "");
        } else if (Array.isArray(data)) {
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

        if (isSalesReceipt && isLockRequired(chunkErr)) {
          // Proxy menolak SEBELUM kirim (baris di luar lock / butuh override): pasti tidak terkirim -> FAILED
          // (server hanya menerimanya untuk baris PROCESSING milik lock ini).
          chunkPayload.forEach((row, idx) => {
            markIdempotency(row, false);
            errorLogForExcel.push({
              "Paket/Batch": `Tahap ${i+1}`, "Baris Ke": start + idx + 1,
              "Ref / Invoice No": row.invoiceNo || row.customerNo || `Baris Eksekusi ${start + idx + 1}`,
              "Status": "DITOLAK PENJAGA DUPLIKAT (tidak dikirim)",
              "Pesan Error Accurate": `${chunkErr.message} — tidak ada yang dikirim ke Accurate; kirim ulang butuh override Finance (finance.override_duplicate) lewat dialog review.`
            });
          });
          errorCount++;
        } else if (isSalesReceipt) {
          await reportSalesReceiptChunk(chunkErr?.rawErrorObject, chunkErr?.message || "galat jaringan");
        } else if (chunkErr.rawDetails && Array.isArray(chunkErr.rawDetails)) {
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
                const indData = await accurateFetch(routeConfig.path, routeConfig.method, [row], { idempotencyLockId });
                // Hasil PER ITEM: amplop bulk-save bisa s:true dengan item d[0].s:false (H09).
                const indItem = Array.isArray(indData) ? indData[0] : Array.isArray(indData?.d) ? indData.d[0] : indData;
                const isSuccess = !!indItem?.s;

                if (isSuccess) {
                  combinedResults.push(indItem);
                  markIdempotency(row, true); // AM-041 review: tanpa ini baris sukses tertahan PROCESSING
                } else {
                  const indReasonStr = extractReasonStr(Array.isArray(indData) ? indData[0] : indData, "Error validasi individual");
                  const match = indReasonStr.match(/"([^"]+)"/);
                  await processAutoHeal(row, match ? match[1] : null, indReasonStr, i, start, idx, false);
                }
              } catch (indErr: any) {
                const indReasonStr = indErr.rawDetails && indErr.rawDetails.length > 0 ? extractReasonStr(indErr.rawDetails[0], indErr.message) : indErr.message;
                const match = indReasonStr.match(/"([^"]+)"/);
                await processAutoHeal(row, match ? match[1] : null, indReasonStr, i, start, idx, false, classifyWriteError(indErr).kind === "unknown");
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

          // noAnswer: kiriman baris ini gagal TANPA jawaban Accurate (timeout/jaringan) — hasil tak diketahui.
          async function processAutoHeal(row: any, failedInvoiceNo: string | null, reasonStr: string, chunkIdx: number, startIdx: number, rowIdx: number, isOverall: boolean, noAnswer = false) {
            const mainId = row.invoiceNo || row.customerNo || row.bankNo || row.description || `Baris Eksekusi ${startIdx + rowIdx + 1}`;
            let isHealed = false;
            let unknownOutcome = noAnswer;
            let repostAttempted = false;

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

                    repostAttempted = true;
                    const retryData = await accurateFetch(routeConfig.path, routeConfig.method, [healedRow], { idempotencyLockId });
                    // Hasil PER ITEM seperti mode individu (H09): amplop s:true bisa membawa d[0].s:false —
                    // dulu dibaca sukses -> baris ditandai SUCCESS padahal koreksi ditolak (review AM-025 M1).
                    const retryItem = Array.isArray(retryData) ? retryData[0] : Array.isArray(retryData?.d) ? retryData.d[0] : retryData;
                    const isRetrySuccess = !!retryItem?.s;

                    if (isRetrySuccess) {
                      isHealed = true;
                      combinedResults.push(retryItem);
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
                // Kiriman koreksi yang gagal tanpa jawaban bisa SUDAH tersimpan (review AM-025 F4).
                if (repostAttempted && classifyWriteError(healErr).kind === "unknown") unknownOutcome = true;
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

              markIdempotency(row, unknownOutcome ? "UNKNOWN" : false);
              chunkHadUnresolvedFailure = true;
              errorLogForExcel.push({
                "Paket/Batch": `Tahap ${chunkIdx+1}`,
                "Baris Ke": startIdx + rowIdx + 1 + (isOverall ? " (Penyebab Blok)" : ""),
                "Ref / Invoice No": mainId,
                "Status": unknownOutcome ? "TIDAK DIKETAHUI (cek Accurate sebelum kirim ulang)" : "Gagal",
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

            // AM-025 review F4: tanpa jawaban Accurate dan tidak ada di histori (yang dibatasi & bisa ikut
            // gagal) bukan bukti gagal — tandai UNKNOWN agar upload ulang menunggu pengecekan manusia.
            // Penolakan beramplop (s:false + d) = pasti tidak tersimpan -> FAILED (review re-review LOW).
            const tanpaJawaban = classifyWriteError(chunkErr).kind === "unknown";
            markIdempotency(row, tanpaJawaban ? "UNKNOWN" : false);
            chunkHadUnresolvedFailure = true;
            errorLogForExcel.push({
              "Paket/Batch": `Tahap ${i+1}`,
              "Baris Ke": start + idx + 1,
              "Ref / Invoice No": mainId,
              "Status": tanpaJawaban ? "TIDAK DIKETAHUI (cek Accurate sebelum kirim ulang)" : "Gagal",
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
        setTimeout(async () => {
          toast("Mengunduh Excel Log Error...", { icon: "📥" });
          try {
            const XLSX = await import("xlsx");
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

    // Tinjauan S6-0a: hanya override yang BENAR-BENAR dipakai server — baris pertama duplikat-dalam-unggahan
    // (pilihan bawaan) tidak butuh alasan; baris riwayat Accurate saja tidak memakai override lock.
    const { allowDuplicateKeys, allowLockedKeys } = overrideKeysNeeded(
      [...duplicateReview.passthroughRows, ...selectedReviewRows].map((item) => buildSalesReceiptIdempotencyPayload(item.row).key),
      selectedReviewRows.filter((item) => item.reasons.includes("DUPLICATE_IN_UPLOAD")).map((item) => item.key),
      selectedReviewRows
        .filter((item) => item.reasons.includes("ALREADY_SUCCESS") || item.reasons.includes("STILL_PROCESSING") || item.reasons.includes("UNKNOWN_OUTCOME"))
        .map((item) => item.key));

    // D-18 (owner): override = membuka kiriman ulang ke Accurate — hanya Finance (server menolak 403 tanpa
    // finance.override_duplicate) dan alasan wajib tercatat di jejak override.
    let overrideReason = "";
    if (allowDuplicateKeys.length > 0 || allowLockedKeys.length > 0) {
      const typed = window.prompt(`Alasan meng-override ${allowDuplicateKeys.length + allowLockedKeys.length} blok duplikat (min. 15 karakter). Hanya kewenangan Finance.`);
      if (!typed || typed.trim().length < 15) {
        toast.error("Alasan override minimal 15 karakter. Tidak ada yang dikirim.");
        return;
      }
      overrideReason = typed.trim();
    }

    const routeConfig = accurateRoutes[duplicateReview.routeKey];
    setDuplicateReview(null);
    setIsLoading(true);

    try {
      await executeBulkPayload(finalRows, routeConfig, { allowDuplicateKeys, allowLockedKeys, overrideReason });
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
          if (routeConfig.path.includes('/sales-receipt/')) { // AM-041, lihat executeBulkPayload
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

              {!isAccurateConnected ? (
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
                        <DatePickerField
                           value={trxDate}
                           onChange={setTrxDate}
                           ariaLabel="Tanggal transaksi default"
                           className="w-[180px] py-2 text-white focus:border-indigo-500"
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

        <Dialog
          open={Boolean(duplicateReview)}
          onClose={() => setDuplicateReview(null)}
          labelledBy="duplicate-review-title"
          describedBy="duplicate-review-description"
          className="w-full max-w-5xl overflow-hidden rounded-2xl border border-amber-400/20 bg-[#15161f] shadow-2xl"
        >
          {duplicateReview && (
            <>
              <div className="px-6 py-4 border-b border-white/10 bg-amber-500/10">
                <h3 id="duplicate-review-title" tabIndex={-1} autoFocus className="text-lg font-semibold text-white">Tinjau Potensi Pembayaran Ganda</h3>
                <p id="duplicate-review-description" className="text-sm text-white/60 mt-1">
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
                              aria-label={`Pilih ${item.customerNo || "customer tanpa kode"}, invoice ${item.invoiceNo || "tanpa nomor"}`}
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
                              <div className="mt-2 inline-flex rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300 neon-text-success">
                                Rekomendasi
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top">{item.transDate || "-"}</td>
                          <td className="px-4 py-3 align-top">{item.amount.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-wrap gap-2">
                              {item.reasons.map((reason) => (
                                <span key={`${item.reviewId}-${reason}`} className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300 neon-text-warn">
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
            </>
          )}
        </Dialog>

      </div>
    </div>
  );
}
