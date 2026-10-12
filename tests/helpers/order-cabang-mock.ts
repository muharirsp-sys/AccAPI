/*
 * Tujuan: Mock bersama Playwright untuk layar Order per cabang (O2): /api/customers/search, /api/items/search, /api/orders/preview,
 *   /api/orders/salesmen (sesuai docs/handover/O1-KONTRAK-ORDER-CABANG.md) + FastAPI Web Sales (:8000). Data contoh GENERIK
 *   (PELANGGAN A, CABANG A, SALES A, BARANG A) — bukan nama principal/orang nyata.
 * Caller: tests/fiori-order-cabang.spec.ts, tests/fiori-order-masuk.spec.ts (Order baru + Antrekan), tests/fiori-lapangan-salesman.spec.ts (Order Sales).
 * Dependensi: @playwright/test. Tidak menyentuh DB maupun Accurate.
 * Main Functions: mockOrderCabang, mockWebsales, mockOrdersInternal, sidikDari, pilihPelanggan, pilihBarang, PELANGGAN, BARANG, SALESMAN_ACCURATE.
 * Side Effects: Memasang page.route; log permintaan dikembalikan ke pemanggil.
 *
 * Cabang: CABANG A = 50 (cabang salesman), CABANG B = 90, CABANG C = 70 (tanpa barang). Bentuk jawaban = kontrak server (kode galat §2).
 * Tahap 2 (O1 putaran 1): pratinjau membawa `sidik` (sha256 baris berharga + hasil promo); simpan FastAPI (Web Sales dan Order Baru) WAJIB membawa
 *   sidik yang sama dengan hitungan server saat itu (`geser` mengubah angka server di tengah tes = PRATINJAU_BERUBAH). Harga petugas hanya sah
 *   untuk baris TANPA harga master (keputusan owner 12 Okt sesi 13); pada baris berharga master server menolak.
 */
import { createHash } from "node:crypto";
import { expect, type Locator, type Page, type Route } from "@playwright/test";

export const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
/** Jawaban mock: objek { status, body } atau "putus" (koneksi diputus) atau { html } (badan bukan JSON, mis. 502 proxy). */
export type Jawab = { status?: number; body?: unknown; html?: string } | "putus";

export const CABANG = { A: { id: 50, name: "CABANG A" }, B: { id: 90, name: "CABANG B" }, C: { id: 70, name: "CABANG C" } };

export type PelangganMock = { id: number; customerNo: string; name: string; branchId: number; branchName: string; categoryName: string | null; channel: string; priceCategoryName: string | null; alamat: string | null };
export const PELANGGAN: PelangganMock[] = [
    { id: 1, customerNo: "C-01", name: "PELANGGAN A", branchId: 50, branchName: "CABANG A", categoryName: "General Trade", channel: "GT", priceCategoryName: "GROSIR", alamat: "JL. CONTOH 1" },
    { id: 2, customerNo: "C-02", name: "PELANGGAN B", branchId: 50, branchName: "CABANG A", categoryName: "Modern Trade", channel: "MT", priceCategoryName: "MODERN", alamat: null },
    { id: 3, customerNo: "C-03", name: "PELANGGAN C", branchId: 90, branchName: "CABANG B", categoryName: "General Trade", channel: "GT", priceCategoryName: "GROSIR", alamat: null },
    { id: 4, customerNo: "C-04", name: "PELANGGAN D", branchId: 50, branchName: "CABANG A", categoryName: null, channel: "", priceCategoryName: null, alamat: null },
    { id: 5, customerNo: "C-05", name: "PELANGGAN E", branchId: 70, branchName: "CABANG C", categoryName: "General Trade", channel: "GT", priceCategoryName: "GROSIR", alamat: null },
];

/** `harga`: satuan -> harga cabang (null = baris harga ada tetapi belum berharga untuk cabang/tanggal ini). {} = belum ada daftar harga. */
export type BarangMock = { id: number; no: string; name: string; branchId: number; branchName: string; tag: string; harga: Record<string, number | null> };
export const BARANG: BarangMock[] = [
    { id: 11, no: "A-1", name: "BARANG A", branchId: 50, branchName: "CABANG A", tag: "TAG A", harga: { KRT: 576000, PCS: 24000 } },
    { id: 12, no: "A-2", name: "BARANG A2", branchId: 50, branchName: "CABANG A", tag: "TAG A", harga: { LSN: null } },
    { id: 13, no: "A-3", name: "BARANG A3", branchId: 50, branchName: "CABANG A", tag: "TAG A", harga: {} },
    { id: 14, no: "A-4", name: "BARANG A4", branchId: 50, branchName: "CABANG A", tag: "TAG A", harga: { LSN: 120000 } },
    { id: 21, no: "B-1", name: "BARANG B", branchId: 90, branchName: "CABANG B", tag: "TAG B", harga: { KRT: 700000 } },
];
export const SALESMAN_ACCURATE = [
    { number: "M-SLA", name: "SALES A", branchId: 50 },
    { number: "M-SLB", name: "SALES B", branchId: 50 },
    { number: "M-SLC", name: "SALES C", branchId: 90 },
];

