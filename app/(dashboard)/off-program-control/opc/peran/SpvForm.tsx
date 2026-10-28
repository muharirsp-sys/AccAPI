/*
 * Tujuan: Form batch Supervisor OFF Program Control (Fiori S4d, it03 #13/#14): setup batch + No Pengajuan otomatis, daftar item +
 *   form BERLABEL per item (ponsel: daftar item, bukan grid 18 kolom), validasi isian kode lama, Simpan draf, Kirim ke SM lewat
 *   dialog `kirimsm` berisi ringkasan perubahan, dan dialog No Surat duplikat (pengganti DuplicateNoSuratPrompt). Logic = salinan
 *   SupervisorDashboard kode lama; payload dan urutan panggilan TIDAK berubah. Jawaban simpan/kirim yang tidak pasti (putus, ≥ 502,
 *   bukan JSON) diklasifikasi kirimTulis dan dilaporkan sebagai "belum pasti", bukan gagal.
 * Caller: opc/peran/Spv.tsx (UbahBatch di Object Page, BatchBaru di kolom kedua).
 * Dependensi: components/fiori/{core,interactive}, opc/Bersama (kirimTulis, TulisTidakPasti, pesanTidakPasti, tanganiTulis),
 *   lib/off-program-control/{constants,program-type,problematic}, lib/opc-ui, lib/promo-ui (rupiah), lib/tampil (KOSONG).
 * Main Functions: useFormSpv, SetupBatch, EditorItem, AksiForm, pesanFooter, StripDraf, DialogForm, barisDariItem, barisKosong,
 *   parseUiCurrency, kodePrincipal, gelombangDariNomor.
 * Side Effects: GET /batches/next-number; Simpan draf = POST /batches (baru) atau PATCH /batches/[id]; Kirim ke SM = POST/PATCH
 *   yang sama LALU POST /batches/[id]/submit (dua panggilan berurutan, kode lama).
 */
"use client";

import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { offPaymentMethods, offPrinciples } from "@/lib/off-program-control/constants";
import { getPrincipleByName } from "@/lib/off-program-control/helpers";
import { SLA_DAYS } from "@/lib/off-program-control/problematic";
import { OFF_PROGRAM_TYPES, resolveProgramType } from "@/lib/off-program-control/program-type";
import { kelengkapanItem, labelStatus, tanggalOpc, type BatchOpc, type ItemOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { TulisTidakPasti, kirimTulis, pesanTidakPasti, tanganiTulis } from "../Bersama";

/** Satu baris item di editor (SupervisorBulkRow kode lama). Nominal tetap teks apa adanya; server yang mengurai. */
export type Baris = {
    id: string; noSurat: string; namaProgram: string; periodeAwal: string; periodeAkhir: string; toko: string; barang: string;
    nominal: string; caraBayar: string; noRekening: string; type: string; originalType: string; typeIsLegacy: boolean; pphExempt: boolean;
    deadline: string; kwt: boolean; skp: boolean; fp: boolean; pc: boolean; foto: boolean; rekap: boolean; others: boolean; othersText: string;
};
export type Setup = { supervisorName: string; principleName: string; bulan: string; tahun: string };
/** Nomor batch yang sudah tersimpan (editingOriginalNumber kode lama): selama principal/bulan/tahun sama, nomor tidak dihitung ulang. */
export type NomorAsli = { noPengajuan: string; gelombang: string; principleCode: string; bulan: string; tahun: string };
export type Pesan = { tone: "pos" | "neg" | "info" | "warn"; judul: string; isi?: ReactNode };
/** Hasil kirim (submitResult kode lama). `sudahAda` = jawaban ALREADY_SUBMITTED: pengajuan ini sudah pernah dikirim (kode lama). */
export type HasilKirim = { batchId: string; noPengajuan: string; rowCount: number; total: number; transfer: number; tunai: number; pdfUrl: string; sudahAda?: boolean };
type KonflikNoSurat = { noSurat: string; batchId: string; noPengajuan: string; principleCode: string; principleName: string; status: string };
type Duplikat = { mode: "draft" | "submit"; principleName: string; conflicts: KonflikNoSurat[] };
type Isi = { setup: Setup; rows: Baris[] };

// Helper murni (salinan kode lama).

/** getPrincipleCode (kode lama). Lewat getPrincipleByName: batch KINO lama berejaan bertitik tetap ber-kode (S7-2b). */
export const kodePrincipal = (name: string) => getPrincipleByName(name)?.code || "";

/** getGelombangFromNoPengajuan (kode lama). */
export function gelombangDariNomor(no: string) {
    const first = String(no || "").split("/")[0] || "";
    return /^\d+$/.test(first) ? first.padStart(3, "0") : "";
}

/** parseUiCurrency (kode lama): "Rp 1.200.000" → 1200000; desimal koma/titik dikenali. */
export function parseUiCurrency(value: string | number) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const cleaned = String(value || "").replace(/[^\d,.-]/g, "");
    if (!cleaned) return 0;
    if (cleaned.includes(".") && cleaned.includes(",")) {
        const dec = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
        return Number(cleaned.replace(new RegExp(`\\${dec === "," ? "." : ","}`, "g"), "").replace(dec, ".")) || 0;
    }
    if (cleaned.includes(".")) return Number(cleaned.replace(/\./g, "")) || 0;
    if (cleaned.includes(",")) return Number(cleaned.replace(/,/g, "")) || 0;
    return Number(cleaned) || 0;
}

/** normalizeUiPaymentMethod (kode lama). */
function caraBayar(value: string) {
    const n = value.trim().toLowerCase();
    if (n === "transfer") return "Transfer";
    if (n === "tunai") return "Tunai";
    return value;
}

