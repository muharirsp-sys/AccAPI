/*
 * Tujuan: AM-029 — mencari faktur Accurate milik satu kunci antrean (charField1 = `PRINCIPAL:NO-SO`
 *         atau id order) SEBELUM baris itu dikirim/diantre ulang atau diselesaikan (S6-0d E2, BL-16).
 * Caller: lib/invoice-outbox-actions (antre ulang, selesaikan), app/api/principal-order/queue
 *         (SO yang pernah dibuang), app/api/invoice-outbox/resolve.
 * Dependensi: db sales_invoice (cache) + customer (id pelanggan Accurate); fetch GET list.do/detail.do.
 * Main Functions: milikKunci, jendelaCari, kueriListDo, cariFaktur.
 * Side Effects: BACA SAJA — SELECT cache lokal dan GET sales-invoice/list.do + detail.do. Tidak
 *   menulis apa pun, termasuk cache.
 *
 * Bukti produksi yang menentukan bentuk berkas ini (S6-0d §G, 9 Okt 2026):
 * - `filter.charField1` di list.do DIABAIKAN DIAM-DIAM (rowCount sama dengan tanpa filter) — TIDAK dipakai.
 * - `filter.customerNo=<nomor cache>` ditolak "Pelanggan tidak tepat". Satu-satunya pemakaian di kode
 *   (konsol AOL, subapp sales receipt) menelan galatnya, jadi tidak ada format yang TERBUKTI. Dipakai
 *   bentuk spesifikasi OpenAPI lokal `filter.customerId` (EQUAL, id numerik dari master `customer`);
 *   BELUM TERBUKTI menyempitkan — karena itu hasil list.do DISARING ULANG di sini per pelanggan dan
 *   lastUpdate, dan jumlah baris di atas batas = gagal_cek, bukan "tidak ketemu".
 * - detail.do TERBUKTI membawa charField1 (KN00403); list.do belum terbukti mengisinya -> tiap calon
 *   dibuka lewat detail.do dan dicocokkan EQUAL.
 *
 * "tidak_ketemu_dicek" BUKAN bukti tidak ada: hanya berarti list.do + detail.do berjalan penuh dalam
 * batasnya dan tidak satu pun calon membawa kunci ini. Ia membuka aksi manusia beralasan, tidak pernah
 * mengirim otomatis. Cache lokal saja tidak pernah menghasilkan "tidak ketemu" (cache bisa tertinggal).
 */
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { customer, salesInvoiceCache } from "@/db/schema";
import { parseAccurateDateTime } from "@/lib/accurate-invoice";

export type FakturKetemu = { id: string; number: string };
export type HasilCari =
    | { hasil: "ketemu"; id: string; number: string; sumber: "cache" | "accurate"; semua: FakturKetemu[] }
    | { hasil: "tidak_ketemu_dicek"; sumber: "accurate"; diperiksa: number; barisListDo: number }
    | { hasil: "gagal_cek"; alasan: string };

export type SesiCari = { sessionHost: string; sessionId: string; accessToken: string };

/** Batas kerja (VPS 2 core, Accurate berbatas laju). Melewati batas = gagal_cek, bukan tebakan. */
export const BATAS_CARI = { calonCache: 500, barisListDo: 300, calonDetail: 25, waktuMs: 90_000, perPanggilanMs: 20_000 };

const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function bacaJson(raw: unknown): Record<string, unknown> {
    let parsed: unknown = raw;
    // raw_data tersimpan sebagai STRING JSON di kolom jsonb (lib/sync.ts) — bisa berlapis.
    for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
        try { parsed = JSON.parse(parsed); } catch { return {}; }
    }
    return obj(parsed);
}

/**
 * Faktur ini milik kunci antrean? `charField1` kepala SAMA PERSIS (EQUAL, bukan awalan:
 * "KINO:SO-1" bukan "KINO:SO-12"); baris `detailItem[].charField1` hanya cadangan bila kepala
 * kosong — kepala yang berisi kunci LAIN tidak dikalahkan barisnya.
 */
export function milikKunci(raw: unknown, key: string): boolean {
    const want = key.trim();
    if (!want) return false;
    const row = bacaJson(raw);
    const head = String(row.charField1 ?? "").trim();
    if (head) return head === want;
    const lines = Array.isArray(row.detailItem) ? row.detailItem : [];
    return lines.some((line) => String(obj(line).charField1 ?? "").trim() === want);
}