export type OpsiMock = {
    /** sales = salesman (cakupan cabang A, hanya cabangnya); petugas = internal (semua cabang). Bawaan petugas. */
    peran?: "sales" | "petugas";
    /** Hanya peran sales: kondisi tautan akun -> karyawan Accurate. */
    akun?: "ok" | "belum-terhubung" | "tidak-aktif";
    /** Ganti jawaban satu endpoint; undefined = jawaban bawaan. Boleh async (menunda). */
    pelanggan?: (url: URL, n: number) => Jawab | undefined | Promise<Jawab | undefined>;
    barang?: (url: URL, n: number) => Jawab | undefined | Promise<Jawab | undefined>;
    preview?: (body: PreviewBody, n: number) => Jawab | undefined | Promise<Jawab | undefined>;
    /** Menggeser netto hitungan server (aturan/harga berubah) — pratinjau lama jadi usang: simpan = PRATINJAU_BERUBAH. */
    geser?: number;
    /** `channel_masalah` pratinjau (simpan akan ditolak CHANNEL_BEDA_MASTER). */
    channelMasalah?: string;
    /** Saran "hampir dapat" tambahan (bentuk server: program_id, program_name, threshold, codes, minimum, current, gap, message). */
    saranTambahan?: Record<string, unknown>[];
};
export type PreviewBody = { channel: string; order_date: string; customer_no: string; lines: { code: string; unit: string; quantity: string; price?: string }[] };

export type LogMock = { pelanggan: URL[]; barang: URL[]; preview: PreviewBody[]; sidik: string[]; salesmen: URL[]; dibatalkan: string[] };

const kirim = async (r: Route, j: Jawab) => {
    try {
        if (j === "putus") return await r.abort("connectionreset");
        if (j.html !== undefined) return await r.fulfill({ status: j.status ?? 502, contentType: "text/html", body: j.html });
        return await r.fulfill(json(j.body ?? {}, j.status));
    } catch { /* permintaan sudah dibatalkan peramban (AbortController): jawaban tidak diperlukan lagi */ }
};

const galat403 = (kode: string, error: string) => ({ status: 403, body: { ok: false, kode, error } });