/** computeUiPaymentSummary (kode lama). */
function ringkasBayar(items: Array<{ nominal: string | number; caraBayar: string }>) {
    return items.reduce((s, item) => {
        const nominal = parseUiCurrency(item.nominal);
        s.total += nominal;
        const m = caraBayar(item.caraBayar);
        if (m === "Transfer") s.transfer += nominal;
        if (m === "Tunai") s.tunai += nominal;
        return s;
    }, { total: 0, transfer: 0, tunai: 0 });
}

// ponytail: id baris baru dari penghitung modul (bukan Date.now() saat render); hanya kunci React, tidak dikirim ke server.
let urutBaris = 0;
/** createEmptyBulkRow (kode lama). */
export function barisKosong(): Baris {
    urutBaris += 1;
    return {
        id: `baris-baru-${urutBaris}`, noSurat: "", namaProgram: "", periodeAwal: "", periodeAkhir: "", toko: "", barang: "", nominal: "",
        caraBayar: "Transfer", noRekening: "", type: "", originalType: "", typeIsLegacy: false, pphExempt: false, deadline: "",
        kwt: false, skp: false, fp: false, pc: false, foto: false, rekap: false, others: false, othersText: "",
    };
}

/** apiItemToBulkRow (kode lama): tipe lama dinormalisasi; tipe yang tidak dikenali dikosongkan supaya SPV wajib memilih ulang. */
export function barisDariItem(item: ItemOpc, index: number): Baris {
    const [periodeAwal = "", periodeAkhir = ""] = String(item.periode || "").split(" - "); // splitPeriodDates (kode lama)
    const resolved = resolveProgramType(item.normalizedType ?? item.type ?? item.originalType);
    return {
        id: item.id || `returned-row-${index + 1}`,
        noSurat: item.noSurat || "", namaProgram: item.namaProgram || "", periodeAwal, periodeAkhir, toko: item.toko || "", barang: item.barang || "",
        nominal: item.nominal ? `Rp ${Number(item.nominal).toLocaleString("id-ID")}` : "",
        caraBayar: item.caraBayar || "Transfer", noRekening: item.noRekening || "",
        type: resolved.forcedToFallback ? "" : resolved.normalizedType,
        originalType: item.originalType || String(item.type || ""),
        typeIsLegacy: Boolean(item.typeIsLegacy) || resolved.typeIsLegacy,
        pphExempt: Boolean(item.pphExempt), deadline: item.deadline || "",
        kwt: Boolean(item.kwt), skp: Boolean(item.skp), fp: Boolean(item.fp), pc: Boolean(item.pc), foto: Boolean(item.foto), rekap: Boolean(item.rekap),
        others: Boolean(item.others), othersText: item.othersText || "",
    };
}

/** buildSupervisorItems (kode lama) — payload item PERSIS kode lama. */
function itemPayload(rows: Baris[]) {
    return rows.map((row) => ({
        noSurat: row.noSurat,
        namaProgram: row.namaProgram,
        periodeAwal: row.periodeAwal,
        periodeAkhir: row.periodeAkhir,
        // buildPeriodString (kode lama)
        periode: row.periodeAwal && row.periodeAkhir ? `${row.periodeAwal} - ${row.periodeAkhir}` : row.periodeAwal || row.periodeAkhir || "",
        toko: row.toko,
        barang: row.barang,
        nominal: row.nominal,
        caraBayar: row.caraBayar,
        noRekening: caraBayar(row.caraBayar) === "Transfer" ? row.noRekening : "",
        type: row.type,
        // Audit legacy: kirim nilai asli agar backend menyimpan originalType.
        originalType: row.originalType || row.type,
        // PPh masih HOLD; hanya kirim penanda exempt. Tidak memblokir submit.
        pphExempt: row.pphExempt,
        deadline: row.deadline,
        kwt: row.kwt, skp: row.skp, fp: row.fp, pc: row.pc, foto: row.foto, rekap: row.rekap, others: row.others,
        othersText: row.othersText,
    }));
}

const TIPE = OFF_PROGRAM_TYPES as readonly string[];
const butuhRekening = (r: Baris) => caraBayar(r.caraBayar) === "Transfer" && !r.noRekening.trim();

/**
 * Validasi isian sebelum simpan/kirim (findInvalidTypeRowNumber + findMissingTransferRekeningRowNumber, kode lama):
 * tipe dulu, lalu rekening; kalimat sama dengan kode lama.
 */
function galatIsian(rows: Baris[], mode: "draft" | "submit"): string | undefined {
    const t = rows.findIndex((r) => !TIPE.includes(r.type));
    if (t !== -1) {
        return `Tipe program pada item ${t + 1} wajib dipilih dari daftar (Display/Visibility/Promo On Store/Event/Sample) sebelum ${mode === "draft" ? "disimpan" : "dikirim ke Sales Manager"}.`;
    }
    const r = rows.findIndex(butuhRekening);
    if (r !== -1) return `No Rekening pada item ${r + 1} wajib diisi karena Cara Bayar adalah Transfer.`;
    return undefined;
}

/** Tanda per item (Default it03: "satu item ditandai") dari aturan validasi yang sama. */
function masalahBaris(r: Baris): { tipe?: string; rekening?: string } {
    return {
        tipe: TIPE.includes(r.type) ? undefined : r.originalType ? `Tipe lama "${r.originalType}" perlu dipilih ulang.` : "Pilih tipe program.",
        rekening: butuhRekening(r) ? "Wajib diisi karena cara bayar Transfer." : undefined,
    };
}
const adaMasalah = (r: Baris) => { const m = masalahBaris(r); return Boolean(m.tipe || m.rekening); };
/** Item berisi (bukan baris kosong bawaan): hapusnya ditanya dulu. */
const terisi = (r: Baris) => Object.entries(r).some(([k, v]) => k !== "id" && v !== "" && v !== false && !(k === "caraBayar" && v === "Transfer"));

