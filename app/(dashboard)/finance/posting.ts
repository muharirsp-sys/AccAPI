/*
 * Tujuan: Klien HTTP + orkestrasi tulis layar Finance (Fiori S6b; ZONA AGENTS §3 TULIS ACCURATE + UANG — wajib tinjauan manusia):
 *   baca pengajuan FastAPI + status attempt server + sesi Accurate, posting Purchase Payment 5 langkah (urutan, payload, dan format
 *   recordKey/clientRef SAMA dengan approveTransfer lama finance/page.tsx:385-516 — rekonsiliasi attempt lama), penyelesaian tidak
 *   pasti, ubah status transfer, simpan tujuan, master pemasok/rekening Accurate (baca-saja).
 * Caller: app/(dashboard)/finance/Finance.tsx.
 * Dependensi: lib/apiBase (FastAPI), lib/finance-post-status (certainlyNotSent, purchasePaymentConflict), lib/finance-ui.
 * Main Functions: recordKey, bacaSesi, muatFinance, muatMaster, simpanTujuan, postingPurchasePayment, selesaikanTidakPasti, ubahStatusTransfer.
 * Side Effects: FastAPI /payments/finance/{data,mapping,proof,update} (payments.json); Next /api/finance/purchase-payment
 *   (klaim attempt lalu purchase-payment/bulk-save.do ke Accurate), /attempts, /resolve; /api/auth/accurate-session;
 *   /api/proxy GET vendor/list.do & glaccount/list.do (baca-saja).
 */
import type { Load } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";
import { certainlyNotSent, purchasePaymentConflict } from "@/lib/finance-post-status";
import { alasanFaktur, bedaPengajuan, saringCatatan, type AttemptFinance } from "@/lib/finance-ui";

export type FinanceMapping = { principle?: string; vendorNo?: string; vendorName?: string; bankNo?: string; bankName?: string };
export type ProofMeta = { proof_id?: string; original_filename?: string; stored_filename?: string; sha256?: string; url?: string };
export type DetailInvoice = { record_id: string; invoiceNo: string; paymentAmount: number };
export type Resolusi = { from?: string; to?: string; source?: string; by?: string; at?: string; note?: string } | null;

export type FinanceRecord = {
    draft_label: string;
    draft_id: string;
    submission_id: string;
    principle: string;
    tipe_pengajuan: string;
    total_invoice: number;
    total_potongan: number;
    invoice_concat: string;
    detail_invoices: DetailInvoice[];
    total_nilai: number;
    keterangan: string;
    jenis_pembayaran?: string;
    payment_method: string;
    submitted_date: string;
    status_pembayaran: string;
    sppd_no?: string;
    transfer_date?: string;
    transfer_proof?: ProofMeta;
    /** Status BERLAKU dari server ("failed" lama bergalat ambigu = unknown); `_raw` = tersimpan apa adanya. */
    accurate_post_status?: string;
    accurate_post_status_raw?: string;
    accurate_post_error?: string;
    accurate_purchase_payment_number?: string;
    accurate_posted_by?: string;
    /** WITA (kontrak S6-0e). */
    accurate_posted_at?: string;
    accurate_post_resolution?: Resolusi;
    mapping?: FinanceMapping;
};

export type SesiAccurate = { tersambung: boolean; alias: string; id: string };

export type DataFinance = {
    rows: FinanceRecord[];
    total: number;
    /** Tanggal bayar data ini (dipakai saat menulis status, bukan isian tanggal yang mungkin sudah berganti). */
    date: string;
    attempts: Map<string, AttemptFinance | null>;
    attemptsGalat?: string;
    sesi: SesiAccurate | null;
    sesiGalat?: string;
    /** Date.now() saat dimuat — umur attempt bertambah sejak itu. */
    dimuat: number;
};

const API_BASE = resolveApiBase();
const SERVER_DIAM = "Server Pembayaran tidak menjawab.";
let cachedCsrfToken = "";

/** URL berkas FastAPI (ekspor Excel, bukti tersimpan) — dibuka peramban dengan cookie sesi. */
export const urlBerkas = (path: string) => `${API_BASE}${path}`;

/** Jawaban tulis TIDAK PASTI (koneksi putus, status ≥ 502, badan bukan JSON): tulisannya mungkin sudah terjadi. */
export class TidakPasti extends Error {}