/** Hitung pratinjau seperti server: aturan cabang (BARANG_BEDA_CABANG), satuan, harga master per cabang / harga petugas (hanya baris tanpa master), lalu promo contoh. */
export function pratinjauContoh(b: PreviewBody, geser = 0, channelMasalah = "", saranTambahan: Record<string, unknown>[] = []): Jawab {
    const p = PELANGGAN.find((x) => x.customerNo === b.customer_no);
    if (!p) return { status: 409, body: { ok: false, kode: "PELANGGAN_TIDAK_ADA", error: `Pelanggan ${b.customer_no} tidak ada di master Accurate hasil sync.` } };
    const barang = b.lines.map((l) => BARANG.find((x) => x.no === l.code));
    const beda = barang.filter((x): x is BarangMock => !!x && x.branchId !== p.branchId);
    if (beda.length) {
        return { status: 409, body: { ok: false, kode: "BARANG_BEDA_CABANG", error: `Barang bukan barang cabang ${p.branchName} milik pelanggan ini: ${beda.map((x) => `${x.no} (cabang ${x.branchName})`).join("; ")}`,
            barang: beda.map((x) => ({ code: x.no, name: x.name, branchId: x.branchId, branchName: x.branchName, tag: x.tag })) } };
    }
    const tidakAda = b.lines.filter((_, i) => !barang[i]).map((l) => l.code);
    if (tidakAda.length) return { status: 409, body: { ok: false, kode: "BARANG_TIDAK_ADA", error: `Barang tidak ada di master Accurate: ${tidakAda.join(", ")}`, barang: tidakAda } };
    const salah = b.lines.filter((l, i) => !(l.unit in barang[i]!.harga));
    if (salah.length) {
        return { status: 409, body: { ok: false, kode: "SATUAN_SALAH", error: `Satuan ${salah[0].unit} tidak ada di master untuk ${salah[0].code}`,
            wrong_unit: salah.map((l) => ({ code: l.code, unit: l.unit, known_units: Object.keys(barang[b.lines.indexOf(l)]!.harga) })) } };
    }
    // Harga petugas: hanya baris TANPA harga master; pada baris berharga master ditolak (nama kode menyusul di kontrak O1 — tangani generik).
    const bermaster = b.lines.filter((l, i) => l.price && barang[i]!.harga[l.unit] !== null);
    if (bermaster.length) {
        return { status: 409, body: { ok: false, kode: "HARGA_PETUGAS_TIDAK_DIIZINKAN", error: `Harga master cabang ${p.branchName} sudah ada untuk: ${bermaster.map((l) => `${l.code} ${l.unit}`).join("; ")}. Harga petugas hanya untuk barang TANPA harga master; kosongkan harganya.`,
            barang: bermaster.map((l) => ({ code: l.code, unit: l.unit, hargaMaster: barang[b.lines.indexOf(l)]!.harga[l.unit] })) } };
    }
    const tanpaPetugas = b.lines.filter((l, i) => barang[i]!.harga[l.unit] === null && !l.price);
    if (tanpaPetugas.length) {
        const missing = tanpaPetugas.map((l) => l.code);
        return { status: 409, body: { ok: false, kode: "HARGA_BELUM_ADA", error: `Harga belum tersedia dari Accurate untuk: ${missing.join(", ")}`, missing } };
    }
    const petugas = (l: PreviewBody["lines"][number], i: number) => barang[i]!.harga[l.unit] === null;
    const harga = (l: PreviewBody["lines"][number]) => { const i = b.lines.indexOf(l); return petugas(l, i) ? Number(l.price) : barang[i]!.harga[l.unit] as number; };
    const baris = b.lines.map((l) => {
        const gross = Number(l.quantity) * harga(l);
        const promo = l.code === "A-1" && l.unit === "KRT";
        const net = promo ? gross * 0.9 : gross;
        return { code: l.code, unit: l.unit, quantity: l.quantity, gross: gross.toFixed(2), net: net.toFixed(2), percents: promo ? ["10"] : [], cash: "0.00" };
    });
    const gross = baris.reduce((t, x) => t + Number(x.gross), 0), net = baris.reduce((t, x) => t + Number(x.net), 0) + geser;
    const potongan = gross - net;
    const a1 = b.lines.find((l) => l.code === "A-1" && l.unit === "KRT");
    const hasil = {
        ok: true,
        lines: b.lines.map((l, i) => ({ code: l.code, unit: l.unit, quantity: l.quantity, price: String(harga(l)), sumber_harga: petugas(l, i) ? "petugas" : "master" })),
        prices: b.lines.map((l, i) => ({ code: l.code, unit: l.unit, price: harga(l), source: petugas(l, i) ? "petugas" : "tier", hargaMaster: petugas(l, i) ? null : harga(l), hargaDefault: false,
            priceCategoryName: p.priceCategoryName, branchName: p.branchName, effectiveDate: "2026-10-01", knownUnits: null })),
        result: {
            gross: gross.toFixed(2), discount: potongan.toFixed(2), net: net.toFixed(2), lines: baris,
            applications: potongan > 0 ? [{ program_id: "prog-a", program_name: "PROMO A", minimum: "1", discount: potongan.toFixed(2) }] : [],
            bonuses: a1 && Number(a1.quantity) >= 2 ? [{ program_id: "prog-a", code: "", unit: "PCS", quantity: "2", eligible_codes: ["A-1"] }] : [],
            blocked: p.channel === "GT" ? [{ program_id: "prog-c", program_name: "PROMO C", reason: "khusus outlet MT" }] : [],
        },
        // Bentuk server (summary_rules.suggestions): program jumlah satu barang, tier berikutnya di 5 KRT; hilang bila sudah tercapai.
        suggestions: [...(a1 && Number(a1.quantity) < 5 ? [{ program_id: "prog-a", program_name: "PROMO A", threshold: "quantity", codes: ["A-1"], minimum: "5", current: a1.quantity,
            gap: String(5 - Number(a1.quantity)), message: `Tambah ${5 - Number(a1.quantity)} KRT lagi untuk diskon 15%` }] : []), ...saranTambahan],
        sources: [{ draft_id: "d1d1d1d1", revision: 1 }], channel_masalah: channelMasalah,
        pelanggan: { customerNo: p.customerNo, name: p.name, branchId: p.branchId, branchName: p.branchName },
        sidik: "",
    };
    hasil.sidik = sidikHasil(b, p.channel, hasil);
    return { body: hasil };
}

