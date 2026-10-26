/**
 * Tujuan: UI API Wrapper Accurate (Konsol) termasuk parser Excel bulk yang membentuk payload transaksi manual/bulk-save.
 *   Tampilan Fiori (audit desain 001 M1): tiap kiriman tulis lewat ConfirmDialog (endpoint, jumlah baris, database aktif),
 *   hasil analisis berkas dibedakan dari jawaban Accurate, override duplikat lewat ConfirmDialog beralasan (min 15).
 * Caller: App Router dashboard `app/(dashboard)/api-wrapper/page.tsx` dan interaksi user di halaman API Wrapper.
 * Dependensi: `accurateRoutes`, `accurateFetch`, parser workbook per-route, Accurate OAuth/session dari browser, parser `xlsx`, toast `sonner`, route idempotency Next, `Dialog` native bersama, komponen Fiori (`components/fiori/*`), `lib/tampil` (KOSONG), `lib/pelunasan/*` (parser Format Pelunasan, retur, cari faktur, alokasi, payload, pratinjau duplikat — dipindah dari halaman ini di S6e-1; kirim sales-receipt `lib/pelunasan/kirim.ts`, S6e-2).
 * Main Functions: `Home`, `terapkanSesi` (kartu `SesiAccurate` bersama /sesi-accurate: masuk ber-`state`, pilih database, keluar — S7-sesi), `handleDownloadTemplate`, `handleExecute` (dipanggil sesudah `bukaKirim` + ConfirmDialog), `handleConfirmDuplicateReview` + `kirimHasilTinjauan`.
 * Side Effects: HTTP call ke Accurate route handler/proxy, baca file Excel lokal, dispatch parser workbook khusus per route, deteksi format pelunasan walau `Total.Trx` kosong, normalisasi lookup invoice/retur termasuk variasi SRB tanpa spasi, susun payload bulk-save, keluarkan laporan manual follow-up untuk retur/pot.lain yang gagal diproses, preview/lock idempotency SQLite, cek histori sales receipt Accurate, konfirmasi hasil error ke histori Accurate HANYA untuk jenis dokumen yang sama (`pemastiRiwayatTulis`; jenis lain tetap TIDAK DIKETAHUI), tampilkan review duplicate, unduh Excel log galat (otomatis + tombol unduh ulang), logging debug ke response UI.
 */
"use client";