const LABEL_ISIAN: Array<[keyof Baris, string]> = [
    ["noSurat", "No Surat"], ["namaProgram", "nama program"], ["periodeAwal", "periode awal"], ["periodeAkhir", "periode akhir"], ["toko", "toko"],
    ["barang", "barang"], ["nominal", "nominal"], ["caraBayar", "cara bayar"], ["noRekening", "no rekening"], ["type", "tipe"],
    ["pphExempt", "tidak kena PPh"], ["deadline", "deadline"], ["kwt", "KWT"], ["skp", "SKP"], ["fp", "FP"], ["pc", "PC"], ["foto", "foto"],
    ["rekap", "rekap"], ["others", "lainnya"], ["othersText", "dokumen lainnya"],
];
const nilai = (v: unknown) => (typeof v === "boolean" ? (v ? "ya" : "tidak") : v === "" ? "kosong" : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? tanggalOpc(String(v)) : String(v));

/** Ringkasan perubahan sejak batch dibuka (dialog `kirimsm`, it03 #14). Tanpa BL-33: hanya dari isian di layar. */
function ringkasPerubahan(awal: Isi, kini: Isi): string[] {
    const out: string[] = [];
    if (awal.setup.principleName !== kini.setup.principleName) out.push(`Principal: ${awal.setup.principleName} → ${kini.setup.principleName}`);
    if (awal.setup.supervisorName !== kini.setup.supervisorName) out.push(`Nama supervisor: ${nilai(awal.setup.supervisorName)} → ${nilai(kini.setup.supervisorName)}`);
    const lama = new Map(awal.rows.map((r) => [r.id, r]));
    kini.rows.forEach((r, i) => {
        const l = lama.get(r.id);
        if (!l) { out.push(`Item ${i + 1} ditambahkan${r.toko ? ` (${r.toko})` : ""}`); return; }
        for (const [k, label] of LABEL_ISIAN) if (l[k] !== r[k]) out.push(`Item ${i + 1} ${label}: ${nilai(l[k])} → ${nilai(r[k])}`);
    });
    const ada = new Set(kini.rows.map((r) => r.id));
    awal.rows.forEach((r, i) => { if (!ada.has(r.id)) out.push(`Item ${i + 1} lama dihapus${r.toko ? ` (${r.toko})` : ""}`); });
    return out;
}