/** Sidik tiruan: sha256 atas pelanggan + channel + tanggal + baris berharga + hasil promo (seperti server; bentuk persisnya tidak penting untuk uji UI). */
function sidikHasil(b: PreviewBody, channel: string, h: { lines: { code: string; unit: string; quantity: string; price: string }[]; result: unknown }) {
    return createHash("sha256").update(JSON.stringify({ c: b.customer_no, ch: b.channel || channel, d: b.order_date, l: h.lines.map((l) => [l.code, l.unit, l.quantity, l.price]), r: h.result })).digest("hex");
}

/** Sidik yang dihitung SERVER untuk badan simpan (hitungan saat ini, termasuk `geser`); null bila order sendiri tak sah. */
export function sidikDari(b: PreviewBody, geser = 0): { sidik: string; pratinjau: Record<string, unknown> } | null {
    const j = pratinjauContoh(b, geser);
    if (j === "putus" || j.status || !j.body) return null;
    const body = j.body as { lines: unknown[]; result: unknown; sources: unknown[]; sidik: string };
    return { sidik: body.sidik, pratinjau: { lines: body.lines, result: body.result, sources: body.sources, sidik: body.sidik } };
}

export async function mockOrderCabang(page: Page, opsi: OpsiMock = {}): Promise<{ log: LogMock; opsi: OpsiMock }> {
    const log: LogMock = { pelanggan: [], barang: [], preview: [], sidik: [], salesmen: [], dibatalkan: [] };
    page.on("requestfailed", (r) => { if (/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) log.dibatalkan.push(new URL(r.url()).search); });
    const sales = () => (opsi.peran ?? "petugas") === "sales";
    const blokirSales = (): Jawab | undefined => {
        if (!sales()) return undefined;
        if (opsi.akun === "belum-terhubung") return galat403("SALESMAN_BELUM_TERHUBUNG", "Akun ini belum ditautkan ke karyawan salesman Accurate.");
        if (opsi.akun === "tidak-aktif") return galat403("SALESMAN_TIDAK_AKTIF", "Karyawan tertaut suspended.");
        return undefined;
    };

    await page.route((u) => u.pathname === "/api/customers/search", async (r) => {
        const url = new URL(r.request().url());
        log.pelanggan.push(url);
        const ganti = await opsi.pelanggan?.(url, log.pelanggan.length);
        if (ganti) return kirim(r, ganti);
        const blok = blokirSales();
        if (blok) return kirim(r, blok);
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const cab = url.searchParams.get("branchId") ? Number(url.searchParams.get("branchId")) : null;
        if (sales() && cab !== null && cab !== CABANG.A.id) return kirim(r, galat403("CABANG_DI_LUAR_CAKUPAN", "Cabang di luar cabang Anda (CABANG A). Salesman hanya bisa order untuk cabangnya sendiri."));
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const baris = PELANGGAN.filter((p) => (!sales() || p.branchId === CABANG.A.id) && (cab === null || p.branchId === cab)
            && (!q || p.name.toLowerCase().includes(q) || p.customerNo.toLowerCase().includes(q)))
            .sort((x, y) => Number(y.customerNo.toLowerCase() === q) - Number(x.customerNo.toLowerCase() === q)).slice(0, limit);
        return kirim(r, { body: { ok: true, cakupan: sales() ? { semua: false, branchId: CABANG.A.id, branchName: CABANG.A.name } : { semua: true, branchId: null, branchName: null }, items: baris } });
    });

    await page.route((u) => u.pathname === "/api/items/search", async (r) => {
        const url = new URL(r.request().url());
        log.barang.push(url);
        const ganti = await opsi.barang?.(url, log.barang.length);
        if (ganti) return kirim(r, ganti);
        const blok = blokirSales();
        if (blok) return kirim(r, blok);
        const p = PELANGGAN.find((x) => String(x.id) === url.searchParams.get("customerId"));
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const cab = p ? p.branchId : url.searchParams.get("branchId") ? Number(url.searchParams.get("branchId")) : null;
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const items = BARANG.filter((x) => (cab === null || x.branchId === cab) && (!q || x.no.toLowerCase().includes(q) || x.name.toLowerCase().includes(q))).slice(0, limit)
            .map((x) => ({ id: x.id, no: x.no, name: x.name, branchId: x.branchId, branchName: x.branchName, tag: x.tag,
                units: Object.entries(x.harga).map(([unit, price]) => (p
                    ? { unit, price, source: price === null ? "missing" : "tier", branchName: price === null ? null : x.branchName, effectiveDate: price === null ? null : "2026-10-01" }
                    : { unit })) }));
        // Kosong karena cabangnya memang tanpa barang orderan (bukan karena ketikan tak cocok): flag server.
        const cabangTanpaBarang = items.length === 0 && cab !== null && !BARANG.some((x) => x.branchId === cab);
        return kirim(r, { body: { ok: true, tanggal: url.searchParams.get("tanggal") ?? "2026-10-12", branchId: cab, cabangTanpaBarang, items } });
    });

    await page.route((u) => u.pathname === "/api/orders/preview", async (r) => {
        const b = r.request().postDataJSON() as PreviewBody;
        log.preview.push(b);
        const ganti = await opsi.preview?.(b, log.preview.length);
        const jawab = ganti ?? blokirSales() ?? pratinjauContoh(b, opsi.geser ?? 0, opsi.channelMasalah ?? "", opsi.saranTambahan ?? []);
        const sidik = jawab !== "putus" ? (jawab.body as { sidik?: string } | undefined)?.sidik : undefined;
        if (typeof sidik === "string" && sidik) log.sidik.push(sidik);
        return kirim(r, jawab);
    });

    await page.route((u) => u.pathname === "/api/orders/salesmen", (r) => {
        const url = new URL(r.request().url());
        log.salesmen.push(url);
        const cab = url.searchParams.get("branchId") ? Number(url.searchParams.get("branchId")) : null;
        return kirim(r, { body: { ok: true, salesmen: SALESMAN_ACCURATE.filter((s) => cab === null || s.branchId === cab) } });
    });
    return { log, opsi };
}