/** "dd/MM/yyyy HH:mm:ss" pada UTC+7 — zona lastUpdate Accurate (lib/accurate-invoice.ts). */
function keWaktuAccurate(at: Date): string {
    const wib = new Date(at.getTime() + 7 * 3_600_000).toISOString();
    return `${wib.slice(8, 10)}/${wib.slice(5, 7)}/${wib.slice(0, 4)} ${wib.slice(11, 19)}`;
}

/**
 * Jendela pencarian dari waktu PERTAMA order masuk antrean: cache −1 hari (created_at faktur =
 * jam Accurate, cache bisa telat diisi), list.do −10 menit (lastUpdate faktur baru ≥ waktu dibuat ≥
 * waktu antre; 10 menit = selisih jam server).
 */
export function jendelaCari(queuedAt: Date): { cacheSejak: Date; accurateSejak: Date; accurateSejakTeks: string } {
    const accurateSejak = new Date(queuedAt.getTime() - 10 * 60_000);
    return { cacheSejak: new Date(queuedAt.getTime() - 86_400_000), accurateSejak, accurateSejakTeks: keWaktuAccurate(accurateSejak) };
}

/** Parameter list.do per pelanggan + lastUpdate. SENGAJA tanpa filter.charField1 (diabaikan Accurate, §G). */
export function kueriListDo(customerId: number, sejakTeks: string, page: number): Record<string, string> {
    return {
        fields: "id,number,customer,lastUpdate,charField1",
        "filter.customerId.op": "EQUAL",
        "filter.customerId.val": String(customerId),
        "filter.lastUpdate.op": "GREATER_EQUAL_THAN",
        "filter.lastUpdate.val": sejakTeks,
        "sp.pageSize": "100",
        "sp.page": String(page),
    };
}

type Jawaban = { ok: true; body: Record<string, unknown> } | { ok: false; alasan: string };

async function bacaAccurate(sesi: SesiCari, path: string, query: Record<string, string>, deadline: number, perPanggilanMs: number): Promise<Jawaban> {
    const sisa = deadline - Date.now();
    if (sisa <= 0) return { ok: false, alasan: "batas waktu pencarian habis" };
    // Koma literal: Accurate tidak membaca %2C (lib/accurate-forward.ts).
    const url = `${sesi.sessionHost}/accurate/api${path}?${new URLSearchParams(query).toString().replace(/%2C/g, ",")}`;
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json", Authorization: `Bearer ${sesi.accessToken}`, "X-Session-ID": sesi.sessionId },
            redirect: "manual",
            signal: AbortSignal.timeout(Math.min(perPanggilanMs, sisa)),
        });
        const text = await response.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { /* bukan JSON */ }
        const envelope = obj(body);
        if (response.status !== 200 || envelope.s !== true) {
            const pesan = Array.isArray(envelope.d) ? envelope.d.join("; ") : text.slice(0, 200);
            return { ok: false, alasan: `${path} HTTP ${response.status}${envelope.s === false ? " s:false" : ""}: ${pesan}`.trim() };
        }
        return { ok: true, body: envelope };
    } catch (error) {
        return { ok: false, alasan: `${path}: ${error instanceof Error ? `${error.name} ${error.message}` : "tanpa jawaban"}` };
    }
}