/** Penyelesaian tercatat di server posting, tetapi catatan Finance ditolak: JANGAN diulang buta — muat ulang lalu periksa status. */
export class SeparuhJalan extends Error {}

/** Kunci baris = clientRef command. FORMAT TIDAK BOLEH BERUBAH: attempt lama dicocokkan dengan string ini (sameRecord). */
export function recordKey(record: FinanceRecord) {
    return `${record.draft_id || "-"}|${record.submission_id || "-"}|${record.principle}|${record.tipe_pengajuan}`;
}

function toAccurateDate(ymd: string) {
    const [year, month, day] = ymd.split("-");
    if (!year || !month || !day) return "";
    return `${day}/${month}/${year}`;
}

/** Galat FastAPI menurut KODE status (sebagian pesan warisan berbahasa Inggris: "Forbidden", "CSRF token invalid"). */
function galatFastapi(status: number, error: unknown, umum: string): string {
    if (status === 401) return "Sesi berakhir. Masuk ulang lalu ulangi.";
    if (status === 403) return "Akun Anda belum berwenang untuk aksi ini, atau token keamanan kedaluwarsa (muat ulang halaman).";
    const teks = saringCatatan(typeof error === "string" ? error : "");
    return teks || `${umum} (HTTP ${status}).`;
}