/** parseJsonResponse kode lama untuk GET nomor; badan bukan JSON (mis. halaman HTML proxy) tidak pernah tampil mentah. */
async function bacaJson(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

type Nomor = { gelombang: string; noPengajuan: string } | null;

/** next-number (kode lama): nomor asli dipakai selama principal/bulan/tahun sama; selain itu GET next-number (excludeBatchId). */
function useNomorOtomatis(kode: string, bulan: string, tahun: string, excludeBatchId: string | null, asli: NomorAsli | null): Load<Nomor> {
    const cocokAsli = Boolean(asli && asli.principleCode === kode && asli.bulan === bulan && asli.tahun === tahun);
    const noAsli = asli?.noPengajuan ?? "";
    const gelAsli = asli?.gelombang ?? "";
    const [load] = useLoad(useCallback(async (): Promise<Load<Nomor>> => {
        if (!kode || !bulan || !tahun) return { status: "siap", data: null };
        if (cocokAsli) return { status: "siap", data: { gelombang: gelAsli || gelombangDariNomor(noAsli) || "001", noPengajuan: noAsli } };
        const params = new URLSearchParams({ principleCode: kode, bulan, tahun, source: "supervisor" });
        if (excludeBatchId) params.set("excludeBatchId", excludeBatchId);
        try {
            const res = await fetch(`/api/off-program-control/batches/next-number?${params.toString()}`, { credentials: "include" });
            const data = await bacaJson(res);
            if (!data.ok) throw new Error(String(data.error || "Gagal memuat No Pengajuan otomatis."));
            const gelombang = String(data.gelombang || "001");
            return { status: "siap", data: { gelombang, noPengajuan: String(data.noPengajuan || "") || `${gelombang}/${kode}/${bulan}/${tahun}` } };
        } catch (e) {
            // TypeError = koneksi putus ("Failed to fetch"): pesan umum, bukan teks peramban.
            return { status: "galat", error: e instanceof Error && !(e instanceof TypeError) ? e.message : "Gagal memuat No Pengajuan otomatis. Periksa koneksi, lalu coba lagi." };
        }
    }, [kode, bulan, tahun, excludeBatchId, cocokAsli, noAsli, gelAsli]));
    return load;
}

type OpsiForm = {
    /** null = batch baru (POST /batches); selain itu PATCH /batches/[id]. */
    batchId: string | null;
    awal: Isi;
    asli: NomorAsli | null;
    onPesan: (p: Pesan | null) => void;
    /** 409 dari PATCH karena status/kunci batch berubah sejak dibuka (bukan duplikat, bukan periode ditutup) — BL-09 perilaku hari ini. */
    onKonflik: (pesan: string) => void;
    onDrafTersimpan: (h: { batchId: string; noPengajuan: string }) => void;
    /** Simpan berhasil tetapi submit gagal (`pasti`) atau jawabannya tidak pasti: batch kini draf tersimpan. Boleh melempar Error (tampil di dialog). */
    onGagalKirim: (h: { batchId: string; noPengajuan: string }, pesan: string, pasti: boolean) => void;
    /** Jawaban simpan tidak pasti (putus, ≥ 502, bukan JSON): batch mungkin sudah tersimpan. Pemanggil menampilkan strip + memuat ulang. */
    onTidakPasti: (pesan: string) => void;
    onTerkirim: (h: HasilKirim) => void;
    /** POST menjawab ALREADY_SUBMITTED: tampilkan hasil + PDF yang ada, tanpa memanggil submit (kode lama). */
    onSudahDikirim: (h: HasilKirim) => void;
};

/**
 * 409 PATCH yang berarti status/kunci batch di server berubah sejak dibuka ([id]/route.ts: "terkunci", "hanya bisa diedit saat …").
 * 409 lain (mis. "Periode ini sudah ditutup") hanya galat biasa: muat ulang tidak menolong.
 */
const KONFLIK_STATUS = /terkunci|hanya bisa diedit/i;

export function useFormSpv(o: OpsiForm) {
    const [setup, setSetup] = useState(o.awal.setup);
    const [rows, setRows] = useState(o.awal.rows);
    const [dasar, setDasar] = useState<Isi>(o.awal);
    const [terpilih, setTerpilih] = useState(() => (o.awal.rows.find(adaMasalah) ?? o.awal.rows[0]).id);
    const [dialogKirim, setDialogKirim] = useState(false);
    const [duplikat, setDuplikat] = useState<Duplikat | null>(null);
    const [sibukDraf, setSibukDraf] = useState(false);
    const jalan = useRef(false); // penjaga klik ganda Simpan draf (disabled baru berlaku sesudah render)

    const kode = kodePrincipal(setup.principleName);
    const nomor = useNomorOtomatis(kode, setup.bulan, setup.tahun, o.batchId, o.asli);
    const generatedNo = nomor.data?.noPengajuan || `${nomor.data?.gelombang ?? o.asli?.gelombang ?? "001"}/${kode}/${setup.bulan}/${setup.tahun}`;
    // Tampilan saja: nomor rakitan lokal tidak dipajang seolah sah selama nomor server memuat/gagal (cara membuat generatedNo tetap).
    const nomorSiap = nomor.status === "siap" && Boolean(nomor.data);
    const nomorTampil = nomorSiap ? generatedNo : nomor.status === "memuat" ? "Menunggu nomor dari server" : "Belum tersedia";
    const nomorTetap = Boolean(o.asli && o.asli.principleCode === kode && o.asli.bulan === setup.bulan && o.asli.tahun === setup.tahun);
    const dirty = useMemo(() => JSON.stringify({ setup, rows }) !== JSON.stringify(dasar), [setup, rows, dasar]);
    const perubahan = useMemo(() => ringkasPerubahan(dasar, { setup, rows }), [dasar, setup, rows]);
    const bayar = ringkasBayar(rows);

    const ubahSetup = (u: Partial<Setup>) => setSetup((s) => ({ ...s, ...u }));
    /** updateRow (kode lama): Tunai mengosongkan No Rekening. */
    const ubahBaris = <K extends keyof Baris>(id: string, field: K, value: Baris[K]) => setRows((cur) => cur.map((r) => (r.id === id
        ? { ...r, [field]: value, ...(field === "caraBayar" && caraBayar(String(value)) === "Tunai" ? { noRekening: "" } : {}) }
        : r)));
    /** updateRowType (kode lama): memilih tipe valid melepas penanda "Data Lama". */
    const ubahTipe = (id: string, value: string) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, type: value, typeIsLegacy: false } : r)));
    const tambah = () => { const b = barisKosong(); setRows((cur) => [...cur, b]); setTerpilih(b.id); };
    /** deleteRow (kode lama): minimal satu baris. */
    const hapus = (id: string) => {
        if (rows.length <= 1) return;
        const i = rows.findIndex((r) => r.id === id);
        const sisa = rows.filter((r) => r.id !== id);
        setRows(sisa);
        setTerpilih(sisa[Math.max(0, i - 1)].id);
    };

    /**
     * POST /batches (baru) atau PATCH /batches/[id] dengan body PERSIS kode lama (saveDraft / handleSubmitBatch). Tetap fetch sendiri
     * (butuh `code`/`conflicts` dari jawaban 409); kirimTulis hanya mengklasifikasi jawaban tidak pasti.
     */
    const simpanKe = async (force: boolean) => {
        const items = itemPayload(rows);
        const { res, data } = await kirimTulis(() => fetch(o.batchId ? `/api/off-program-control/batches/${o.batchId}` : "/api/off-program-control/batches", {
            method: o.batchId ? "PATCH" : "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                supervisorName: setup.supervisorName,
                principleCode: kode,
                principleName: setup.principleName,
                bulan: setup.bulan,
                tahun: setup.tahun,
                items,
                forceDuplicateNoSurat: force === true,
            }),
        }), pesanTidakPasti(o.batchId ? "perubahan batch ini" : "batch baru ini", o.batchId ? "Riwayat batch" : "antrean Draf & dikembalikan"));
        return { res, data, items };
    };
    const duplikatDari = (res: Response, data: Record<string, unknown>, mode: Duplikat["mode"]): Duplikat | null =>
        res.status === 409 && data.code === "DUPLICATE_NO_SURAT" && Array.isArray(data.conflicts)
            ? {
                mode, principleName: String(data.principleName || setup.principleName),
                // Server mengirim satu konflik per item (No Surat boleh sama dalam satu batch): satu baris per No Surat × batch.
                conflicts: Array.from(new Map((data.conflicts as KonflikNoSurat[]).map((c) => [`${c.noSurat}|${c.batchId}`, c])).values()),
            }
            : null;
    const noTersimpan = (data: Record<string, unknown>) => String(data.noPengajuan || (data.batch as BatchOpc | undefined)?.noPengajuan || generatedNo);

    /** saveDraft (kode lama). Galat dilempar (dialog duplikat menampilkannya; tombol footer menampilkannya di strip). */
    const simpanDraf = async (force: boolean) => {
        const { res, data } = await simpanKe(force).catch(tanganiTulis(o.onTidakPasti));
        const dup = duplikatDari(res, data, "draft");
        if (dup) {
            setDuplikat(dup);
            o.onPesan({ tone: "warn", judul: "Beberapa No Surat sudah pernah dipakai pada principal yang sama. Mohon konfirmasi." });
            return;
        }
        if (!res.ok || !data.ok) {
            const pesan = String(data.message || data.error || "Gagal menyimpan draf.");
            if (res.status === 409 && o.batchId && KONFLIK_STATUS.test(pesan)) o.onKonflik(pesan);
            throw new Error(pesan);
        }
        setDuplikat(null);
        setDasar({ setup, rows });
        o.onDrafTersimpan({ batchId: o.batchId || String(data.batchId || ""), noPengajuan: noTersimpan(data) });
    };

    const klikSimpanDraf = async () => {
        if (jalan.current) return;
        jalan.current = true;
        setSibukDraf(true);
        o.onPesan(null);
        try {
            await simpanDraf(false);
        } catch (e) {
            // Hasil tidak pasti sudah dilaporkan (onTidakPasti); jangan ditimpa "belum tersimpan" yang belum tentu benar.
            if (!(e instanceof TulisTidakPasti)) o.onPesan({ tone: "neg", judul: "Draf belum tersimpan.", isi: e instanceof Error ? e.message : "Gagal menyimpan draf." });
        } finally {
            jalan.current = false;
            setSibukDraf(false);
        }
    };

    /**
     * handleSubmitBatch (kode lama): simpan (POST/PATCH) LALU POST /submit — dua panggilan, urutan sama. Galat dilempar ke dialog.
     */
    const kirim = async (force: boolean) => {
        o.onPesan(null);
        const { res: saveRes, data: saveData, items } = await simpanKe(force).catch(tanganiTulis(o.onTidakPasti));
        const lokal = ringkasBayar(items);
        const dup = duplikatDari(saveRes, saveData, "submit");
        if (dup) {
            setDialogKirim(false);
            setDuplikat(dup);
            o.onPesan({ tone: "warn", judul: "Beberapa No Surat sudah pernah dipakai pada principal yang sama. Mohon konfirmasi sebelum dikirim ke SM." });
            return;
        }
        if (saveData.code === "ALREADY_SUBMITTED") {
            // kode lama: hasil kirim dari jawaban server + ringkasan lokal; submit TIDAK dipanggil.
            setDialogKirim(false);
            o.onSudahDikirim({
                batchId: String(saveData.existingBatchId || ""), noPengajuan: String(saveData.noPengajuan || generatedNo), rowCount: items.length,
                total: lokal.total, transfer: lokal.transfer, tunai: lokal.tunai, pdfUrl: String(saveData.pdfUrl || ""), sudahAda: true,
            });
            return;
        }
        if (!saveRes.ok || !saveData.ok) {
            const pesan = String(saveData.message || saveData.error || "Gagal menyimpan batch");
            if (saveRes.status === 409 && o.batchId && KONFLIK_STATUS.test(pesan)) o.onKonflik(pesan);
            throw new Error(pesan);
        }
        const savedBatchId = o.batchId || String(saveData.batchId || "");
        const savedNo = noTersimpan(saveData);
        setDasar({ setup, rows }); // perubahan sudah tersimpan walau submit nanti gagal

        // Fetch submit sama dengan kode lama (POST tanpa badan); kirimTulis memisahkan "tidak pasti" dari "gagal".
        let jawaban: Awaited<ReturnType<typeof kirimTulis>>;
        try {
            jawaban = await kirimTulis(() => fetch(`/api/off-program-control/batches/${savedBatchId}/submit`, { method: "POST", credentials: "include" }),
                pesanTidakPasti("pengiriman ke Sales Manager", "status batch"));
        } catch (e) {
            if (!(e instanceof TulisTidakPasti)) throw e;
            o.onGagalKirim({ batchId: savedBatchId, noPengajuan: savedNo }, e.message, false);
            return;
        }
        const { res: submitRes, data: submitData } = jawaban;
        if (!submitRes.ok || !submitData.ok) {
            o.onGagalKirim({ batchId: savedBatchId, noPengajuan: savedNo }, String(submitData.error || "Gagal mengirim batch"), true);
            return;
        }
        const ringkas = submitData.summary as { total?: number; transfer?: number; tunai?: number } | undefined;
        setDialogKirim(false);
        setDuplikat(null);
        o.onTerkirim({
            batchId: String(submitData.batchId || savedBatchId),
            noPengajuan: String(submitData.noPengajuan || savedNo),
            rowCount: items.length,
            total: Number(ringkas?.total || lokal.total),
            transfer: Number(ringkas?.transfer || lokal.transfer),
            tunai: Number(ringkas?.tunai || lokal.tunai),
            pdfUrl: String(submitData.pdfUrl || ""),
        });
    };

    return {
        batchId: o.batchId, setup, rows, kode, nomor, generatedNo, nomorSiap, nomorTampil, nomorTetap, dirty, perubahan, bayar, terpilih, setTerpilih,
        galatDraf: galatIsian(rows, "draft"), galatKirim: galatIsian(rows, "submit"),
        ubahSetup, ubahBaris, ubahTipe, tambah, hapus, sibukDraf, klikSimpanDraf, simpanDraf, kirim,
        dialogKirim, setDialogKirim, duplikat, setDuplikat, onPesan: o.onPesan,
    };
}

