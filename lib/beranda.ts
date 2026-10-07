/*
 * Tujuan: Katalog tile tugas dan kartu pantauan Beranda per peran, dari endpoint yang SUDAH ada (tanpa logic baru).
 * Caller: app/(dashboard)/Beranda.tsx; lib/beranda.test.ts.
 * Dependensi: lib/rbac (izin halaman tujuan); endpoint GET yang dibaca di browser (lihat SOURCES).
 * Main Functions: SOURCES, TILES, tilesFor, CARDS, cardFor, witaToday.
 * Side Effects: Tidak ada; fungsi murni atas JSON respons.
 */

import { canAccessPathWithKeys } from "@/lib/rbac";

export type Tone = "pos" | "neg" | "warn" | "info" | "neu";
/** `more` = daftar sumber terpotong (batas endpoint): angka tampil "N+" dan tidak pernah "semua beres". */
export type TileValue = { value: number; unit: string; tone: Tone; footer: string; more?: boolean };
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
    users: { perm: "users.manage", url: () => "/api/admin/users/permissions", label: "User & RBAC" },
} as const;
export type SourceKey = keyof typeof SOURCES;

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
    wave: { title: "Wave hari ini", subtitle: "Rekapan nota", href: "/rekapan-nota", source: "wave", icon: "box", pick: (data) => {
        const waves = rows(obj(data).wave);
        const nota = waves.reduce((total, w) => total + num(w.jumlah_nota), 0);
        return { value: waves.length, unit: "wave", tone: "info", footer: waves.length ? `${nota} nota di wave` : "Belum ada wave hari ini" };
    } },
    exception: { title: "Exception terbuka", subtitle: "Wave hari ini", href: "/rekapan-nota", source: "wave", icon: "alert", pick: (data) =>
        count(rows(obj(data).wave).reduce((total, w) => total + num(w.exception_open), 0), "exception", "Selesaikan sebelum konfirmasi wave", "warn") },
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
};
const UNION_ORDER: TileId[] = ["antrean", "batchTinjau", "selisih", "wave", "exception", "kanvas", "persetujuanOff", "reviewKlaim", "pembayaranOff", "outstanding", "siapTutup", "dikembalikan", "userTanpaGrup"];

/** Tile peran yang sumber DAN halaman tujuannya boleh dibuka; tanpa profil = gabungan tugas dari izin (maks 6). */
export function tilesFor(profileId: string | undefined, permKeys: ReadonlySet<string>): TileId[] {
    const allowed = (id: TileId) => permKeys.has(SOURCES[TILES[id].source].perm) && canAccessPathWithKeys(TILES[id].href, permKeys);
    if (profileId && PROFILE_TILES[profileId]) return PROFILE_TILES[profileId].filter(allowed);
    return UNION_ORDER.filter(allowed).slice(0, 6);
}

export type CardRow = { title: string; meta: string; badge?: [Tone, string] };
export type CardSpec = { title: string; subtitle: string; href: string; more: string; source: SourceKey; kind: "list" | "kv"; rows: (data: unknown) => CardRow[] };

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
            meta: `${num(w.jumlah_nota)} nota${num(w.exception_open) ? ` · ${num(w.exception_open)} exception` : ""}`,
            badge: [num(w.exception_open) ? "warn" : "neu", str(w.status) || "—"],
        })) },
    sm: { title: "Persetujuan menunggu Anda", subtitle: "OFF Program Control", href: "/off-program-control?tab=sales", more: "Buka tab Sales Manager", source: "opc", kind: "list", rows: opcRows(smActionable, "Menunggu", "warn") },
    claim: { title: "Review klaim menunggu", subtitle: "OFF Program Control", href: "/off-program-control?tab=claim", more: "Buka tab Claim", source: "opc", kind: "list", rows: opcRows(claimActionable, "Review", "info") },
    finance: { title: "Pembayaran OFF menunggu", subtitle: "OFF Program Control", href: "/off-program-control?tab=finance", more: "Buka tab Finance", source: "opc", kind: "list", rows: opcRows(financeActionable, "Belum lunas", "info") },
};

export function cardFor(profileId: string | undefined, permKeys: ReadonlySet<string>): CardSpec | undefined {
    const card = profileId ? CARDS[profileId] : undefined;
    return card && permKeys.has(SOURCES[card.source].perm) ? card : undefined;
}

/** Tanggal hari ini di WITA (YYYY-MM-DD), bukan UTC: 00.00–07.59 WITA masih "kemarin" di UTC. */
export function witaToday(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(now);
}