async function bacaTeks(res: Response): Promise<Record<string, unknown> | null> {
    const text = await res.text().catch(() => "");
    try {
        const j: unknown = text ? JSON.parse(text) : null;
        return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

async function getBackendCsrfToken(forceRefresh = false): Promise<string> {
    if (cachedCsrfToken && !forceRefresh) return cachedCsrfToken;
    let res: Response;
    try {
        res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
    } catch {
        throw new Error(`${SERVER_DIAM} Tidak ada yang diubah.`);
    }
    const data = await bacaTeks(res);
    if (!res.ok || !data?.csrf_token) throw new Error("Token keamanan server Pembayaran tidak tersedia; muat ulang halaman lalu ulangi.");
    cachedCsrfToken = String(data.csrf_token);
    return cachedCsrfToken;
}

/**
 * POST ke FastAPI (JSON atau FormData) dengan CSRF; 403 → token segar lalu ulang sekali (kode lama). Jawaban `ok` → data;
 * penolakan jelas (JSON, < 502) → Error(pesan); putus / ≥ 502 / bukan JSON → TidakPasti.
 */
async function postFastapi(path: string, body: unknown, umum: string): Promise<Record<string, unknown>> {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const init = (token: string): RequestInit => ({
        method: "POST",
        credentials: "include",
        headers: isForm ? { "X-CSRF-Token": token } : { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: isForm ? (body as FormData) : JSON.stringify(body),
    });
    const kirim = async (token: string) => {
        try {
            return await fetch(`${API_BASE}${path}`, init(token));
        } catch {
            throw new TidakPasti(`${SERVER_DIAM} Hasilnya belum pasti.`);
        }
    };
    let res = await kirim(await getBackendCsrfToken());
    if (res.status === 403) res = await kirim(await getBackendCsrfToken(true));
    const data = await bacaTeks(res);
    if (res.status >= 502 || data === null) throw new TidakPasti(`Server Pembayaran tidak memberi jawaban yang pasti (HTTP ${res.status}).`);
    if (!res.ok || data.ok !== true) throw new Error(galatFastapi(res.status, data.error, umum));
    return data;
}

// ── Baca ────────────────────────────────────────────────────────────────────────────────────────────────

async function bacaFinance(date: string): Promise<Load<{ rows: FinanceRecord[]; total: number; date: string }>> {
    let res: Response;
    try {
        res = await fetch(`${API_BASE}/payments/finance/data?date=${encodeURIComponent(date)}`, { credentials: "include", cache: "no-store" });
    } catch {
        return { status: "galat", error: `${SERVER_DIAM} Daftar pengajuan tidak bisa dimuat; tidak ada yang dikirim ke Accurate.` };
    }
    const data = await bacaTeks(res);
    if (!res.ok || data?.ok !== true) {
        const umum = data === null ? `Server Pembayaran memberi jawaban yang tidak terbaca (HTTP ${res.status})` : "Daftar pengajuan gagal dimuat";
        return { status: "galat", error: data === null ? `${umum}.` : galatFastapi(res.status, data.error, umum) };
    }
    return {
        status: "siap",
        data: { rows: (data.data as FinanceRecord[] | undefined) ?? [], total: Number(data.total_all || 0), date: String(data.date || date) },
    };
}

/** Sesi Accurate SEGAR (tanpa cache): database yang terbuka sekarang. Dipakai saat memuat daftar dan saat dialog BL-03 dibuka. */
export async function bacaSesi(): Promise<{ sesi: SesiAccurate | null; galat?: string }> {
    try {
        const res = await fetch("/api/auth/accurate-session", { cache: "no-store" });
        const d = (await bacaTeks(res)) as { databaseConnected?: boolean; databaseAlias?: string | null; databaseId?: string | number | null } | null;
        if (!res.ok || !d) return { sesi: null, galat: res.status === 401 ? "Sesi berakhir. Masuk ulang." : "Sesi Accurate tidak terbaca." };
        return { sesi: { tersambung: Boolean(d.databaseConnected), alias: String(d.databaseAlias ?? ""), id: d.databaseId == null ? "" : String(d.databaseId) } };
    } catch {
        return { sesi: null, galat: "Sesi Accurate tidak terbaca." };
    }
}

/**
 * Status attempt server per baris (maks. 100 kelompok per permintaan); baris tanpa faktur sah tidak ditanyakan (= null).
 * ponytail: nomor faktur yang memuat koma terpecah di parameter GET (subjek beda dari POST) → tampil "belum"; server tetap
 * memblokir posting kedua lewat klaim 409. Kirim kelompok sebagai JSON bila nomor berkoma pernah muncul.
 */
async function bacaAttempts(rows: FinanceRecord[]): Promise<{ map: Map<string, AttemptFinance | null>; galat?: string }> {
    const map = new Map<string, AttemptFinance | null>();
    const ditanya = rows.filter((r) => !alasanFaktur(r.detail_invoices));
    for (const r of rows) map.set(recordKey(r), null);
    for (let i = 0; i < ditanya.length; i += 100) {
        const bagian = ditanya.slice(i, i + 100);
        const q = bagian.map((r) => `invoices=${encodeURIComponent(r.detail_invoices.map((d) => d.invoiceNo.trim()).join(","))}`).join("&");
        try {
            const res = await fetch(`/api/finance/purchase-payment/attempts?${q}`, { cache: "no-store" });
            const d = await bacaTeks(res);
            const isi = d?.data as Array<{ attempt: AttemptFinance | null }> | undefined;
            if (!res.ok || d?.ok !== true || !Array.isArray(isi) || isi.length !== bagian.length) {
                return { map, galat: saringCatatan(typeof d?.error === "string" ? d.error : "") || `Status posting dari server tidak terbaca (HTTP ${res.status}).` };
            }
            bagian.forEach((r, j) => map.set(recordKey(r), isi[j]?.attempt ?? null));
        } catch {
            return { map, galat: "Status posting dari server tidak terbaca (koneksi putus)." };
        }
    }
    return { map };
}

/** Pengajuan tanggal bayar `date` + status attempt server + sesi Accurate. Galat daftar = galat; attempt/sesi gagal dicatat terpisah. */
export async function muatFinance(date: string): Promise<Load<DataFinance>> {
    const [daftar, sesi] = await Promise.all([bacaFinance(date), bacaSesi()]);
    if (daftar.status !== "siap" || !daftar.data) return { status: "galat", error: daftar.error };
    const attempts = await bacaAttempts(daftar.data.rows);
    return {
        status: "siap",
        data: { ...daftar.data, attempts: attempts.map, attemptsGalat: attempts.galat, sesi: sesi.sesi, sesiGalat: sesi.galat, dimuat: Date.now() },
    };
}

export type OpsiMaster = { no: string; nama: string };
export type MasterAccurate = { pemasok: OpsiMaster[]; rekening: OpsiMaster[]; terpotong: boolean };

/** list.do lewat /api/proxy method GET (baca-saja; pola api-wrapper). Maks. 10 halaman × 1000. */
async function daftarAccurate(endpointPath: string, fields: string, pick: (x: Record<string, unknown>) => OpsiMaster | null) {
    const semua: OpsiMaster[] = [];
    let page = 1;
    let pageCount = 1;
    do {
        const res = await fetch("/api/proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpointPath, method: "GET", payload: { fields, "sp.pageSize": 1000, "sp.page": page } }),
        });
        const d = (await bacaTeks(res)) as { s?: boolean; d?: unknown; sp?: { pageCount?: number }; error?: string } | null;
        if (!res.ok || !d?.s || !Array.isArray(d.d)) throw new Error(saringCatatan(typeof d?.error === "string" ? d.error : "") || `HTTP ${res.status}`);
        for (const x of d.d as Record<string, unknown>[]) { const o = pick(x); if (o) semua.push(o); }
        pageCount = Number(d.sp?.pageCount ?? 1) || 1;
        page += 1;
    } while (page <= pageCount && page <= 10);
    return { semua: semua.sort((a, b) => a.nama.localeCompare(b.nama, "id")), terpotong: pageCount > 10 };
}

/** Master pemasok dan rekening Kas/Bank dari database Accurate sesi ini (it02 #13). Tidak menulis apa pun. */
export async function muatMaster(): Promise<Load<MasterAccurate>> {
    try {
        const [pemasok, rekening] = await Promise.all([
            // ponytail: nama field vendor/glaccount belum diuji di Accurate nyata (D-16: tanpa panggilan Accurate) — vendorNo|no dibaca keduanya.
            daftarAccurate("/api/vendor/list.do", "id,vendorNo,name,suspended", (x) => {
                const no = String(x.vendorNo ?? x.no ?? "").trim();
                return no && x.suspended !== true ? { no, nama: String(x.name ?? "") } : null;
            }),
            daftarAccurate("/api/glaccount/list.do", "id,no,name,accountType,suspended", (x) => {
                const no = String(x.no ?? "").trim();
                const kasBank = x.accountType == null || x.accountType === "CASH_BANK";
                return no && kasBank && x.suspended !== true ? { no, nama: String(x.name ?? "") } : null;
            }),
        ]);
        return { status: "siap", data: { pemasok: pemasok.semua, rekening: rekening.semua, terpotong: pemasok.terpotong || rekening.terpotong } };
    } catch (e) {
        const pesan = e instanceof Error ? e.message : "";
        return { status: "galat", error: `Daftar pemasok/rekening Accurate gagal dimuat${pesan && !/^HTTP/.test(pesan) ? `: ${pesan}` : "."}` };
    }
}

// ── Tulis ───────────────────────────────────────────────────────────────────────────────────────────────

/** Simpan tujuan (mapping per principal di FastAPI). Lempar Error/TidakPasti bila gagal. */
export async function simpanTujuan(record: FinanceRecord, mapping: FinanceMapping) {
    if (!mapping.vendorNo || !mapping.bankNo) throw new Error("Pemasok dan rekening bank Accurate wajib dipilih.");
    await postFastapi("/payments/finance/mapping", {
        principle: record.principle,
        vendorNo: mapping.vendorNo,
        vendorName: mapping.vendorName || "",
        bankNo: mapping.bankNo,
        bankName: mapping.bankName || "",
    }, "Tujuan gagal disimpan");
}

function updateFinanceStatus(record: FinanceRecord, date: string, body: Record<string, unknown>) {
    return postFastapi("/payments/finance/update", {
        items: [{
            principle: record.principle,
            tipe_pengajuan: record.tipe_pengajuan,
            submission_id: record.submission_id,
            draft_id: record.draft_id,
            date,
            ...body,
        }],
    }, "Status Finance gagal disimpan");
}

/** Tandai belum transfer / kembalikan ke Pembayaran (Ajukan Ulang). Server menolak 409 bila posting posted/unknown (BL-49). */
export async function ubahStatusTransfer(record: FinanceRecord, date: string, status: "Belum Transfer" | "Ajukan Ulang") {
    await updateFinanceStatus(record, date, { status_pembayaran: status });
}

async function uploadProof(file: File | null, existing?: ProofMeta) {
    if (existing?.proof_id) return existing;
    if (!file) throw new Error("Bukti transfer wajib diunggah.");
    const fd = new FormData();
    fd.append("file", file);
    const res = await postFastapi("/payments/finance/proof", fd, "Bukti transfer gagal diunggah");
    return res.proof as ProofMeta;
}

type PurchasePaymentPayload = {
    bankNo: string; vendorNo: string; chequeAmount: number; transDate: string; chequeDate: string; paymentMethod: string; description: string;
    detailInvoice: Array<{ invoiceNo: string; paymentAmount: number }>;
};

function buildPurchasePaymentPayload(record: FinanceRecord, mapping: FinanceMapping, proof: ProofMeta, transferDate: string): PurchasePaymentPayload[] {
    const invalidInvoices = (record.detail_invoices || []).filter((item) => {
        const invoice = String(item.invoiceNo || "").trim().toUpperCase();
        return !invoice || invoice === "BELUM ADA";
    });
    if (invalidInvoices.length > 0 || !record.detail_invoices?.length) {
        throw new Error("No Invoice wajib valid sebelum post purchase-payment Accurate. Invoice kosong/BELUM ADA tidak boleh dipost.");
    }
    const accDate = toAccurateDate(transferDate);
    return [{
        bankNo: mapping.bankNo || "",
        vendorNo: mapping.vendorNo || "",
        chequeAmount: Number(record.total_nilai || 0),
        transDate: accDate,
        chequeDate: accDate,
        paymentMethod: "BANK_TRANSFER",
        description: [
            `SPPD: ${record.sppd_no || "-"}`,
            `Draft: ${record.draft_label || record.draft_id || "-"}`,
            `Submission: ${record.submission_id || "-"}`,
            `Bukti: ${proof.stored_filename || proof.original_filename || "-"}`,
            `SHA256: ${(proof.sha256 || "").slice(0, 16)}`,
        ].join(" | "),
        detailInvoice: record.detail_invoices.map((item) => ({
            invoiceNo: item.invoiceNo,
            paymentAmount: Number(item.paymentAmount || 0),
        })),
    }];
}

export type HasilPosting =
    | { jenis: "terposting"; nomor: string; catatan?: string }
    /** Record ini sedang diposting sesi/tab lain (attempt `sending` segar): TIDAK ada tulis ledger dari tab ini. */
    | { jenis: "sedang"; pesan: string }
    /** Mungkin sudah tersimpan di Accurate: baris dikunci sampai Finance menyelesaikan. `nomor` = nomor PP yang SUDAH dijawab Accurate
     *  (posting terjadi, hanya catatan Finance yang gagal). */
    | { jenis: "tidak_pasti"; pesan: string; nomor?: string }
    /** Koneksi ke Accurate tak pernah terbentuk (`not_sent`; penolakan Accurate = TIDAK PASTI, C11): boleh diposting ulang. */
    | { jenis: "gagal"; pesan: string }
    /** Pasti tidak terkirim ke Accurate. `tercatat` = catatan "gagal" sudah ditulis ke FastAPI (bukti sudah terunggah). */
    | { jenis: "tidak_terkirim"; pesan: string; tercatat: boolean };

type CommandOut = {
    state?: string; accurateId?: string; accurateNumber?: string; message?: string; response?: unknown; error?: string;
    generation?: number; currentGeneration?: number; claimed?: boolean; code?: string;
    live?: { attemptId: string; state: string; accurateId: string; accurateNumber: string; targetDbId: string; sameRecord: boolean; sameTarget: boolean; stale?: boolean } | null;
} | null;

/**
 * Transfer & posting satu pengajuan — urutan SAMA dengan approveTransfer lama: pra-cek → sesi Accurate → simpan tujuan → unggah
 * bukti → command server (klaim attempt SEBELUM kirim; clientRef = recordKey) → catat hasil ke FastAPI. Yang berubah hanya
 * penyajian: hasil dikembalikan (bukan toast). `kunciLokal` dipanggil SEBELUM pencatatan "unknown" ke server (review #3: bila
 * pencatatan gagal, baris tetap terkunci di tab ini).
 * Galat yang DILEMPAR = belum ada yang ditulis ke mana pun (dialog tetap terbuka); selain itu hasil dikembalikan.
 */
export async function postingPurchasePayment(p: {
    record: FinanceRecord; mapping: FinanceMapping; transferDate: string; proofFile: File | null; date: string; kunciLokal: () => void;
    /** Database yang DITAMPILKAN di dialog BL-03 (bacaan segar). Server menolak 409 bila sesi saat POST berbeda (tinjauan A-1). */
    expectedDatabaseId: string;
}): Promise<HasilPosting> {
    const { record, mapping, transferDate, date } = p;
    const key = recordKey(record);
    if (record.accurate_post_status === "posted") throw new Error("Pengajuan ini sudah terposting ke Accurate.");
    if (!transferDate) throw new Error("Tanggal transfer wajib diisi.");
    if (!mapping.vendorNo || !mapping.bankNo) throw new Error("Pemasok dan rekening bank Accurate wajib lengkap.");
    if (!p.expectedDatabaseId) throw new Error("Database Accurate tujuan belum terbaca; tutup lalu buka lagi dialog ini. Tidak ada yang dikirim.");
    let sessionData: { databaseConnected?: boolean; databaseId?: string | number | null; databaseAlias?: string | null } | null = null;
    try {
        const sessionRes = await fetch("/api/auth/accurate-session", { cache: "no-store" });
        sessionData = sessionRes.ok ? (await bacaTeks(sessionRes)) as typeof sessionData : null;
    } catch { /* sessionData tetap null */ }
    if (!sessionData?.databaseConnected) throw new Error("Login dan buka database Accurate dulu sebelum posting. Tidak ada yang dikirim.");
    // Tinjauan A-1: sesi bisa berganti database di tab lain sejak dialog dibuka — berhenti SEBELUM simpan tujuan (belum ada yang ditulis).
    if (String(sessionData.databaseId ?? "") !== p.expectedDatabaseId) {
        throw new Error(`Database Accurate berganti sejak dialog dibuka (sekarang ${sessionData.databaseAlias || `ID ${sessionData.databaseId ?? "–"}`}). Tidak ada yang dikirim; muat ulang lalu periksa tujuan.`);
    }
    // Tinjauan B-5: data di layar bisa usang (tab/orang lain mengubah pengajuan). Baca ulang baris ini SEBELUM langkah tulis pertama.
    const segar = await bacaFinance(date);
    if (segar.status !== "siap" || !segar.data) throw new Error("Data pengajuan terbaru tidak terbaca; tidak ada yang dikirim. Muat ulang lalu ulangi.");
    const beda = bedaPengajuan(record, segar.data.rows.find((r) => recordKey(r) === key));
    if (beda) throw new Error(`Pengajuan berubah sejak dimuat (${beda}); tidak ada yang dikirim. Tutup dialog, muat ulang, lalu periksa lagi.`);

    let proof: ProofMeta | undefined;
    let payload: PurchasePaymentPayload[] = [];
    let sent = false;
    let accurateRes: unknown;
    let posted: { id: string; number: string; note?: string } | null = null;
    // Command server menolak SEBELUM klaim (4xx / claimed:false) = pasti belum terkirim ke Accurate.
    let notSent = false;
    // AM-014: "failed" hanya bila Accurate MENJAWAB menolak (atau gagal sebelum terkirim). Timeout/non-JSON/gateway/sukses tanpa
    // id = "unknown": baris dikunci sampai seseorang memeriksa purchase-payment di Accurate — mengulang buta = bayar dua kali.
    const recordNotPosted = async (postStatus: "failed" | "unknown", message: string, response?: unknown) => {
        if (postStatus === "unknown") p.kunciLokal();
        if (!proof?.proof_id) return false;
        try {
            await updateFinanceStatus(record, date, {
                status_pembayaran: "Sudah Transfer",
                transfer_date: transferDate,
                proof_id: proof.proof_id,
                accurate_post_status: postStatus,
                accurate_post_error: message.slice(0, 1000),
                ...(response === undefined ? {} : { accurate_post_response: response }),
                accurate_payload_digest: `${proof.sha256 || ""}:${JSON.stringify(payload).length}`,
            });
            return true;
        } catch {
            // galat Accurate yang asli tetap yang ditampilkan
            return false;
        }
    };
    try {
        await simpanTujuan(record, mapping);
        proof = await uploadProof(p.proofFile, record.transfer_proof);
        payload = buildPurchasePaymentPayload(record, mapping, proof, transferDate);
        sent = true;
        // AM-014 / C.12: server mengklaim attempt SEBELUM kirim, jadi reload / tab lain / user lain untuk himpunan faktur yang
        // sama mendapat 409, bukan purchase-payment kedua.
        const res = await fetch("/api/finance/purchase-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientRef: key, expectedDatabaseId: p.expectedDatabaseId, payload }),
        });
        const out = (await bacaTeks(res)) as CommandOut;
        if (res.status === 409 && out?.claimed === false) {
            // 409 SEBELUM klaim (database sesi berganti, tinjauan A-1) = pasti belum terkirim; bukan konflik attempt.
            notSent = true;
            throw new Error(out.error || "Command posting menolak sebelum kirim (HTTP 409).");
        }
        const conflict = res.status === 409 ? purchasePaymentConflict(out) : null;
        if (conflict === "in_flight") {
            // Tinjauan S6-0a: record INI sedang diposting sesi/tab lain — hasilnya dicatat sesi itu. Menulis "unknown" di sini bisa
            // mendahului "posted"-nya lalu membuatnya tertolak (post_status_conflict).
            return { jenis: "sedang", pesan: "Pengajuan ini sedang diposting dari sesi atau tab lain; hasilnya dicatat sesi itu." };
        }
        if (conflict === "posted" && out?.live) {
            // Attempt record INI di database INI sudah posted (mis. browser ditutup sebelum mencatat). Record/draft/database lain
            // dengan faktur yang sama TIDAK ditandai posted (review M3).
            posted = { id: out.live.accurateId, number: out.live.accurateNumber, note: `attempt server ${out.live.attemptId} sudah posted ${out.live.accurateNumber}` };
        } else if (res.status === 409) {
            const why = out?.live?.state === "posted"
                ? `${out.error} Dari record/database lain (${out.live.targetDbId}) — periksa sebelum menandai apa pun.`
                : out?.error || "attempt sebelumnya belum pasti";
            await recordNotPosted("unknown", why, out?.live);
            return { jenis: "tidak_pasti", pesan: saringCatatan(why) };
        } else if (!res.ok || !out?.state) {
            // claimed:false (validasi/izin/sesi/DB sebelum klaim) = pasti belum terkirim -> tidak dikunci.
            notSent = certainlyNotSent(res.status, out);
            throw new Error(out?.error || `Command posting gagal (HTTP ${res.status})`);
        } else {
            accurateRes = out.response;
            if (out.state !== "posted") {
                const failed = out.state === "rejected" || out.state === "not_sent";
                await recordNotPosted(failed ? "failed" : "unknown", out.message || out.state, out.response);
                return failed ? { jenis: "gagal", pesan: saringCatatan(out.message || out.state) } : { jenis: "tidak_pasti", pesan: saringCatatan(out.message || out.state) };
            }
            posted = { id: out.accurateId || "", number: out.accurateNumber || "" };
        }
        await updateFinanceStatus(record, date, {
            status_pembayaran: "Sudah Transfer",
            transfer_date: transferDate,
            proof_id: proof.proof_id,
            accurate_post_status: "posted",
            accurate_purchase_payment_number: posted.number,
            accurate_purchase_payment_id: posted.id,
            accurate_post_response: accurateRes ?? out?.live,
            accurate_payload_digest: `${proof.sha256 || ""}:${JSON.stringify(payload).length}`,
            ...(posted.note ? { resolution_note: posted.note } : {}),
        });
        return { jenis: "terposting", nomor: posted.number, catatan: posted.note };
    } catch (err: unknown) {
        const message = err instanceof Error && err.message ? err.message : "Gagal posting purchase-payment Accurate.";
        const pesan = saringCatatan(message) || "Posting purchase-payment Accurate gagal.";
        // Belum sampai command, atau command menolak sebelum klaim = pasti tidak terkirim. Selain itu (jaringan putus ke command,
        // 5xx, pencatatan "posted" ke FastAPI gagal) server MUNGKIN sudah mengirim: tidak pasti, attempt server tetap memblokir.
        if (!sent || notSent) {
            const tercatat = await recordNotPosted("failed", message, accurateRes);
            return { jenis: "tidak_terkirim", pesan, tercatat };
        }
        await recordNotPosted("unknown", message, accurateRes);
        return { jenis: "tidak_pasti", pesan, ...(posted?.number ? { nomor: posted.number } : {}) };
    }
}

const PESAN_RESOLVE: Record<string, string> = {
    wrong_database: "Percobaan ini dikirim ke database Accurate lain. Buka database itu, periksa di sana, lalu selesaikan.",
    in_flight: "Percobaan baru saja dikirim — Accurate mungkin masih memproses. Tunggu 2 menit lalu periksa lagi.",
    changed: "Percobaan berubah saat diselesaikan. Muat ulang lalu periksa lagi.",
    already_posted: "Server sudah mencatat percobaan ini TERPOSTING. Pilih “Ada di Accurate” dengan nomor Purchase Payment-nya.",
};

/**
 * Penyelesaian TIDAK PASTI oleh Finance (D-14; atestasi manual, bukan verifikasi provider): attempt server dulu, lalu catatan FastAPI.
 * Toleran: 404 no_open_attempt (unknown lama tanpa attempt server, atau attempt sudah diselesaikan tetapi catatan tertinggal) dan
 * already_posted bila keputusannya "ada". Lempar Error = tidak ada yang berubah / pesan untuk dialog; TidakPasti = jawaban tidak jelas.
 */
export async function selesaikanTidakPasti(p: { record: FinanceRecord; date: string; ada: boolean; nomor: string; sumber: string; alasan: string }) {
    const { record } = p;
    const number = p.ada ? p.nomor.trim() : "";
    let r: Response;
    try {
        r = await fetch("/api/finance/purchase-payment/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                invoiceNos: (record.detail_invoices || []).map((it) => it.invoiceNo),
                decision: number ? "posted" : "absent",
                accurateNumber: number,
                reason: p.alasan.trim(),
                checkedSource: p.sumber.trim(),
            }),
        });
    } catch {
        throw new TidakPasti("Server tidak memberi jawaban yang pasti; penyelesaian mungkin sudah tercatat.");
    }
    const out = (await bacaTeks(r)) as { code?: string; error?: string } | null;
    if (r.status >= 502 || out === null) throw new TidakPasti(`Server tidak memberi jawaban yang pasti (HTTP ${r.status}); penyelesaian mungkin sudah tercatat.`);
    const serverOk = r.ok || (r.status === 404 && out.code === "no_open_attempt") || (out.code === "already_posted" && Boolean(number));
    if (!serverOk) {
        const pesan = r.status === 401 ? "Sesi berakhir. Masuk ulang lalu ulangi."
            : r.status === 403 ? "Hanya Finance yang berwenang menyelesaikan posting tidak pasti."
            : (out.code && PESAN_RESOLVE[out.code]) || saringCatatan(out.error) || `Penyelesaian ditolak server (HTTP ${r.status}).`;
        throw new Error(pesan);
    }
    // D-14: alasan dan sumber yang DIKETIK Finance ikut tersimpan di catatan FastAPI (accurate_post_resolution.note, ≥ 15 karakter).
    const dasar = number ? `dicek manual di Accurate: ${number} ada` : "dicek manual di Accurate: tidak ditemukan";
    try {
        await updateFinanceStatus(record, p.date, {
            status_pembayaran: "Sudah Transfer",
            transfer_date: record.transfer_date || "",
            proof_id: record.transfer_proof?.proof_id || "",
            accurate_post_status: number ? "posted" : "failed",
            ...(number ? { accurate_purchase_payment_number: number } : { accurate_post_error: "dicek manual: tidak ada di Accurate" }),
            resolution_note: `${dasar} — ${p.sumber.trim()}: ${p.alasan.trim()}`.slice(0, 500),
        });
    } catch (e) {
        if (e instanceof TidakPasti) throw e;
        // Tinjauan B-4: attempt server sudah selesai, catatan Finance ditolak (mis. 400 tanggal transfer/bukti belum ada di rekaman lama).
        // Mengulang dari dialog yang sama akan ditolak lagi — penanggung jawab memeriksa status setelah dimuat ulang.
        throw new SeparuhJalan(`Penyelesaian tercatat di server posting, tetapi catatan Finance gagal disimpan: ${e instanceof Error ? e.message : ""}`);
    }
    return number;
}