import { useState, useEffect, useId } from "react";
import { Download, FileJson, FileSpreadsheet, Send, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { accurateRoutes } from "@/config/accurateRoutes";
import { accurateFetch, classifyWriteError } from "@/lib/apiFetcher";
import { buildSalesReceiptIdempotencyPayload } from "@/lib/sales-receipt-fingerprint";
import { overrideKeysNeeded } from "@/lib/sales-receipt-upload";
import { kirimPelunasan, type BarisHasil, type OverrideKirim } from "@/lib/pelunasan/kirim";
import type { Bebas } from "@/lib/pelunasan/sel";
import Dialog from "@/components/ui/Dialog";
import { deteksiFormatPelunasan, parsePelunasan } from "@/lib/pelunasan/parser";
import { normalizePayloadMoney, tanggalKemarin } from "@/lib/pelunasan/payload";
import { pemastiRiwayatTulis, pratinjauDuplikat, pratinjauRiwayatAccurate, type DuplicateConflictReason, type DuplicateReviewEntry } from "@/lib/pelunasan/pratinjau-ganda";
import { workbookRouteParsers } from "./parsers";
import { FioriScope } from "@/components/fiori/Scope";
import { Button, EmptyState, KeyValues, MessageStrip, Section, Skeleton, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { SesiAccurate, type StatusSesi } from "@/components/accurate/SesiAccurate";
import { KOSONG } from "@/lib/tampil";

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

/** Fakta dialog Kirim, dihitung dari payload yang akan dipakai `handleExecute` (hanya tampilan). */
type KonfirmasiKirim = { path: string; baris: number; massal: boolean; contohBawaan: boolean; pelunasan: boolean };

/** Override duplikat menunggu alasan (D-18): hasil hitung `handleConfirmDuplicateReview` yang dulu dipakai sesudah window.prompt. */
type OverrideTertunda = {
  finalRows: Record<string, unknown>[];
  keys: { allowDuplicateKeys: string[]; allowLockedKeys: string[]; allowHistoryKeys: string[] };
  blok: number;
  baris: DuplicateReviewEntry[];
};

const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daftarRingkas = (xs: string[], maks = 5) => (xs.length <= maks ? xs.join(", ") : `${xs.slice(0, maks).join(", ")} dan ${xs.length - maks} lainnya`);
const selTeks = (v: unknown) => (v === undefined || v === null || v === "" ? KOSONG : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function Home() {

  // Sesi Accurate dibaca kartu bersama `SesiAccurate` (S7-sesi); halaman ini hanya menyimpan hasilnya untuk mengunci eksekusi.
  const [isKeySaved, setIsKeySaved] = useState(false);
  const [isMounted, setIsMounted] = useState(false); // To prevent hydration mismatch
  // Kabar callback OAuth (`?accurate=…&alasan=<kode>`) — ditampilkan kartu sebagai MessageStrip.
  const [kabarUrl, setKabarUrl] = useState<{ accurate: string | null; alasan: string | null }>({ accurate: null, alasan: null });

  // S6e-2 butir 2: database yang terbuka saat halaman dimuat/dibuka — dikirim sebagai expectedDatabaseId (sesi berganti di tab lain = 409).
  const [openDbId, setOpenDbId] = useState("");

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

  // State tampilan (audit desain 001 M1). Tidak ikut dikirim ke Accurate.
  const [openDbAlias, setOpenDbAlias] = useState(""); // nama database aktif dari kartu SesiAccurate, untuk dialog Kirim
  const [sesiDibaca, setSesiDibaca] = useState(false); // strip "masuk dulu" baru tampil sesudah kartu selesai membaca sesi
  const [konfirmasiKirim, setKonfirmasiKirim] = useState<KonfirmasiKirim | null>(null);
  const [galatPayload, setGalatPayload] = useState<string | null>(null);
  const [override, setOverride] = useState<OverrideTertunda | null>(null);
  const [galatTinjau, setGalatTinjau] = useState<string | null>(null);
  const [logGalat, setLogGalat] = useState<Record<string, unknown>[] | null>(null);
  const idTinjau = useId();

  // Initial Load & OAuth Callback handler
  useEffect(() => {
    setIsMounted(true); // Ensure client-side only rendering for heavy interactive parts

    const searchParams = new URLSearchParams(window.location.search);
    setKabarUrl({ accurate: searchParams.get("accurate"), alasan: searchParams.get("alasan") });

    setPayloadStr(JSON.stringify(accurateRoutes[selectedRoute].samplePayload, null, 2));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const terapkanSesi = (sesi: StatusSesi | null) => {
    setIsKeySaved(Boolean(sesi?.databaseConnected));
    setOpenDbId(sesi?.databaseId ?? "");
    setOpenDbAlias(sesi?.databaseAlias ?? "");
    setSesiDibaca(true);
  };

  const handleChangeRoute = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const route = e.target.value as RouteKey;
    setSelectedRoute(route);
    setPayloadStr(JSON.stringify(accurateRoutes[route].samplePayload, null, 2));
    setResponseLog(null);
    setLogGalat(null);
    setGalatPayload(null);
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
    if (reason === "DUPLICATE_IN_UPLOAD") return "Ganda dalam unggahan ini";
    if (reason === "ALREADY_SUCCESS") return "Sudah pernah terkirim";
    if (reason === "ACCURATE_HISTORY") return "Mirip riwayat Accurate";
    if (reason === "ACCURATE_HISTORY_UNREADABLE") return "Riwayat Accurate tidak terbaca, belum tentu aman";
    // AM-025: kiriman sebelumnya macet >15 menit atau tak diketahui hasilnya — mungkin SUDAH masuk Accurate.
    if (reason === "UNKNOWN_OUTCOME") return "Hasil kiriman sebelumnya tidak diketahui. Cek Accurate dulu";
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

  // S6e-2 butir 7: tampilan hasil kirim sales-receipt (toast, log respons, Excel galat) dari hasil per baris lib/pelunasan/kirim.ts.
  const kirimSalesReceipt = async (rows: Bebas[], override?: OverrideKirim) => {
    toast.loading("Mengunci batch idempotency...", { id: 'exec' });
    const postJson = async (url: string, body: unknown) => {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let data: unknown = null;
      try { data = await res.json(); } catch { /* bukan JSON = tanpa jawaban yang terbaca */ }
      return { status: res.status, data };
    };
    const { rows: hasil } = await kirimPelunasan(rows, {
      postJson, expectedDatabaseId: openDbId, override, cariRiwayat: previewAccurateSalesReceiptHistory,
      lapor: (p) => {
        if (p.tahap === "paket") toast.loading(`[Tahap ${p.paket}/${p.totalPaket}] Memproses baris ${p.dari}-${p.sampai}...`, { id: 'exec' });
      },
    });
    if (hasil.length === 0) {
      toast.dismiss('exec');
      return;
    }
    const STATUS: Record<Exclude<BarisHasil["outcome"], "terposting">, string> = {
      gagal: "GAGAL — TIDAK TERKIRIM (boleh diulang)",
      tidak_pasti: "TIDAK PASTI (butuh pemeriksaan Finance)",
      ditahan: "DITAHAN — MIRIP RIWAYAT ACCURATE (butuh izin Finance)",
    };
    const combinedResults: unknown[] = [];
    const errorLogForExcel: Record<string, unknown>[] = [];
    const paketGagal = new Set<number>();
    for (const h of hasil) {
      if (h.outcome === "terposting") { combinedResults.push(h.item); continue; }
      paketGagal.add(h.paket);
      const row = rows[h.index];
      errorLogForExcel.push({
        "Paket/Batch": `Tahap ${h.paket}`, "Baris Ke": h.index + 1,
        "Ref / Invoice No": row.invoiceNo || row.customerNo || `Baris Eksekusi ${h.index + 1}`,
        "Status": h.code === "SALES_RECEIPT_LOCK_REQUIRED" ? "DITOLAK PENJAGA DUPLIKAT (tidak dikirim)"
          : h.outcome === "tidak_pasti" && h.receiptNumbers?.length ? "TIDAK PASTI (ditemukan mirip di riwayat Accurate)" : STATUS[h.outcome],
        "Pesan Error Accurate": h.message,
      });
    }
    const errorCount = paketGagal.size;
    if (errorCount === 0) {
      setResponseLog({ status: "success", data: { s: true, d: combinedResults, _note: "Digabung dari beberapa request otomatis." } });
      toast.success(`${combinedResults.length} data terkirim ke Accurate.`, { id: 'exec' });
      return;
    }
    setResponseLog({ status: "error", message: `Selesai dengan ${errorCount} tahap gagal. Rincian per baris ada di Excel log galat yang diunduh otomatis. Data yang berhasil: ${combinedResults.length}` });
    toast.error(`Selesai dengan ${errorCount} tahap gagal.`, { id: 'exec' });
    setLogGalat(errorLogForExcel);
    setTimeout(async () => {
      toast("Mengunduh Excel log galat...");
      try {
        const XLSX = await import("xlsx");
        const wsErr = XLSX.utils.json_to_sheet(errorLogForExcel);
        const wbErr = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wbErr, wsErr, "Error Log");
        XLSX.writeFile(wbErr, `Laporan_Error_Upload_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
      } catch(e) { console.error("Gagal buat xlsx error", e); }
    }, 2000);
  };

  const executeBulkPayload = async (
    rows: any[],
    routeConfig: typeof accurateRoutes[RouteKey],
    duplicateOptions?: OverrideKirim
  ) => {
    // AM-041: dulu `document.location.pathname` — URL HALAMAN, yang selalu "/api-wrapper",
    // sehingga lock idempotency, penandaan hasil, dan preview duplikat sales-receipt tidak
    // pernah berjalan. Yang menentukan adalah endpoint yang dieksekusi.
    const isSalesReceipt = routeConfig.path.includes('/sales-receipt/');
    // S6e-2 butir 7: kirim sales-receipt = lib/pelunasan/kirim.ts (lock → paket 100 → hasil per baris → complete).
    // Jalur di bawah (self-heal, mode individual) hanya untuk route NON-sales-receipt.
    if (isSalesReceipt) {
      await kirimSalesReceipt(rows, duplicateOptions);
      return;
    }
    const idempotencyLockId: string | null = null;

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
    let dihentikan = "";
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

    // Review S7-1b: riwayat hanya bukti untuk jenis dokumen yang SAMA dengan endpoint tulis — retur/PO/dll. tidak punya
    // pencocok (null) sehingga barisnya tetap TIDAK DIKETAHUI/Gagal, tak pernah "TERKONFIRMASI" dari riwayat sales-receipt.
    const cariRiwayatSejenis = pemastiRiwayatTulis(routeConfig.path, accurateFetch);
    const confirmRowsPostedInAccurate = async (rowsToCheck: any[]) => {
      const uncheckedRows = rowsToCheck.filter((row) => !confirmedReceiptNumbersByKey.has(buildSalesReceiptIdempotencyPayload(row).key));
      if (!cariRiwayatSejenis || uncheckedRows.length === 0) return confirmedReceiptNumbersByKey;

      const matchedMap = await cariRiwayatSejenis(uncheckedRows);
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
        const data = await accurateFetch(routeConfig.path, routeConfig.method, chunkPayload, { idempotencyLockId });

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
        // S7-1b: proxy menolak SEBELUM meneruskan (4xx + sent:false — mis. tanpa api_wrapper.execute, endpoint di luar katalog,
        // sesi Accurate belum lengkap) = tahap ini dan berikutnya TIDAK terkirim (tanpa cek riwayat). Baris-barisnya dicatat
        // "Gagal — tidak terkirim" lalu loop berhenti (`break`, bukan `return`): ringkasan + Excel tahap sebelumnya (termasuk baris
        // TIDAK DIKETAHUI) tetap keluar — tinjauan A, kirim ulang buta bisa menggandakan tahap yang tidak pasti.
        if (classifyWriteError(chunkErr).kind === "rejected" && chunkErr?.rawErrorObject?.sent === false) {
          for (let idx = start; idx < totalRows; idx++) {
            const row = rows[idx];
            errorLogForExcel.push({
              "Paket/Batch": `Tahap ${Math.floor(idx / chunkSize) + 1}`,
              "Baris Ke": idx + 1,
              "Ref / Invoice No": row.invoiceNo || row.customerNo || row.bankNo || row.description || `Baris Asli ke-${idx + 1}`,
              "Status": "Gagal — tidak terkirim",
              "Pesan Error Accurate": chunkErr.message,
            });
          }
          errorCount += totalChunks - i;
          dihentikan = `Dihentikan di tahap ${i + 1}: ${chunkErr.message} Tahap ${i + 1} sampai ${totalChunks} TIDAK terkirim.`;
          break;
        }
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

            toast.loading(`Tahap ${i+1} ditolak utuh. Mengirim ulang per baris...`, { id: 'exec' });

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
              toast.loading(`Mencoba koreksi otomatis untuk ${failedInvoiceNo}...`, { id: `heal-${failedInvoiceNo}` });
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
                      toast.success(`Koreksi otomatis berhasil: ${failedInvoiceNo} dikoreksi ke ${actualPrimeOwing}`, { id: `heal-${failedInvoiceNo}` });

                      errorLogForExcel.push({
                        "Paket/Batch": `Tahap ${chunkIdx+1}`,
                        "Baris Ke": startIdx + rowIdx + 1,
                        "Ref / Invoice No": mainId,
                        "Status": "BERHASIL (AUTO-CORRECTED)",
                        "Pesan Error Accurate": `Awalnya gagal selisih Rp ${normalizePayloadMoney(diff)} (Tertulis: ${normalizePayloadMoney(userAmount)}, AOL: ${normalizePayloadMoney(actualPrimeOwing)}). Dikoreksi PWA.`
                      });
                    } else {
                      toast.error(`Koreksi otomatis ditolak Accurate untuk ${failedInvoiceNo}`, { id: `heal-${failedInvoiceNo}` });
                    }
                  } else {
                    toast.error(`Selisih terlalu besar (Rp ${normalizePayloadMoney(diff)}) untuk ${failedInvoiceNo}. Koreksi otomatis dibatalkan.`, { id: `heal-${failedInvoiceNo}` });
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
      toast.success(`${combinedResults.length} data terkirim ke Accurate.`, { id: 'exec' });
    } else {
      // Baris yang hasilnya tak diketahui (tanpa jawaban Accurate) WAJIB terlihat di layar, bukan hanya di Excel: kirim ulang buta = ganda.
      const tidakPasti = errorLogForExcel.filter((r) => String(r.Status).startsWith("TIDAK DIKETAHUI")).length;
      setResponseLog({ status: "error", message: [
        dihentikan,
        `Selesai dengan ${errorCount} tahap gagal. Rincian per baris ada di Excel log galat yang diunduh otomatis. Data yang berhasil: ${combinedResults.length}.`,
        tidakPasti ? `${tidakPasti} baris TIDAK DIKETAHUI. Cek di Accurate sebelum kirim ulang (lihat Excel log galat).` : "",
      ].filter(Boolean).join("\n") });
      toast.error(`Selesai dengan ${errorCount} tahap gagal${tidakPasti ? `, ${tidakPasti} baris TIDAK DIKETAHUI` : ""}.`, { id: 'exec' });

      if (errorLogForExcel.length > 0) {
        setLogGalat(errorLogForExcel);
        setTimeout(async () => {
          toast("Mengunduh Excel log galat...");
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
      setGalatTinjau("Belum ada baris yang dipilih. Tidak ada yang dikirim.");
      return;
    }
    setGalatTinjau(null);

    // Tinjauan S6-0a: hanya override yang BENAR-BENAR dipakai server — baris pertama duplikat-dalam-unggahan
    // (pilihan bawaan) tidak butuh alasan; baris riwayat Accurate memakai override ACCURATE_HISTORY (S6e-2).
    const { allowDuplicateKeys, allowLockedKeys, allowHistoryKeys } = overrideKeysNeeded(
      [...duplicateReview.passthroughRows, ...selectedReviewRows].map((item) => buildSalesReceiptIdempotencyPayload(item.row).key),
      selectedReviewRows.filter((item) => item.reasons.includes("DUPLICATE_IN_UPLOAD")).map((item) => item.key),
      selectedReviewRows
        .filter((item) => item.reasons.includes("ALREADY_SUCCESS") || item.reasons.includes("STILL_PROCESSING") || item.reasons.includes("UNKNOWN_OUTCOME"))
        .map((item) => item.key),
      // S6e-2 (owner #6): baris MIRIP riwayat Accurate kini ditahan server — butuh override Finance per baris terpilih.
      selectedReviewRows.filter((item) => item.reasons.includes("ACCURATE_HISTORY") || item.reasons.includes("ACCURATE_HISTORY_UNREADABLE")).map((item) => item.key));

    // D-18 (owner): override = membuka kiriman ulang ke Accurate — hanya Finance (server menolak 403 tanpa
    // finance.override_duplicate) dan alasan wajib tercatat di jejak override.
    // Audit desain 001 No 8: alasan diminta lewat ConfirmDialog (dulu window.prompt) dengan syarat sama (trim, min 15);
    // kirimHasilTinjauan dijalankan dari onConfirm dengan alasan itu sebagai overrideReason. Batal = tidak ada yang dikirim.
    if (allowDuplicateKeys.length > 0 || allowLockedKeys.length > 0 || allowHistoryKeys.length > 0) {
      setOverride({
        finalRows,
        keys: { allowDuplicateKeys, allowLockedKeys, allowHistoryKeys },
        blok: allowDuplicateKeys.length + allowLockedKeys.length + allowHistoryKeys.length,
        baris: duplicateReview.reviewRows.filter((item) => duplicateReview.selections[item.reviewId]),
      });
      return;
    }
    await kirimHasilTinjauan(finalRows, { allowDuplicateKeys, allowLockedKeys, allowHistoryKeys, overrideReason: "" });
  };

  // Lanjutan handleConfirmDuplicateReview (dipisah untuk ConfirmDialog override); isi sama dengan kode sesudah window.prompt dulu.
  const kirimHasilTinjauan = async (finalRows: Record<string, unknown>[], duplicateOptions: Required<OverrideKirim>) => {
    if (!duplicateReview) return;
    const routeConfig = accurateRoutes[duplicateReview.routeKey];
    setDuplicateReview(null);
    setIsLoading(true);

    try {
      await executeBulkPayload(finalRows, routeConfig, duplicateOptions);
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

  // Audit desain 001 No 2: tulis ke Accurate hanya sesudah ConfirmDialog. Fakta dialog dihitung dari payload yang sama dengan yang
  // dipakai handleExecute (editor JSON; contoh bawaan endpoint bila tab Unggah Excel aktif). handleExecute sendiri tidak berubah.
  // Cek JSON di sini memakai aturan yang sama (JSON.parse) supaya galatnya tampil di halaman, bukan toast (No 7).
  const bukaKirim = () => {
    const routeConfig = accurateRoutes[selectedRoute];
    let payload: unknown;
    if (inputMode === "manual") {
      try {
        payload = JSON.parse(payloadStr);
      } catch (e) {
        setGalatPayload(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      payload = routeConfig.samplePayload;
    }
    setGalatPayload(null);
    if (routeConfig.method === "GET") {
      setLogGalat(null);
      void handleExecute();
      return;
    }
    const massal = routeConfig.path.includes('bulk-save') && Array.isArray(payload);
    setKonfirmasiKirim({
      path: routeConfig.path,
      baris: massal ? (payload as unknown[]).length : 1,
      massal,
      contohBawaan: inputMode !== "manual",
      pelunasan: massal && routeConfig.path.includes('/sales-receipt/'),
    });
  };

  // Unduh ulang Excel log galat terakhir; isi dan nama berkas sama dengan unduhan otomatis sesudah kirim.
  const unduhLogGalat = async () => {
    if (!logGalat) return;
    const XLSX = await import("xlsx");
    const wbErr = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbErr, XLSX.utils.json_to_sheet(logGalat), "Error Log");
    XLSX.writeFile(wbErr, `Laporan_Error_Upload_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
  };

  // Hidrasi: halaman baru dirender penuh di klien (isMounted); sebelum itu cukup kerangka memuat.
  if (!isMounted) {
    return (
      <FioriScope>
        <div className="fi-page"><Skeleton rows={8} label="Memuat Formulir Accurate (AOL)" /></div>
      </FioriScope>
    );
  }

  const route = accurateRoutes[selectedRoute];
  const menulis = route.method !== "GET";
  const adaTemplat = Boolean((route as { templateHeaders?: unknown[] }).templateHeaders?.length);
  const adaParser = Boolean(workbookRouteParsers[selectedRoute]);
  const terkunci = !isKeySaved;
  const dbTampil = openDbAlias || (openDbId ? `Tanpa nama (id ${openDbId})` : KOSONG);

  // Log hasil (No 1): hasil parser workbook (handleFileUpload) satu-satunya yang membawa kunci `_meta`; jawaban Accurate dan
  // ringkasan kirim tidak. Label sukses hanya untuk jawaban Accurate ber-s:true; objek log sendiri tidak diubah.
  const data = responseLog?.status === "success" ? responseLog.data : undefined;
  const hasilAnalisis = data != null && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "_meta");
  const catatan = typeof data?._note === "string" && data._note.trim() ? data._note : null;
  const peringatan: string[] = Array.isArray(data?._warnings) ? data._warnings : [];
  const barisD: Record<string, unknown>[] | null = Array.isArray(data?.d) && data.d.length > 0 ? data.d : null;
  const kolomD = barisD ? Array.from(new Set(barisD.flatMap((row) => Object.keys(row || {})))) : [];
  const ditolakD = !hasilAnalisis && barisD ? barisD.filter((row) => row && typeof row === "object" && row.s === false).length : 0;

  const k = konfirmasiKirim;
  const tinjau = duplicateReview;
  const dipilihTinjau = tinjau ? Object.values(tinjau.selections).filter(Boolean).length : 0;
  const totalTinjau = tinjau ? tinjau.passthroughRows.length + tinjau.reviewRows.filter((item) => tinjau.selections[item.reviewId]).length : 0;
  const tutupTinjau = () => { setDuplicateReview(null); setGalatTinjau(null); };

  return (
    <FioriScope>
      <div className="fi-page">
        <header className="fi-page-head">
          <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">Formulir Accurate (AOL)</span></li></ol></nav>
          <h1>Formulir Accurate (AOL)</h1>
          <p>Alat admin: kirim payload dan unggah massal ke Accurate. Kiriman yang diterima Accurate menjadi jurnal nyata dan tidak bisa ditarik dari aplikasi ini.</p>
        </header>

        <div className="grid items-start gap-4 lg:grid-cols-12">
          <div className="grid min-w-0 content-start gap-4 lg:col-span-4">
            {/* Kartu Sesi Accurate: komponen yang sama dengan /sesi-accurate (masuk, pilih database, keluar). */}
            <SesiAccurate returnTo="/api-wrapper" kabar={kabarUrl} onStatus={terapkanSesi} />

            <Section title="Endpoint" subtitle={menulis ? <StatusBadge tone="warn">Menulis ke Accurate</StatusBadge> : <StatusBadge tone="neu">Hanya membaca</StatusBadge>}>
              <div className="fi-sect-in" inert={terkunci}>
                <FormField label="Endpoint API">
                  {(a11y) => (
                    <select {...a11y} className="fi-input" value={selectedRoute} onChange={handleChangeRoute}>
                      {(Object.keys(accurateRoutes) as RouteKey[]).map((key) => (
                        <option key={key} value={key}>{accurateRoutes[key].label}</option>
                      ))}
                    </select>
                  )}
                </FormField>
                <KeyValues items={[["Alamat", <span key="alamat" className="fi-mono">{route.path}</span>]]} />
              </div>
            </Section>
          </div>

          <div className="grid min-w-0 content-start gap-4 lg:col-span-8">
            {sesiDibaca && terkunci && (
              <MessageStrip tone="warn" title="Masuk Accurate dan buka database dulu.">
                Endpoint, isi kiriman, dan unggah berkas terkunci sampai database aktif di kartu Sesi Accurate.
              </MessageStrip>
            )}

            {/* Terkunci = `inert` hanya pada isian; tombol Kirim (nonaktif + alasan) dan Hasil tetap terbaca. */}
            <Section title="Isi kiriman" actions={
              <div className="fi-segs" role="group" aria-label="Cara mengisi" inert={terkunci}>
                <button type="button" aria-pressed={inputMode === "manual"} onClick={() => setInputMode("manual")}><FileJson className="fi-icon" aria-hidden />Payload JSON</button>
                <button type="button" aria-pressed={inputMode === "excel"} onClick={() => setInputMode("excel")}><FileSpreadsheet className="fi-icon" aria-hidden />Unggah Excel</button>
              </div>
            }>
              <div className="fi-sect-in" inert={terkunci}>
                {galatPayload && (
                  <MessageStrip tone="neg" title="Payload JSON tidak valid." onClose={() => setGalatPayload(null)}>
                    Perbaiki di editor. Tidak ada yang dikirim.
                    <span className="fi-codes">{galatPayload}</span>
                  </MessageStrip>
                )}
                {inputMode === "manual" ? (
                  <FormField label="Payload JSON" help="Isi permintaan apa adanya ke Accurate. Hasil unggah Excel juga dimuat ke sini untuk diperiksa sebelum dikirim.">
                    {(a11y) => <textarea {...a11y} className="fi-input fi-mono" rows={16} value={payloadStr} onChange={(e) => setPayloadStr(e.target.value)} spellCheck={false} />}
                  </FormField>
                ) : (
                  <div className="grid gap-4">
                    <div className="max-w-60">
                      <FormField label="Tanggal transaksi" help="Bawaan H-1 (WITA). Dipakai untuk semua tagihan dari berkas.">
                        {(a11y) => <input {...a11y} type="date" className="fi-input" value={trxDate} onChange={(e) => setTrxDate(e.target.value)} />}
                      </FormField>
                    </div>

                    {selectedRoute === "salesReceiptBulkSave" && (
                      <div className="grid gap-3">
                        <div className="grid gap-1">
                          <h3 className="fi-title-3">Mapping Format Pelunasan internal</h3>
                          <p className="fi-small fi-muted">Hanya dipakai untuk berkas Format Pelunasan internal.</p>
                        </div>
                        <div className="fi-formgrid">
                          <FormField label="Akun kas/bank Tunai" help="ID atau nomor akun.">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapTunaiBank} onChange={(e) => setMapTunaiBank(e.target.value)} />}</FormField>
                          <FormField label="ID penomoran Tunai">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapTunaiAutoNum} onChange={(e) => setMapTunaiAutoNum(e.target.value)} />}</FormField>
                          <FormField label="Akun kas/bank Transfer" help="ID atau nomor akun.">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapTrfBank} onChange={(e) => setMapTrfBank(e.target.value)} />}</FormField>
                          <FormField label="ID penomoran Transfer">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapTrfAutoNum} onChange={(e) => setMapTrfAutoNum(e.target.value)} />}</FormField>
                          <FormField label="Akun kas/bank BG" help="ID atau nomor akun.">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapBgBank} onChange={(e) => setMapBgBank(e.target.value)} />}</FormField>
                          <FormField label="ID penomoran BG">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapBgAutoNum} onChange={(e) => setMapBgAutoNum(e.target.value)} />}</FormField>
                          <FormField label="Akun GL Pot.1" help="Akun diskon. Kosongkan bila tidak dipakai.">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapPot1Account} onChange={(e) => setMapPot1Account(e.target.value)} />}</FormField>
                          <FormField label="Akun GL Pot.2" help="Akun diskon. Kosongkan bila tidak dipakai.">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapPot2Account} onChange={(e) => setMapPot2Account(e.target.value)} />}</FormField>
                          <FormField label="Akun GL Pot.3" help="Akun diskon. Kosongkan bila tidak dipakai.">{(a11y) => <input {...a11y} type="text" className="fi-input" value={mapPot3Account} onChange={(e) => setMapPot3Account(e.target.value)} />}</FormField>
                        </div>
                      </div>
                    )}

                    <div className="grid gap-3 rounded-[var(--r-md)] border border-dashed border-line-strong p-4 sm:p-6">
                      <div className="grid gap-1">
                        <h3 className="fi-title-3">Berkas Excel atau CSV</h3>
                        <p className="fi-small fi-muted">
                          {adaParser
                            ? "Endpoint ini punya pembaca berkas khusus. Hasilnya dimuat ke Payload JSON untuk diperiksa; belum ada yang dikirim."
                            : "Baris pertama berisi nama kolom yang sama persis dengan nama parameter API Accurate (pakai templat). Isi berkas dimuat ke Payload JSON untuk diperiksa; belum ada yang dikirim."}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button icon={<Download className="fi-icon" aria-hidden />} disabled={!adaTemplat} disabledReason="Endpoint ini belum punya templat Excel." onClick={handleDownloadTemplate}>Unduh templat Excel</Button>
                        <label className="fi-btn fi-btn--secondary">
                          <Upload className="fi-icon" aria-hidden />Unggah berkas
                          <input type="file" className="sr-only" accept=".xlsx, .xls, .csv" onChange={(e) => { setLogGalat(null); handleFileUpload(e); }} />
                        </label>
                      </div>
                      {!adaTemplat && <p className="fi-small fi-why">Endpoint ini belum punya templat Excel; susun kolom sesuai parameter API.</p>}
                    </div>
                  </div>
                )}
              </div>
              <div className="fi-sect-in border-t border-line">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <p className="fi-small fi-subtle mr-auto">{menulis ? "Ringkasan kiriman ditampilkan untuk dikonfirmasi sebelum terkirim." : "Hanya membaca dari Accurate, tidak mengubah data."}</p>
                  <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} busy={isLoading} disabled={terkunci} disabledReason="Masuk Accurate dan buka database dulu." onClick={bukaKirim}>
                    {isLoading ? "Memproses…" : menulis ? "Kirim ke Accurate…" : "Baca dari Accurate"}
                  </Button>
                </div>
              </div>
            </Section>

            <Section title="Hasil">
              <div className="fi-sect-in">
                {!responseLog ? (
                  <EmptyState title="Belum ada hasil" message="Hasil analisis berkas dan jawaban Accurate tampil di sini." />
                ) : responseLog.status === "error" ? (
                  <>
                    <MessageStrip tone="neg" title="Ada yang gagal.">
                      <span className="whitespace-pre-wrap break-words">{responseLog.message}</span>
                    </MessageStrip>
                    {logGalat && (
                      <div><Button icon={<Download className="fi-icon" aria-hidden />} onClick={() => void unduhLogGalat()}>Unduh ulang log galat</Button></div>
                    )}
                  </>
                ) : (
                  <>
                    {hasilAnalisis ? (
                      <MessageStrip tone="info" title="Berkas dianalisis, belum dikirim ke Accurate.">
                        Hasilnya sudah dimuat ke Payload JSON. Periksa, lalu tekan Kirim ke Accurate.
                      </MessageStrip>
                    ) : data?.s === true ? (
                      <MessageStrip tone="pos" title={menulis ? "Accurate menerima kiriman." : "Accurate menjawab."}>{catatan}</MessageStrip>
                    ) : (
                      <MessageStrip tone="info" title="Jawaban Accurate.">Periksa isinya di bawah.</MessageStrip>
                    )}
                    {hasilAnalisis && catatan && <p className="fi-small">{catatan}</p>}
                    {ditolakD > 0 && (
                      <MessageStrip tone="warn" title={`${ditolakD} baris ditolak Accurate.`}>Baris dengan kolom s bernilai false di tabel tidak tersimpan. Periksa sebelum mengirim ulang.</MessageStrip>
                    )}
                    {peringatan.length > 0 && (
                      <MessageStrip tone="warn" title={hasilAnalisis ? "Peringatan dari pembaca berkas." : "Peringatan."}>
                        <ul className="mt-1 grid gap-1">
                          {peringatan.slice(0, 20).map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                        </ul>
                        {peringatan.length > 20 && <p className="mt-1">dan {peringatan.length - 20} peringatan lain.</p>}
                      </MessageStrip>
                    )}
                    {barisD ? (
                      <div className="grid gap-2">
                        <div className="fi-tablescroll max-h-[480px] rounded-[var(--r-md)] border border-line">
                          <table className="fi-table">
                            <caption className="sr-only">{hasilAnalisis ? "Ringkasan analisis berkas" : "Jawaban Accurate per baris"}</caption>
                            <thead>
                              <tr>{kolomD.map((key) => <th key={key} scope="col">{key}</th>)}</tr>
                            </thead>
                            <tbody>
                              {barisD.slice(0, 50).map((row, i) => (
                                <tr key={i}>
                                  {kolomD.map((key) => {
                                    const teks = selTeks(row?.[key]);
                                    return <td key={key} className="max-w-[24rem] truncate" title={teks}>{teks}</td>;
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="fi-small fi-subtle">
                          {barisD.length > 50 ? `Menampilkan 50 dari ${barisD.length} baris.` : `${barisD.length} baris.`}
                        </p>
                      </div>
                    ) : (
                      <pre className="fi-mono max-h-[480px] overflow-auto whitespace-pre rounded-[var(--r-md)] border border-line bg-surface-2 p-3">
                        {JSON.stringify(responseLog.data, null, 2)}
                      </pre>
                    )}
                  </>
                )}
              </div>
            </Section>
          </div>
        </div>

        <ConfirmDialog
          open={Boolean(k)}
          onClose={() => setKonfirmasiKirim(null)}
          tag="Tulis ke Accurate"
          title={k?.massal ? `Kirim ${k.baris} baris ke Accurate?` : "Kirim ke Accurate?"}
          description={
            <>
              Kiriman yang diterima Accurate menjadi jurnal nyata dan tidak bisa ditarik dari aplikasi ini.
              {k?.pelunasan && " Pelunasan diperiksa dulu terhadap kiriman sebelumnya dan riwayat Accurate; baris yang mirip ditampilkan untuk ditinjau sebelum dikirim."}
            </>
          }
          facts={k ? [
            ["Endpoint", <span key="endpoint" className="fi-mono">{k.path}</span>],
            ["Isi", k.massal ? `${k.baris} baris, ${Math.ceil(k.baris / 100)} tahap (maks. 100 baris per tahap)` : "1 permintaan"],
            ["Sumber", k.contohBawaan ? "Contoh payload bawaan endpoint" : "Payload JSON di editor"],
            ["Database aktif", dbTampil],
          ] : undefined}
          confirmLabel={k?.massal ? `Kirim ${k.baris} baris` : "Kirim ke Accurate"}
          onConfirm={() => {
            setKonfirmasiKirim(null);
            setLogGalat(null);
            void handleExecute();
          }}
        >
          {k?.contohBawaan && (
            <MessageStrip tone="warn" title="Tab Unggah Excel aktif tanpa berkas termuat.">
              Yang dikirim adalah contoh payload bawaan endpoint, bukan isi berkas. Batalkan, lalu unggah berkas bila itu maksud Anda.
            </MessageStrip>
          )}
        </ConfirmDialog>

        <Dialog
          open={Boolean(tinjau)}
          onClose={tutupTinjau}
          labelledBy={`${idTinjau}-judul`}
          describedBy={`${idTinjau}-ket`}
          // ponytail: lebar dialog lewat utilitas `!` karena dialog.fi-dialog mengunci 560 px; permintaan modifier lebar ke fondasi.
          className="fi-dialog w-[min(1040px,calc(100vw-32px))]!"
        >
          {tinjau && (
            <>
              <header>
                <div>
                  <span className="fi-tag" data-tone="warn">Pelunasan ganda</span>
                  <h2 id={`${idTinjau}-judul`}>Kirim pelunasan yang mirip kiriman lain?</h2>
                </div>
                <Button variant="icon" aria-label="Tutup" onClick={tutupTinjau}><X className="fi-icon" aria-hidden /></Button>
              </header>
              <div className="fi-dialog-body">
                <p id={`${idTinjau}-ket`} className="fi-small fi-muted">
                  Baris ini mirip unggahan lain, riwayat Accurate, atau muncul lebih dari sekali di batch ini. Centang yang tetap ingin dikirim;
                  yang tidak dicentang tidak dikirim.
                </p>
                <p className="fi-small">
                  {tinjau.reviewRows.length} kandidat perlu ditinjau, {dipilihTinjau} dipilih. {tinjau.passthroughRows.length} baris lain tanpa tanda ganda ikut dikirim.
                </p>
                {galatTinjau && <MessageStrip tone="neg">{galatTinjau}</MessageStrip>}
                <div className="fi-tablescroll max-h-[55vh] rounded-[var(--r-md)] border border-line">
                  <table className="fi-table">
                    <caption className="sr-only">Kandidat pelunasan ganda</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="fi-sel"><span className="sr-only">Pilih</span></th>
                        <th scope="col">Pelanggan</th>
                        <th scope="col">Invoice</th>
                        <th scope="col">Tanggal</th>
                        <th scope="col" className="fi-end">Nilai</th>
                        <th scope="col">Alasan</th>
                        <th scope="col">Referensi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tinjau.reviewRows
                        .sort((a, b) => a.originalIndex - b.originalIndex)
                        .map((item) => (
                          <tr key={item.reviewId} data-selected={tinjau.selections[item.reviewId] || undefined}>
                            <td className="fi-sel">
                              <label className="fi-check min-w-[var(--ctl-h)] justify-center">
                                <input
                                  type="checkbox"
                                  checked={!!tinjau.selections[item.reviewId]}
                                  onChange={(e) => { setGalatTinjau(null); handleDuplicateSelectionChange(item.reviewId, e.target.checked); }}
                                  aria-label={`Pilih ${item.customerNo || "pelanggan tanpa kode"}, invoice ${item.invoiceNo || "tanpa nomor"}`}
                                />
                              </label>
                            </td>
                            <td>
                              <div className="fi-mono">{item.customerNo || KOSONG}</div>
                              <div className="fi-small fi-subtle">{item.paymentMethod || KOSONG}</div>
                            </td>
                            <td>
                              <div className="fi-mono break-all">{item.invoiceNo || KOSONG}</div>
                              {item.recommended && <div className="mt-1"><StatusBadge tone="info">Disarankan</StatusBadge></div>}
                            </td>
                            <td className="fi-tnum whitespace-nowrap">{item.transDate || KOSONG}</td>
                            <td className="fi-end">{item.amount.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td>
                              <div className="flex flex-wrap gap-1">
                                {item.reasons.map((reason) => <StatusBadge key={`${item.reviewId}-${reason}`} tone="warn">{getDuplicateReasonLabel(reason)}</StatusBadge>)}
                              </div>
                            </td>
                            <td>
                              {item.matchedReceiptNumbers.length > 0 ? (
                                <div className="grid gap-1">
                                  {item.matchedReceiptNumbers.slice(0, 5).map((receiptNo) => <div key={`${item.reviewId}-${receiptNo}`} className="fi-mono break-all">{receiptNo}</div>)}
                                  {item.matchedReceiptNumbers.length > 5 && <div className="fi-small fi-subtle">dan {item.matchedReceiptNumbers.length - 5} pelunasan lain</div>}
                                </div>
                              ) : (
                                <span className="fi-small fi-muted">Catatan lokal saja</span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <footer>
                <Button onClick={tutupTinjau}>Batal</Button>
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} onClick={() => void handleConfirmDuplicateReview()}>Kirim {totalTinjau} baris ke Accurate</Button>
              </footer>
            </>
          )}
        </Dialog>

        <ConfirmDialog
          open={Boolean(override)}
          onClose={() => setOverride(null)}
          tone="negative"
          tag="Override duplikat, kewenangan Finance"
          title={`Kirim ulang ${override?.blok ?? 0} blok yang ditandai ganda?`}
          description="Baris ini mirip kiriman sebelumnya atau riwayat Accurate. Mengirimnya bisa membuat pelunasan ganda di Accurate. Alasan tercatat di jejak override."
          facts={override ? [
            ["Blok di-override", String(override.blok)],
            ["Baris bertanda yang dipilih", String(override.baris.length)],
            ["Nilai baris itu", rupiah(override.baris.reduce((jumlah, item) => jumlah + item.amount, 0))],
            ["Invoice", daftarRingkas(override.baris.map((item) => item.invoiceNo || KOSONG))],
            ["Pelanggan", daftarRingkas(Array.from(new Set(override.baris.map((item) => item.customerNo || KOSONG))), 3)],
            ["Total dikirim", `${override.finalRows.length} baris`],
          ] : undefined}
          reason={{ label: "Alasan override", min: 15 }}
          confirmLabel="Override dan kirim"
          onConfirm={(alasan) => {
            const o = override;
            if (!o) return;
            setOverride(null);
            void kirimHasilTinjauan(o.finalRows, { ...o.keys, overrideReason: alasan });
          }}
        />
      </div>
    </FioriScope>
  );
}
