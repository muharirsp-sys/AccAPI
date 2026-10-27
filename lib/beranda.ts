/*
 * Tujuan: Katalog tile tugas dan kartu pantauan Beranda per peran, dari endpoint yang SUDAH ada (tanpa logic baru).
 * Caller: app/(dashboard)/Beranda.tsx; lib/beranda.test.ts.
 * Dependensi: lib/rbac (izin halaman tujuan); endpoint GET yang dibaca di browser (lihat SOURCES).
 * Main Functions: SOURCES, sourceValid, TILES (termasuk 3 tile Kasir, K3), tilesFor, CARDS (incaso: perDatabase + database aktif + baris ?rows=1), cardFor, linksFor, witaToday.
 * Side Effects: Tidak ada; fungsi murni atas JSON respons.
 */

import { canAccessPathWithKeys } from "@/lib/rbac";

export type Tone = "pos" | "neg" | "warn" | "info" | "neu";
/**
 * `more` = daftar sumber terpotong (batas endpoint): angka tampil "N+" dan tidak pernah "semua beres".
 * `value: null` = BELUM TERBACA (K3: Incaso belum lengkap) — bukan nol; tampil "—" dan tidak pernah "semua beres".
 */
export type TileValue = { value: number | null; unit: string; tone: Tone; footer: string; more?: boolean };
type Row = Record<string, unknown>;