export async function cariFaktur(input: {
    db: Pick<NodePgDatabase, "select">;
    key: string;
    customerNo: string;
    queuedAt: Date;
    session: SesiCari | null;
    batas?: Partial<typeof BATAS_CARI>;
}): Promise<HasilCari> {
    const batas = { ...BATAS_CARI, ...input.batas };
    const { db, key, customerNo } = input;
    if (!key.trim() || !customerNo.trim()) return { hasil: "gagal_cek", alasan: "kunci antrean / pelanggan kosong" };
    const jendela = jendelaCari(input.queuedAt);

    // (a) Cache lokal: calon lewat kolom terindeks (customer_no) + waktu, TANPA raw_data; raw_data
    //     dibuka per PK hanya untuk calon. Memindai raw_data massal tidak boleh (VPS 2 core).
    const calon = await db.select({ id: salesInvoiceCache.id }).from(salesInvoiceCache)
        .where(and(
            eq(salesInvoiceCache.customerNo, customerNo),
            or(gte(salesInvoiceCache.createdAt, jendela.cacheSejak),
                and(isNull(salesInvoiceCache.createdAt), gte(salesInvoiceCache.lastUpdateAt, jendela.cacheSejak))),
        ))
        .orderBy(desc(salesInvoiceCache.id)).limit(batas.calonCache + 1);
    if (calon.length && calon.length <= batas.calonCache) {
        const isi = await db.select({ id: salesInvoiceCache.id, number: salesInvoiceCache.number, raw: salesInvoiceCache.rawData })
            .from(salesInvoiceCache).where(inArray(salesInvoiceCache.id, calon.map((row) => row.id)));
        const cocok = isi.filter((row) => milikKunci(row.raw, key))
            .map((row) => ({ id: String(row.id), number: String(row.number ?? "") }))
            .sort((a, b) => Number(a.id) - Number(b.id));
        if (cocok.length) return { hasil: "ketemu", ...cocok[0], sumber: "cache", semua: cocok };
    }

    // (b) Accurate: list.do per pelanggan sejak waktu antre, lalu detail.do per calon.
    if (!input.session) return { hasil: "gagal_cek", alasan: "tidak ada di cache lokal dan tidak ada sesi Accurate untuk memeriksa langsung" };
    const pelanggan = await db.select({ id: customer.id }).from(customer).where(eq(customer.customerNo, customerNo)).limit(2);
    if (pelanggan.length !== 1) {
        return { hasil: "gagal_cek", alasan: `pelanggan ${customerNo} ${pelanggan.length ? "tidak unik" : "tidak ada"} di master customer lokal` };
    }
    const customerId = Number(pelanggan[0].id);
    const deadline = Date.now() + batas.waktuMs;

    const baris: Record<string, unknown>[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
        const jawab = await bacaAccurate(input.session, "/sales-invoice/list.do", kueriListDo(customerId, jendela.accurateSejakTeks, page), deadline, batas.perPanggilanMs);
        if (!jawab.ok) return { hasil: "gagal_cek", alasan: jawab.alasan };
        const sp = obj(jawab.body.sp);
        total = Number(sp.rowCount ?? NaN);
        if (!Number.isFinite(total)) return { hasil: "gagal_cek", alasan: "list.do tanpa sp.rowCount — jumlah faktur tidak terbukti" };
        // Filter yang diabaikan diam-diam (seperti charField1) terlihat sebagai rowCount raksasa.
        if (total > batas.barisListDo) {
            return { hasil: "gagal_cek", alasan: `list.do mengembalikan ${total} faktur (batas ${batas.barisListDo}) — filter pelanggan/lastUpdate tidak menyempitkan; periksa manual di Accurate` };
        }
        const d = Array.isArray(jawab.body.d) ? jawab.body.d as unknown[] : null;
        if (!d) return { hasil: "gagal_cek", alasan: "list.do tanpa daftar d" };
        baris.push(...d.map(obj));
        if (page >= Number(sp.pageCount ?? 1) || d.length === 0) break;
    }

    // Saring ULANG di sini: id pelanggan beda = bukan faktur kita; lastUpdate yang terbaca dan lebih
    // tua dari jendela = dibuat sebelum antre. Yang tidak terbaca tetap jadi calon (gagal-tertutup).
    const calonAccurate = baris.filter((row) => {
        const pemilik = obj(row.customer).id ?? row.customerId;
        if (pemilik !== undefined && pemilik !== null && Number(pemilik) !== customerId) return false;
        const diubah = parseAccurateDateTime(row.lastUpdate);
        return !diubah || diubah.getTime() >= jendela.accurateSejak.getTime();
    });
    if (calonAccurate.length > batas.calonDetail) {
        return { hasil: "gagal_cek", alasan: `${calonAccurate.length} faktur calon (batas ${batas.calonDetail}) — periksa manual di Accurate` };
    }

    const ketemu: FakturKetemu[] = [];
    for (const row of calonAccurate) {
        const id = String(row.id ?? "").trim();
        if (!/^\d+$/.test(id)) return { hasil: "gagal_cek", alasan: "list.do memberi faktur tanpa id" };
        const jawab = await bacaAccurate(input.session, "/sales-invoice/detail.do", { id }, deadline, batas.perPanggilanMs);
        if (!jawab.ok) return { hasil: "gagal_cek", alasan: jawab.alasan };
        const detail = obj(jawab.body.d);
        if (milikKunci(detail, key)) ketemu.push({ id, number: String(detail.number ?? row.number ?? "") });
    }
    if (ketemu.length) {
        ketemu.sort((a, b) => Number(a.id) - Number(b.id));
        return { hasil: "ketemu", ...ketemu[0], sumber: "accurate", semua: ketemu };
    }
    return { hasil: "tidak_ketemu_dicek", sumber: "accurate", diperiksa: calonAccurate.length, barisListDo: total };
}