export type FormSpv = ReturnType<typeof useFormSpv>;

/** Setup batch (kode lama): hanya nama supervisor dan principal yang bisa diubah; bulan/tahun mengikuti batch (kode lama). */
export function SetupBatch({ f, catatan }: { f: FormSpv; catatan: string }) {
    return (
        <div className="fi-sect-in">
            <div className="fi-formgrid">
                <FormField label="Nama supervisor">{(a) => <input {...a} className="fi-input" value={f.setup.supervisorName} onChange={(e) => f.ubahSetup({ supervisorName: e.target.value })} />}</FormField>
                <FormField label="Principal">{(a) => (
                    <select {...a} className="fi-input" value={f.setup.principleName} onChange={(e) => f.ubahSetup({ principleName: e.target.value })}>
                        {offPrinciples.map((p) => <option key={p.code} value={p.name}>{p.name}</option>)}
                    </select>
                )}</FormField>
                <FormField label="Kode principal">{(a) => <input {...a} className="fi-input fi-mono" readOnly value={f.kode} />}</FormField>
                <FormField label="Gelombang otomatis">{(a) => <input {...a} className="fi-input fi-mono" readOnly value={f.generatedNo.split("/")[0] ?? ""} />}</FormField>
                <FormField label="Bulan">{(a) => <input {...a} className="fi-input fi-tnum" readOnly value={f.setup.bulan} />}</FormField>
                <FormField label="Tahun">{(a) => <input {...a} className="fi-input fi-tnum" readOnly value={f.setup.tahun} />}</FormField>
            </div>
            <div className="fi-field">
                <span className="fi-caption">{f.nomorTetap ? "No pengajuan" : "No pengajuan (perkiraan)"}</span>
                <span className="fi-mono fi-title-3" aria-live="polite">{f.nomorTampil}</span>
                {f.nomor.status === "memuat" && <span className="fi-help">Memuat No Pengajuan otomatis…</span>}
                {f.nomor.status === "galat" && <span className="fi-msg">{f.nomor.error}</span>}
            </div>
            <p className="fi-small fi-subtle">{catatan}</p>
        </div>
    );
}