/** Sumber data: satu permintaan per sumber per muat halaman, dipakai bersama beberapa tile. Izin = penjaga endpoint-nya. */
export const SOURCES = {
    outbox: { perm: "order.view", url: () => "/api/invoice-outbox", label: "Antrean faktur" },
    verify: { perm: "order.view", url: () => "/api/invoice-verify", label: "Verifikasi balik faktur" },
    wave: { perm: "rekapan_nota.view", url: (today: string) => `/api/rekapan-nota/wave?tanggal=${today}`, label: "Wave hari ini" },
    kanvas: { perm: "rekapan_nota.view", url: (today: string) => `/api/rekapan-nota/kanvas?tanggal=${today}`, label: "Nota kanvas" },
    // ponytail: daftar OPC = 200 pengajuan terbaru (batas endpoint); hitungan di luar 200 itu tidak terlihat. Endpoint hitung khusus bila perlu.
    opc: { perm: "off_program_control.view", url: () => "/api/off-program-control/batches", label: "OFF Program Control" },
    claimOutstanding: { perm: "claim_workflow.view", url: () => "/api/claim-workflow/outstanding", label: "Klaim outstanding" },
    claimPaid: { perm: "claim_workflow.view", url: () => "/api/claim-workflow?status=Paid&limit=200", label: "Klaim lunas" },
    users: { perm: "users.manage", url: () => "/api/admin/users/permissions", label: "User dan Izin" },
    // BL-41 (S6e-2): ringkasan baca-saja idempotency sales-receipt + daftar baris (?rows=1, kontrak §6). Endpoint juga terbuka untuk
    // finance.resolve_unknown; Beranda memakainya hanya untuk profil Admin Incaso (pelunasan.kirim). `valid`: jawaban tanpa angka/daftar =
    // galat, tidak pernah dibaca nol.
    pelunasan: { perm: "pelunasan.kirim", url: () => "/api/idempotency/summary?rows=1", label: "Ringkasan pelunasan",
        valid: (d: unknown) => obj(d).ok === true && typeof obj(obj(d).uncertain).total === "number" && typeof obj(d).retryable === "number"
            && Array.isArray(obj(d).perDatabase) && Array.isArray(obj(d).rows) },
    // Database Accurate yang sedang terbuka (alias tidak disimpan di ringkasan): penanda "database aktif" di kartu Pelunasan.
    sesiAccurate: { perm: "pelunasan.kirim", url: () => "/api/auth/accurate-session", label: "Sesi Accurate", valid: (d: unknown) => obj(d).ok === true },
    // K3 (owner 17 Okt): ringkasan Kasir baca-saja (cache K1b + kasir_*, tanpa Accurate). `valid`: Incaso lengkap = angka WAJIB number; belum lengkap =
    // angka null ("belum terbaca"); jawaban tanpa bentuk itu = galat, tidak pernah dibaca nol.
    kasir: { perm: "kasir.view", url: (today: string) => `/api/kasir/ringkasan?tanggal=${today}`, label: "Ringkasan Kasir",
        valid: (d: unknown) => {
            const o = obj(d);
            const tutup = obj(o.hariBelumDitutup);
            if (o.ok !== true || typeof obj(o.incaso).lengkap !== "boolean" || typeof tutup.jumlah !== "number" || !Array.isArray(tutup.tanggal)) return false;
            return obj(o.incaso).lengkap === true
                ? typeof obj(o.selisih).jumlah === "number" && typeof obj(o.selisih).orang === "number" && typeof obj(o.selisih).takTeralokasi === "number"
                    && typeof obj(o.belumSetor).jumlah === "number" && typeof obj(o.belumSetor).belumDijelaskan === "number"
                : o.selisih === null && o.belumSetor === null;
        } },
} as const;
export type SourceKey = keyof typeof SOURCES;
/** Jawaban 2xx yang bentuknya salah = galat (bukan nol). Sumber tanpa `valid` cukup HTTP 2xx (perilaku lama). */
export const sourceValid = (key: SourceKey, data: unknown) => {
    const src = SOURCES[key];
    return !("valid" in src) || src.valid(data);
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((v): v is Row => Boolean(v) && typeof v === "object") : []);
const obj = (value: unknown): Row => (value && typeof value === "object" ? value as Row : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Nol = "semua beres" (positif), bukan kosong tanpa makna — kecuali sumbernya terpotong. */
function count(value: number, unit: string, footer: string, tone: Tone, more = false): TileValue {
    if (more) return { value, unit, tone: tone === "pos" ? "info" : tone, footer: "Daftar sumber terpotong; buka layarnya untuk semua", more };
    return value === 0 ? { value, unit, tone: "pos", footer: "Tidak ada yang tertunda" } : { value, unit, tone, footer };
}

// ponytail: predikat sama dengan isSmActionableBatch/isClaimActionableBatch/isFinanceActionableBatch di
// app/(dashboard)/off-program-control/page.tsx; pindahkan ke lib bersama saat S4 memecah halaman OPC.
const opcBatches = (data: unknown) => rows(obj(data).batches);
const OPC_LIMIT = 200; // batas daftar di app/api/off-program-control/batches
const opcCapped = (data: unknown) => opcBatches(data).length >= OPC_LIMIT;
const smActionable = (b: Row) => b.status === "Submitted to SM" && b.smStatus === "Waiting Review";
const claimActionable = (b: Row) => b.smStatus === "Approved by SM"
    && !["Approved", "Returned"].includes(str(b.claimStatus))
    && !["Cancelled", "Completed", "Claim Approved", "Returned by Claim"].includes(str(b.status));
const financeActionable = (b: Row) => b.omStatus === "Approved" && ["Waiting Payment", "Partial Paid", "Need Correction"].includes(str(b.financeStatus));

/** K3: Incaso belum lengkap / sesi sinkron tak ada -> "belum terbaca" (value null), BUKAN nol. */
const belumTerbaca = (d: Row): TileValue => ({ value: null, unit: "belum terbaca", tone: "neu",
    footer: obj(d.incaso).sebab === "SESI_SINKRON" ? "Sesi Accurate akun sinkron belum tersedia" : "Incaso belum lengkap; segarkan di Kasir" });
const tanggalPendek = (iso: string) => new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

export const rupiahRingkas = (value: number) => value >= 1_000_000
    ? `Rp ${(value / 1_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`
    : `Rp ${value.toLocaleString("id-ID")}`;

export type TileSpec = { title: string; subtitle: string; href: string; source: SourceKey; icon: string; pick: (data: unknown) => TileValue };

export const TILES = {
    antrean: { title: "Antrean belum terkirim", subtitle: "Faktur belum terposting di Accurate", href: "/antrean-faktur", source: "outbox", icon: "send", pick: (data) => {
        const d = obj(data);
        const summary = obj(d.summary);
        // Semua state selain posted: antre, mengirim, tidak pasti, ditolak — jangan sampai "semua beres" saat ada yang macet.
        const pending = Object.entries(summary).filter(([state]) => state !== "posted").reduce((total, [, value]) => total + num(value), 0);
        const stuck = num(summary.unknown) + num(summary.rejected);
        const late = num(d.overdueQueue);
        const hours = (num(d.escalateAfterMinutes) || 120) / 60;
        const footer = [late && `${late} lewat ${hours} jam`, num(summary.rejected) && `${num(summary.rejected)} ditolak`, num(summary.unknown) && `${num(summary.unknown)} tidak pasti`]
            .filter(Boolean).join(" · ") || `Belum ada yang lewat ${hours} jam`;
        return count(pending, "faktur", footer, late || stuck ? "warn" : "info");
    } },
    batchTinjau: { title: "Batch perlu tinjau", subtitle: "Order Principal", href: "/principal-order", source: "outbox", icon: "file", pick: (data) => {
        const batches = rows(obj(data).pendingBatches);
        return count(batches.length, "batch", `${batches.reduce((total, b) => total + num(b.reviewCount), 0)} baris perlu tinjau`, "info");
    } },
    selisih: { title: "Selisih verifikasi", subtitle: "Berbeda dengan Accurate, belum dijelaskan", href: "/antrean-faktur", source: "verify", icon: "alert", pick: (data) => {
        const d = obj(data);
        return count(num(obj(d.summary).selisih), "faktur", `Dari ${num(d.checked)} faktur terbaru`, "neg");
    } },
    wave: { title: "Wave hari ini", subtitle: "Rekapan Nota", href: "/rekapan-nota", source: "wave", icon: "box", pick: (data) => {
        const waves = rows(obj(data).wave);
        const nota = waves.reduce((total, w) => total + num(w.jumlah_nota), 0);
        return { value: waves.length, unit: "wave", tone: "info", footer: waves.length ? `${nota} nota di wave` : "Belum ada wave hari ini" };
    } },
    exception: { title: "Masalah terbuka", subtitle: "Wave hari ini", href: "/rekapan-nota", source: "wave", icon: "alert", pick: (data) =>
        count(rows(obj(data).wave).reduce((total, w) => total + num(w.exception_open), 0), "masalah", "Selesaikan sebelum konfirmasi wave", "warn") },
    kanvas: { title: "Nota kanvas", subtitle: "Ditandai hari ini", href: "/rekapan-nota/kanvas", source: "kanvas", icon: "cart", pick: (data) => {
        const d = obj(data);
        return { value: num(d.ditandai), unit: "nota", tone: "neu", footer: `Dari ${num(d.jumlahNota)} nota hari ini` };
    } },
    persetujuanOff: { title: "Persetujuan OFF", subtitle: "Menunggu Sales Manager", href: "/off-program-control?tab=sales", source: "opc", icon: "clipboard", pick: (data) =>
        count(opcBatches(data).filter(smActionable).length, "pengajuan", "Menunggu keputusan Anda", "warn", opcCapped(data)) },
    dikembalikan: { title: "Dikembalikan ke SPV", subtitle: "Menunggu perbaikan supervisor", href: "/off-program-control?tab=sales", source: "opc", icon: "undo", pick: (data) =>
        count(opcBatches(data).filter((b) => b.status === "Returned by SM").length, "pengajuan", "Belum dikirim ulang", "info", opcCapped(data)) },
    reviewKlaim: { title: "Review klaim OFF", subtitle: "Disetujui SM, belum direview Claim", href: "/off-program-control?tab=claim", source: "opc", icon: "file", pick: (data) =>
        count(opcBatches(data).filter(claimActionable).length, "pengajuan", "Periksa kelengkapan berkas", "info", opcCapped(data)) },
    pembayaranOff: { title: "Pembayaran OFF", subtitle: "Disetujui OM, belum lunas", href: "/off-program-control?tab=finance", source: "opc", icon: "wallet", pick: (data) =>
        count(opcBatches(data).filter(financeActionable).length, "pengajuan", "Termasuk bayar sebagian dan perlu koreksi", "info", opcCapped(data)) },
    outstanding: { title: "Klaim outstanding", subtitle: "Belum dibayar principal", href: "/claim-workflow", source: "claimOutstanding", icon: "clock", pick: (data) => {
        const summary = obj(obj(data).summary);
        return count(num(summary.submissionCount), "klaim", rupiahRingkas(num(summary.totalOutstanding)), "info");
    } },
    siapTutup: { title: "Siap ditutup", subtitle: "Sudah dibayar principal", href: "/claim-workflow", source: "claimPaid", icon: "check", pick: (data) =>
        count(rows(obj(data).workflows).length, "klaim", "Tutup klaim yang lunas", "info", obj(obj(data).pagination).hasMore === true) },
    pelunasanTidakPasti: { title: "Pelunasan tidak pasti", subtitle: "Menunggu Finance", href: "/pelunasan", source: "pelunasan", icon: "alert", pick: (data) => {
        const d = obj(data);
        const u = obj(d.uncertain);
        const macet = num(d.processingStale);
        // sendingStale = SENDING ≥ 2 mnt (ambang Selesaikan); staleMinutes hanya untuk kunci PROCESSING (kontrak §6).
        const footer = [num(u.unknown) && `${num(u.unknown)} tidak pasti`, num(u.sendingStale) && `${num(u.sendingStale)} mengirim macet`,
            macet && `${macet} proses terhenti > ${num(d.staleMinutes) || 15} mnt (tak terkirim)`].filter(Boolean).join(" · ") || "Jangan unggah ulang; Finance menyelesaikan";
        return count(num(u.total) + macet, "baris", footer, "warn");
    } },
    pelunasanGagal: { title: "Gagal, boleh diulang", subtitle: "Tidak terkirim ke Accurate", href: "/pelunasan", source: "pelunasan", icon: "undo", pick: (data) =>
        count(num(obj(data).retryable), "baris", "Perbaiki lalu unggah ulang lewat wizard", "neg") },
    // K3 (owner 17 Okt): tiga tile profil Kasir. Angka = angka layar /kasir (lib/kasir/ringkasan memakai rumus KPI layar yang sama).
    kasirSelisih: { title: "Selisih belum dijelaskan", subtitle: "Hari ini: orang dan uang tak teralokasi", href: "/kasir", source: "kasir", icon: "alert", pick: (data) => {
        const d = obj(data);
        const s = obj(d.selisih);
        return typeof s.jumlah !== "number" ? belumTerbaca(d)
            : count(s.jumlah, "hal", `${num(s.orang)} selisih orang · ${num(s.takTeralokasi)} uang tak teralokasi`, "neg");
    } },
    kasirBelumSetor: { title: "Salesman belum menyetor", subtitle: "Punya pelunasan hari ini, belum ada setoran", href: "/kasir", source: "kasir", icon: "wallet", pick: (data) => {
        const d = obj(data);
        const b = obj(d.belumSetor);
        return typeof b.jumlah !== "number" ? belumTerbaca(d)
            : count(b.jumlah, "orang", num(b.belumDijelaskan) ? `${num(b.belumDijelaskan)} belum dijelaskan` : "Semuanya sudah dijelaskan", "warn");
    } },
    kasirBelumTutup: { title: "Hari belum ditutup", subtitle: "Hari ini dan 7 hari kerja terakhir", href: "/kasir", source: "kasir", icon: "clock", pick: (data) => {
        const d = obj(data);
        const hari = obj(d.hariBelumDitutup);
        const tanggal = (Array.isArray(hari.tanggal) ? hari.tanggal : []).filter((t): t is string => typeof t === "string");
        const hariIni = tanggal.includes(str(d.tanggal));
        // Hanya hari ini yang terbuka itu normal (belum waktunya tutup): info. Ada hari lampau belum ditutup: warn.
        if (num(hari.jumlah) === 1 && hariIni) return { value: 1, unit: "hari", tone: "info", footer: "Hanya hari ini" };
        // Hari lampau terkunci otomatis 20.00 dan Kasir tidak bisa menutupnya sendiri: OM/Admin (kasir.buka) yang membuka kembali.
        const lampau = tanggal.some((t) => t !== str(d.tanggal));
        return count(num(hari.jumlah), "hari", `${hariIni ? "Termasuk hari ini · terlama" : "Terlama"} ${tanggal[0] ? tanggalPendek(tanggal[0]) : "-"}${lampau ? " · perlu dibuka OM/Admin" : ""}`, "warn");
    } },
    userTanpaGrup: { title: "User tanpa grup", subtitle: "Masih memakai akses role lama", href: "/admin/users", source: "users", icon: "users", pick: (data) =>
        count(rows(obj(data).users).filter((u) => !u.groupId && !u.banned).length, "user", "Tetapkan grup akses", "info") },
} satisfies Record<string, TileSpec>;
export type TileId = keyof typeof TILES;

// ponytail: tile yang butuh logic baru di tracker AM tidak tampil sampai logic-nya di main: Posting/antrean tidak pasti
// (AM-014/015/047), Webhook & Kotak Tugas (BL-34), Capaian/Insentif (cakupan BL-26), rute & kunjungan salesman (BL-28),
// Transfer menunggu (FastAPI hanya per tanggal), Outlet tanpa area (kueri hitung baru), Sync Accurate (belum ada endpoint).
export const PROFILE_TILES: Record<string, TileId[]> = {
    admin: ["userTanpaGrup"],
    finance: ["pembayaranOff"],
    salesman: [],
    sm: ["persetujuanOff", "dikembalikan"],
    claim: ["reviewKlaim", "outstanding", "siapTutup"],
    fakturist: ["antrean", "batchTinjau", "selisih"],
    gudang: ["wave", "exception", "kanvas"],
    incaso: ["pelunasanTidakPasti", "pelunasanGagal"],
    // S7-3: profil dari grup utama; kosong (bukan gabungan) supaya tidak memuat tugas peran lain. Tile Kasir (K3) HANYA di profil kasir:
    // OM/Admin/Finance memegang kasir.view tetapi tidak mendapat tile ini (owner 17 Okt) — tanpa profil pun tidak masuk UNION_ORDER.
    spv: [],
    om: [],
    kasir: ["kasirSelisih", "kasirBelumSetor", "kasirBelumTutup"],
};

/** Tile tanpa angka per peran (pintasan / aplikasi luar). Tanpa `href` = informasi saja (bukan tautan). */
export type LinkTile = { title: string; subtitle: string; href?: string; icon: string; footer: string };
export const PROFILE_LINKS: Record<string, LinkTile[]> = {
    incaso: [
        { title: "Unggah pelunasan", subtitle: "Wizard langkah 1", href: "/pelunasan", icon: "upload", footer: "Format Pelunasan Internal ke Accurate" },
        { title: "Cek incaso", subtitle: "Aplikasi desktop", icon: "monitor", footer: "AR Incaso Checker di PC Anda; hasilnya Excel lokal, tanpa angka di sini" },
    ],
};
export const linksFor = (profileId: string | undefined, permKeys: ReadonlySet<string>) =>
    (profileId ? PROFILE_LINKS[profileId] ?? [] : []).filter((l) => !l.href || canAccessPathWithKeys(l.href, permKeys));
const UNION_ORDER: TileId[] = ["antrean", "batchTinjau", "selisih", "wave", "exception", "kanvas", "persetujuanOff", "reviewKlaim", "pembayaranOff", "outstanding", "siapTutup", "dikembalikan", "userTanpaGrup"];

/** Tile peran yang sumber DAN halaman tujuannya boleh dibuka; tanpa profil = gabungan tugas dari izin (maks 6). */
export function tilesFor(profileId: string | undefined, permKeys: ReadonlySet<string>): TileId[] {
    const allowed = (id: TileId) => permKeys.has(SOURCES[TILES[id].source].perm) && canAccessPathWithKeys(TILES[id].href, permKeys);
    if (profileId && PROFILE_TILES[profileId]) return PROFILE_TILES[profileId].filter(allowed);
    return UNION_ORDER.filter(allowed).slice(0, 6);
}

export type CardRow = { title: string; meta: string; badge?: [Tone, string] };
/** Muatan satu sumber di halaman (Beranda.tsx). */
export type SourceLoad = { status: "memuat" | "siap" | "galat"; data?: unknown };
/**
 * `extra` = sumber kedua (pelengkap, mis. sesi Accurate); gagal/memuat tidak menyembunyikan kartu — `notes`/`rows` menerima muatannya
 * dan menulis keadaannya. `notes` = kalimat ringkas di atas daftar.
 */
export type CardSpec = {
    title: string; subtitle: string; href: string; more: string; source: SourceKey; kind: "list" | "kv";
    rows: (data: unknown, extra?: SourceLoad) => CardRow[]; extra?: SourceKey; notes?: (data: unknown, extra?: SourceLoad) => string[];
};

/** Sesi Accurate (GET /api/auth/accurate-session) dari muatan sumber; undefined = belum/gagal terbaca. */
const sesiDari = (l?: SourceLoad) => (l?.status === "siap" ? { databaseId: obj(l.data).databaseId == null ? null : String(obj(l.data).databaseId), alias: str(obj(l.data).databaseAlias) } : undefined);
const labelDb = (id: unknown, sesi: ReturnType<typeof sesiDari>) => id == null ? "tidak tercatat"
    : sesi?.databaseId === String(id) ? `${sesi.alias || `id ${String(id)}`} (aktif)` : `database id ${String(id)}`;
const witaJam = (iso: unknown) => {
    const d = new Date(str(iso));
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Makassar", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
};

/** BL-41: database aktif + angka per database (perDatabase), lalu baris terbaru (?rows=1). */
const pelunasanNotes = (data: unknown, extra?: SourceLoad): string[] => {
    const sesi = sesiDari(extra);
    const aktif = extra?.status === "memuat" ? "Database aktif sedang dibaca."
        : !sesi ? "Database aktif tidak terbaca (sesi Accurate gagal dimuat)."
            : sesi.databaseId ? `Database aktif Anda: ${sesi.alias || "tanpa nama"} (id ${sesi.databaseId}).` : "Anda belum membuka database Accurate.";
    const perDb = rows(obj(data).perDatabase).map((d) => {
        const angka = [num(obj(d.uncertain).total) && `${num(obj(d.uncertain).total)} tidak pasti`, num(d.retryable) && `${num(d.retryable)} gagal`,
            num(d.processingStale) && `${num(d.processingStale)} proses terhenti`].filter(Boolean).join(" · ");
        return `${labelDb(d.databaseId, sesi)}: ${angka}`;
    });
    return [aktif, ...perDb];
};
const pelunasanRows = (data: unknown, extra?: SourceLoad): CardRow[] => {
    const sesi = sesiDari(extra);
    const daftar = rows(obj(data).rows);
    return [
        ...daftar.slice(0, 5).map((r): CardRow => ({
            title: `${str(r.invoiceNo) || "Tanpa faktur"} · ${str(r.customerNo) || "-"}`,
            meta: [rupiahRingkas(num(r.amount)), str(r.transDate), labelDb(r.databaseId, sesi), witaJam(r.updatedAt) && `${witaJam(r.updatedAt)} WITA`].filter(Boolean).join(" · "),
            badge: r.category === "retryable" ? ["neg", "Gagal · boleh diulang"] : ["warn", r.category === "processingStale" ? "Tidak pasti · proses terhenti" : "Tidak pasti"],
        })),
        ...(daftar.length > 5 ? [{ title: `${daftar.length - 5}${obj(data).rowsTruncated === true ? "+" : ""} baris lain`, meta: "Buka Pelunasan untuk daftar lengkap" }] : []),
    ];
};

const opcRows = (predicate: (b: Row) => boolean, label: string, tone: Tone) => (data: unknown): CardRow[] =>
    opcBatches(data).filter(predicate).slice(0, 3).map((b) => ({
        title: str(b.noPengajuan) || "Tanpa nomor",
        meta: [str(b.principleName) || str(b.principleCode), str(b.supervisorName) && `SPV ${str(b.supervisorName)}`].filter(Boolean).join(" · "),
        badge: [tone, label],
    }));

/** Satu kartu Pantauan per peran, dari sumber yang sama dengan tile-nya (tanpa permintaan tambahan). */
export const CARDS: Record<string, CardSpec> = {
    fakturist: { title: "Status antrean", subtitle: "Semua baris, per status", href: "/antrean-faktur", more: "Buka Antrean Faktur", source: "outbox", kind: "kv", rows: (data) => {
        const summary = obj(obj(data).summary);
        return [["Antre", "queued"], ["Mengirim", "sending"], ["Tidak pasti", "unknown"], ["Ditolak Accurate", "rejected"]]
            .map(([title, state]) => ({ title, meta: String(num(summary[state])) }));
    } },
    gudang: { title: "Wave hari ini", subtitle: "Urut jadwal", href: "/rekapan-nota", more: "Buka Rekapan Nota", source: "wave", kind: "list", rows: (data) =>
        rows(obj(data).wave).map((w) => ({
            title: str(w.nama) || `Wave #${num(w.id)}`,
            meta: `${num(w.jumlah_nota)} nota${num(w.exception_open) ? ` · ${num(w.exception_open)} masalah` : ""}`,
            badge: [num(w.exception_open) ? "warn" : "neu", str(w.status) || "-"],
        })) },
    sm: { title: "Persetujuan menunggu Anda", subtitle: "OFF Program Control", href: "/off-program-control?tab=sales", more: "Buka tab Sales Manager", source: "opc", kind: "list", rows: opcRows(smActionable, "Menunggu", "warn") },
    claim: { title: "Review klaim menunggu", subtitle: "OFF Program Control", href: "/off-program-control?tab=claim", more: "Buka tab Claim", source: "opc", kind: "list", rows: opcRows(claimActionable, "Review", "info") },
    finance: { title: "Pembayaran OFF menunggu", subtitle: "OFF Program Control", href: "/off-program-control?tab=finance", more: "Buka tab Finance", source: "opc", kind: "list", rows: opcRows(financeActionable, "Belum lunas", "info") },
    incaso: { title: "Pelunasan perlu tindakan", subtitle: "Tidak pasti dan gagal, terbaru dulu", href: "/pelunasan", more: "Buka Pelunasan", source: "pelunasan", extra: "sesiAccurate",
        kind: "list", notes: pelunasanNotes, rows: pelunasanRows },
};

export function cardFor(profileId: string | undefined, permKeys: ReadonlySet<string>): CardSpec | undefined {
    const card = profileId ? CARDS[profileId] : undefined;
    return card && permKeys.has(SOURCES[card.source].perm) ? card : undefined;
}

/** Tanggal hari ini di WITA (YYYY-MM-DD), bukan UTC: 00.00–07.59 WITA masih "kemarin" di UTC. */
export function witaToday(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(now);
}