// ------------------------------------------------------------------ FastAPI Web Sales (:8000)

export const ID_WEBSALES = "3f2a9c1e-77aa-4b3c-9d10-aa00bb11cc22";
export type OpsiWebsales = {
    orderGagal?: boolean; terkirim?: boolean; postTidakPasti?: boolean;
    /** Jawaban POST /websales/orders yang ditolak server (mis. kode O1); undefined = diterima. */
    tolak?: Jawab;
    hari?: string;
    /** Opsi mock pratinjau (`geser`): simpan dibandingkan dengan hitungan server saat ini. Tanpa ini sidik hanya diperiksa ada. */
    cabang?: OpsiMock;
    /** Baris tambahan di daftar "Order saya" (mis. status rejected). */
    baris?: Record<string, unknown>[];
};

/** FastAPI Web Sales + /api/me. CORS mengikuti Origin permintaan (port Next tidak ditulis keras). */
export async function mockWebsales(page: Page, opsi: OpsiWebsales = {}): Promise<{ kirim: Record<string, unknown>[] }> {
    const dikirim: Record<string, unknown>[] = [];
    const cors = (r: Route) => ({ "access-control-allow-origin": r.request().headers()["origin"] ?? "http://localhost:3033", "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" });
    const fa = (r: Route, body: unknown, status = 200, html?: string) => r.request().method() === "OPTIONS"
        ? r.fulfill({ status: 204, headers: cors(r) })
        : r.fulfill({ status, headers: { ...cors(r), "content-type": html ? "text/html" : "application/json" }, body: html ?? JSON.stringify(body) });
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const p = new URL(r.request().url()).pathname;
        if (p === "/api/me") return fa(r, { csrf_token: "t" });
        if (p === "/websales/orders" && r.request().method() === "POST") {
            const badan = r.request().postDataJSON() as Record<string, unknown> & PreviewBody & { sidik?: string };
            dikirim.push(badan);
            if (opsi.tolak && opsi.tolak !== "putus") return fa(r, opsi.tolak.body ?? {}, opsi.tolak.status ?? 409, opsi.tolak.html);
            // Pratinjau = tersimpan: sidik WAJIB dan harus sama dengan hitungan server saat ini (tanpa harga dari klien).
            if (!badan.sidik) return fa(r, { ok: false, detail: "Hitung pratinjau order dulu.", kode: "SIDIK_WAJIB" }, 400);
            const baru = sidikDari({ channel: badan.channel, order_date: badan.order_date, customer_no: badan.customer_no, lines: badan.lines }, opsi.cabang?.geser ?? 0);
            if (baru && baru.sidik !== badan.sidik) return fa(r, { ok: false, detail: "Harga atau promo berubah sejak pratinjau.", kode: "PRATINJAU_BERUBAH", pratinjau: baru.pratinjau }, 409);
            opsi.terkirim = true;
            // Order SUDAH tersimpan, tetapi proxy memutus jawaban (502 HTML) → hasil tidak pasti di layar.
            if (opsi.postTidakPasti) return fa(r, null, 502, "<html>Bad Gateway</html>");
            return fa(r, { ok: true, request: { id: ID_WEBSALES, status: "pending" } });
        }
        if (p === "/websales/orders") {
            if (opsi.orderGagal && !opsi.terkirim) return fa(r, { detail: "database is locked" }, 500);
            return fa(r, { ok: true, requests: [...(opsi.baris ?? []), ...(opsi.terkirim ? [{ id: ID_WEBSALES, outlet: "PELANGGAN A", channel: "GT", order_date: opsi.hari ?? "2026-10-12", customer_no: "C-01", status: "pending", created_at: new Date().toISOString(), pulled_at: null }] : [])] });
        }
        return fa(r, { ok: true });
    });
    return { kirim: dikirim };
}