const DOKUMEN: Array<[keyof Baris & ("kwt" | "skp" | "fp" | "pc" | "foto" | "rekap" | "others"), string]> = [
    ["kwt", "KWT"], ["skp", "SKP"], ["fp", "FP"], ["pc", "PC"], ["foto", "Foto"], ["rekap", "Rekap"], ["others", "Lainnya"],
];

/** Daftar item + form berlabel untuk item terpilih (it03 #13). Ponsel: daftar item (ResponsiveTable → ListItem), form di bawahnya. */
export function EditorItem({ f }: { f: FormSpv }) {
    const formId = useId();
    const [hapus, setHapus] = useState<Baris | null>(null);
    const nomor = new Map(f.rows.map((r, i) => [r.id, i + 1]));
    const r = f.rows.find((x) => x.id === f.terpilih) ?? f.rows[0];
    const n = nomor.get(r.id) ?? 1;
    const m = masalahBaris(r);
    const tunai = caraBayar(r.caraBayar) === "Tunai";
    const nDitandai = f.rows.filter(adaMasalah).length;
    const pilih = (id: string) => {
        f.setTerpilih(id);
        // Di ponsel form ada di bawah daftar: bawa ke form supaya isian langsung terlihat.
        requestAnimationFrame(() => document.getElementById(formId)?.scrollIntoView({ block: "start" }));
    };
    const tanda = (x: Baris) => (adaMasalah(x) ? <StatusBadge tone="warn">Perlu dilengkapi</StatusBadge> : x.id === r.id ? <StatusBadge tone="info">Sedang diubah</StatusBadge> : undefined);
    // Kolom mengikuti mockup it03 (No Surat · program, Toko, Nominal, Bayar, Kelengkapan, Ubah); tanda item di bawah No Surat.
    const kolom: Column<Baris>[] = [
        {
            key: "surat", header: "No Surat · program", cell: (x) => (
                <>
                    <span className="fi-caption">Item {nomor.get(x.id)}</span><br />
                    <span className="fi-mono">{x.noSurat || KOSONG}</span><br />{x.namaProgram || KOSONG}
                    {tanda(x) && <><br />{tanda(x)}</>}
                </>
            ),
        },
        { key: "toko", header: "Toko", cell: (x) => x.toko || KOSONG },
        { key: "nominal", header: "Nominal", align: "end", cell: (x) => <span className="fi-tnum">{rupiah(parseUiCurrency(x.nominal))}</span> },
        { key: "bayar", header: "Bayar · tipe", secondary: true, cell: (x) => `${x.caraBayar || KOSONG} · ${x.type || "tipe belum dipilih"}` },
        { key: "lengkap", header: "Kelengkapan", secondary: true, cell: (x) => kelengkapanItem(x) },
        {
            key: "ubah", header: "Aksi", cell: (x) => (
                <Button variant="tertiary" icon={<Pencil className="fi-icon" aria-hidden />} aria-pressed={x.id === r.id} aria-label={`Ubah item ${nomor.get(x.id)}`} onClick={() => pilih(x.id)}>Ubah</Button>
            ),
        },
    ];
    return (
        <>
            <div className="fi-sect-in" style={{ paddingBottom: 0 }}>
                <div className="fi-btnrow">
                    <span className="fi-small fi-tnum">
                        {f.rows.length} item · {rupiah(f.bayar.total)} (Transfer {rupiah(f.bayar.transfer)} · Tunai {rupiah(f.bayar.tunai)})
                        {nDitandai > 0 ? ` · ${nDitandai} perlu dilengkapi` : ""}
                    </span>
                    <span style={{ flex: 1 }} />
                    <Button icon={<Plus className="fi-icon" aria-hidden />} onClick={f.tambah}>Tambah item</Button>
                </div>
            </div>
            <ResponsiveTable title="Daftar item" columns={kolom} rows={f.rows} rowKey={(x) => x.id} empty={{ title: "Belum ada item" }}
                mobileItem={(x) => (
                    <ListItem doc={`Item ${nomor.get(x.id)} · ${x.noSurat || "tanpa No Surat"}`} amount={rupiah(parseUiCurrency(x.nominal))} title={x.toko || "Toko belum diisi"}
                        meta={[x.namaProgram, x.caraBayar, x.type || "tipe belum dipilih"].filter(Boolean).join(" · ")} badge={tanda(x)}
                        current={x.id === r.id} onClick={() => pilih(x.id)} />
                )} />
            <section id={formId} className="fi-sect-in" aria-label={`Ubah item ${n}`} style={{ borderTop: "1px solid var(--line)" }}>
                <div className="fi-btnrow">
                    <h3 className="fi-title-3" style={{ margin: 0 }}>Item {n}{r.toko ? ` · ${r.toko}` : ""}</h3>
                    <span style={{ flex: 1 }} />
                    <Button variant="negative" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={f.rows.length <= 1} disabledReason="Batch minimal punya satu item."
                        onClick={() => (terisi(r) ? setHapus(r) : f.hapus(r.id))}>Hapus item</Button>
                </div>
                <div className="fi-formgrid">
                    <FormField label="No Surat">{(a) => <input {...a} className="fi-input fi-mono" value={r.noSurat} onChange={(e) => f.ubahBaris(r.id, "noSurat", e.target.value)} />}</FormField>
                    <FormField label="Nama program">{(a) => <input {...a} className="fi-input" value={r.namaProgram} onChange={(e) => f.ubahBaris(r.id, "namaProgram", e.target.value)} />}</FormField>
                    <FormField label="Periode awal">{(a) => <input {...a} className="fi-input" type="date" value={r.periodeAwal} onChange={(e) => f.ubahBaris(r.id, "periodeAwal", e.target.value)} />}</FormField>
                    <FormField label="Periode akhir">{(a) => <input {...a} className="fi-input" type="date" value={r.periodeAkhir} onChange={(e) => f.ubahBaris(r.id, "periodeAkhir", e.target.value)} />}</FormField>
                    <FormField label="Toko">{(a) => <input {...a} className="fi-input" value={r.toko} onChange={(e) => f.ubahBaris(r.id, "toko", e.target.value)} />}</FormField>
                    <FormField label="Barang">{(a) => <input {...a} className="fi-input" value={r.barang} onChange={(e) => f.ubahBaris(r.id, "barang", e.target.value)} />}</FormField>
                    <FormField label="Nominal">{(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" placeholder="Rp 0" value={r.nominal} onChange={(e) => f.ubahBaris(r.id, "nominal", e.target.value)} />}</FormField>
                    <FormField label="Cara bayar">{(a) => (
                        <select {...a} className="fi-input" value={r.caraBayar} onChange={(e) => f.ubahBaris(r.id, "caraBayar", e.target.value)}>
                            {offPaymentMethods.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                    )}</FormField>
                    <FormField label="No rekening" required={!tunai} error={m.rekening} help={tunai ? "Tidak dipakai untuk Tunai." : undefined}>{(a) => (
                        <input {...a} className="fi-input fi-mono" readOnly={tunai} placeholder={tunai ? "-" : "No rekening tujuan"} value={r.noRekening} onChange={(e) => f.ubahBaris(r.id, "noRekening", e.target.value)} />
                    )}</FormField>
                    <FormField label="Tipe program" required error={m.tipe} help={r.typeIsLegacy && r.type ? `Data lama${r.originalType ? ` (${r.originalType})` : ""}.` : undefined}>{(a) => (
                        <select {...a} className="fi-input" value={r.type} onChange={(e) => f.ubahTipe(r.id, e.target.value)}>
                            <option value="">Pilih tipe…</option>
                            {OFF_PROGRAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                    )}</FormField>
                    <FormField label="Deadline">{(a) => <input {...a} className="fi-input" type="date" value={r.deadline} onChange={(e) => f.ubahBaris(r.id, "deadline", e.target.value)} />}</FormField>
                    <div className="fi-field">
                        <span className="fi-label">PPh</span>
                        {/* NOTE: PPh disiapkan nullable di level item/toko, tetapi perhitungan final ditahan karena masih terkait format kwitansi setelah pembayaran. */}
                        <label className="fi-check"><input type="checkbox" checked={r.pphExempt} onChange={(e) => f.ubahBaris(r.id, "pphExempt", e.target.checked)} />Tidak kena PPh</label>
                    </div>
                </div>
                <fieldset className="fi-field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                    <legend className="fi-label">Kelengkapan awal</legend>
                    <div className="fi-btnrow">
                        {DOKUMEN.map(([k, label]) => (
                            <label key={k} className="fi-check"><input type="checkbox" checked={r[k]} onChange={(e) => f.ubahBaris(r.id, k, e.target.checked)} />{label}</label>
                        ))}
                    </div>
                </fieldset>
                <FormField label="Dokumen lainnya">{(a) => <input {...a} className="fi-input" placeholder="Sebutkan dokumen lainnya" value={r.othersText} onChange={(e) => f.ubahBaris(r.id, "othersText", e.target.value)} />}</FormField>
                <p className="fi-small fi-subtle">Kelengkapan yang diisi Supervisor adalah informasi awal. Validasi aman/tidaknya tetap ditentukan oleh Klaim.</p>
            </section>
            <ConfirmDialog open={hapus !== null} onClose={() => setHapus(null)} tone="negative" tag="Hapus item"
                title={`Hapus item ${hapus ? nomor.get(hapus.id) ?? "" : ""}?`} confirmLabel="Hapus item"
                description="Isian item ini hilang dari form. Belum ada yang dikirim; perubahan baru tersimpan saat Simpan draf atau Kirim ke SM."
                facts={hapus ? [["No Surat", hapus.noSurat || KOSONG], ["Toko", hapus.toko || KOSONG], ["Nominal", rupiah(parseUiCurrency(hapus.nominal))]] : []}
                onConfirm={() => { if (hapus) f.hapus(hapus.id); setHapus(null); }} />
        </>
    );
}

/** Strip Draf (it03): perubahan belum disimpan; pindah batch/tab atau menutup halaman meminta konfirmasi (OpcApp + useUnsavedGuard). */
export function StripDraf({ f }: { f: FormSpv }) {
    if (!f.dirty) return null;
    return (
        <MessageStrip tone="warn" title="Perubahan belum disimpan:">
            {f.perubahan.length ? `${f.perubahan.length} perubahan` : "isian berubah"}. Pindah batch, pindah tab, atau menutup halaman akan meminta konfirmasi.
        </MessageStrip>
    );
}

/** Tombol footer: Simpan draf (sekunder) + Kirim ke SM… (utama, kanan). Nonaktif = alasan validasi kode lama / izin / konflik. */
export function AksiForm({ f, izinDraf, izinKirim, konflik }: { f: FormSpv; izinDraf?: string; izinKirim?: string; konflik: boolean }) {
    const muat = konflik ? "Muat ulang batch dulu." : undefined;
    const alasanDraf = muat ?? izinDraf ?? f.galatDraf;
    const alasanKirim = muat ?? izinKirim ?? f.galatKirim;
    return (
        <>
            <Button busy={f.sibukDraf} disabled={Boolean(alasanDraf)} disabledReason={alasanDraf} onClick={() => void f.klikSimpanDraf()}>Simpan draf</Button>
            <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(alasanKirim) || f.sibukDraf} disabledReason={alasanKirim}
                onClick={() => f.setDialogKirim(true)}>Kirim ke SM…</Button>
        </>
    );
}

export function pesanFooter(f: FormSpv, konflik: boolean): string {
    if (konflik) return "Perubahan Anda belum disimpan. Muat ulang batch untuk melihat versi terbaru.";
    if (f.galatKirim) return `Kirim nonaktif: ${f.galatKirim}`;
    return f.dirty ? `Draf belum disimpan · ${f.perubahan.length} perubahan.` : "Belum ada perubahan sejak dibuka.";
}

/** Dialog `kirimsm` (ringkasan perubahan, BL-09) dan dialog No Surat duplikat (DuplicateNoSuratPrompt kode lama). */
export function DialogForm({ f, baru }: { f: FormSpv; baru: boolean }) {
    const daftar = f.perubahan.slice(0, 8);
    const sisa = f.perubahan.length - daftar.length;
    const dup = f.duplikat;
    const kolomDup: Column<KonflikNoSurat>[] = [
        { key: "surat", header: "No Surat", cell: (c) => <span className="fi-mono">{c.noSurat}</span> },
        { key: "batch", header: "Dipakai di batch", cell: (c) => <span className="fi-mono">{c.noPengajuan}</span> },
        { key: "status", header: "Status batch", cell: (c) => labelStatus(c.status) },
    ];
    return (
        <>
            <ConfirmDialog
                open={f.dialogKirim}
                onClose={() => f.setDialogKirim(false)}
                tag="Kirim ke SM"
                // Nomor rakitan lokal tidak masuk judul sebelum nomor server siap.
                title={baru ? `Kirim batch baru${f.nomorSiap ? ` ${f.generatedNo}` : ""} ke SM?` : `Kirim ${f.nomorSiap ? f.generatedNo : "batch ini"} ke SM?`}
                description="Isian disimpan dulu, lalu batch dikirim ke Sales Manager dan PDF surat dibuat. Setelah terkirim, batch terkunci untuk Supervisor sampai dikembalikan."
                facts={[
                    ["Principal", `${f.setup.principleName} (${f.kode})`],
                    ["Item", <span key="i" className="fi-tnum">{f.rows.length} · {rupiah(f.bayar.total)}</span>],
                    ["Transfer · Tunai", <span key="t" className="fi-tnum">{rupiah(f.bayar.transfer)} · {rupiah(f.bayar.tunai)}</span>],
                    ["Perubahan sejak dibuka", baru ? "Batch baru" : daftar.length === 0 ? "Tidak ada; dikirim apa adanya" : (
                        <ul key="p" style={{ margin: 0, paddingLeft: "1.1em", textAlign: "left", fontWeight: 400 }}>
                            {daftar.map((p) => <li key={p}>{p}</li>)}
                            {sisa > 0 && <li>dan {sisa} perubahan lain</li>}
                        </ul>
                    )],
                    ["Penerima", `Sales Manager · batas tinjauan ${SLA_DAYS.smApproval} hari kerja`],
                ]}
                confirmLabel="Kirim ke SM"
                onConfirm={() => f.kirim(false)}
            />
            <ConfirmDialog
                open={dup !== null}
                onClose={() => {
                    const mode = dup?.mode;
                    f.setDuplikat(null);
                    f.onPesan({ tone: "info", judul: mode === "submit" ? "Pengiriman dibatalkan oleh Supervisor." : "Penyimpanan draf dibatalkan oleh Supervisor." });
                }}
                tag="No Surat sudah dipakai"
                tone="negative"
                title={dup?.mode === "submit" ? "Tetap kirim dengan No Surat yang sudah dipakai?" : "Tetap simpan dengan No Surat yang sudah dipakai?"}
                description={`Pada principal ${dup?.principleName ?? ""}, beberapa No Surat di batch ini sudah tercatat di pengajuan lain. Pastikan ini bukan pengajuan ganda.`}
                confirmLabel="Saya yakin, lanjutkan"
                onConfirm={() => (dup?.mode === "submit" ? f.kirim(true) : f.simpanDraf(true))}
            >
                {dup && (
                    <ResponsiveTable title="No Surat yang sudah dipakai" columns={kolomDup} rows={dup.conflicts} rowKey={(c) => `${c.noSurat}-${c.batchId}`}
                        empty={{ title: "Tidak ada rincian" }}
                        mobileItem={(c) => <ListItem doc={c.noSurat} title={c.noPengajuan} meta={labelStatus(c.status)} />} />
                )}
            </ConfirmDialog>
        </>
    );
}