// ------------------------------------------------------------------ FastAPI order internal (Order Baru)

export const ID_ORDER_BARU = "8f1c0000-aaaa-4bbb-8ccc-000000000001";
export type OpsiOrdersInternal = {
    /** Jawaban POST /orders berurutan (satu per permintaan); habis = diterima bila sidik cocok. */
    antrean?: Jawab[];
    cabang?: OpsiMock;
};

/** FastAPI Order Baru: simpan WAJIB `sidik` yang cocok dengan hitungan server saat ini; navigasi ke halaman order ditahan (fokus pada isi permintaan). */
export async function mockOrdersInternal(page: Page, opsi: OpsiOrdersInternal = {}): Promise<{ simpan: Record<string, unknown>[] }> {
    const simpan: Record<string, unknown>[] = [];
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const cors = { "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
        const req = r.request();
        const p = new URL(req.url()).pathname;
        const balas = (body: unknown, status = 200) => r.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
        if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
        if (p === "/api/me") return balas({ csrf_token: "t" });
        if (p === "/orders" && req.method() === "POST") {
            const badan = req.postDataJSON() as Record<string, unknown> & PreviewBody & { sidik?: string };
            simpan.push(badan);
            const giliran = opsi.antrean?.shift();
            if (giliran === "putus") return r.abort("connectionreset");
            if (giliran) return giliran.html !== undefined ? r.fulfill({ status: giliran.status ?? 502, headers: { ...cors, "content-type": "text/html" }, body: giliran.html }) : balas(giliran.body ?? {}, giliran.status);
            if (!badan.sidik) return balas({ ok: false, detail: "Hitung pratinjau order dulu.", kode: "SIDIK_WAJIB" }, 400);
            const baru = sidikDari({ channel: badan.channel, order_date: badan.order_date, customer_no: badan.customer_no, lines: badan.lines }, opsi.cabang?.geser ?? 0);
            if (baru && baru.sidik !== badan.sidik) return balas({ ok: false, detail: "Harga atau promo berubah sejak pratinjau.", kode: "PRATINJAU_BERUBAH", pratinjau: baru.pratinjau }, 409);
            return balas({ ok: true, order: { id: ID_ORDER_BARU } });
        }
        return balas({ ok: true });
    });
    await page.route((u) => /^\/orders\/[0-9a-f-]{36}$/.test(u.pathname), (r) => r.abort());
    return { simpan };
}

// ------------------------------------------------------------------ langkah layar bersama (pemilih cari)

/** Cari lalu pilih pelanggan (nama = sumber regex) di Order Sales / Order baru; menunggu kartu pelanggan terpilih. */
export async function pilihPelanggan(main: Locator, kata: string, nama: string) {
    await main.getByLabel("Cari pelanggan").fill(kata);
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: new RegExp(nama) }).click();
    await expect(main.getByRole("group", { name: "Pelanggan terpilih" })).toContainText(nama);
}

/** Cari lalu pilih barang (nama = sumber regex) pada satu baris order. */
export async function pilihBarang(baris: Locator, kata: string, nama: string) {
    await baris.getByLabel("Cari barang").fill(kata);
    await baris.getByRole("list", { name: "Hasil pencarian barang" }).getByRole("button", { name: new RegExp(nama) }).click();
}
