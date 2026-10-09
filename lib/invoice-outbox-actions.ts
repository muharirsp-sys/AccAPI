/*
 * Tujuan: Aksi manusia atas baris antrean faktur — Buang, Antre ulang, dan mengantrekan SO yang
 *   pernah dibuang — beserta jejaknya.
 * Caller: app/api/invoice-outbox (POST), app/api/principal-order/queue, app/api/orders/[id]/invoice.
 *   Dipisah dari route agar diuji dengan Postgres evaluasi (route memakai next/headers).
 * Dependensi: invoice_outbox + invoice_outbox_event, lib/accurate-invoice-write (aturan status),
 *   lib/invoice-outbox-event, lib/invoice-search (pencarian faktur AM-029, disuntikkan).
 * Main Functions: aksiAntrean, antrekan, pencariFaktur, pencariPenekan.
 * Side Effects: UPDATE/DELETE/INSERT invoice_outbox + INSERT event dalam SATU transaksi per baris.
 *   Request ke Accurate HANYA lewat pencari yang disuntikkan (BACA SAJA, list.do/detail.do).
 *
 * Keputusan owner E2 (9 Okt 2026): `{s:false, d:[pesan]}` tetap Ditolak, TETAPI Antre ulang dan
 * mengantrekan SO yang pernah dibuang SELALU didahului pencarian faktur (charField1 = kunci):
 *   ketemu        -> baris ditandai TERPOSTING (id + nomor Accurate, event), TIDAK dikirim;
 *   tidak ketemu  -> boleh diantrekan (dicatat bersama hasil pencariannya);
 *   gagal/tak pasti -> aksi DITOLAK dengan pesan, tidak ada yang berubah.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { invoiceOutbox } from "@/db/schema";
import { discardable, resendable, type OutboxState } from "@/lib/accurate-invoice-write";
import { catatEvent, pernahDibuang, waktuAntrePertama } from "@/lib/invoice-outbox-event";
import { cariFaktur, type HasilCari, type SesiCari } from "@/lib/invoice-search";
import { getAccurateSession } from "@/lib/accurate-session";
import { isAllowedAccurateHost } from "@/lib/api-security";

export type AksiJawaban = { status: number; body: Record<string, unknown> };

/** Pencari faktur untuk satu kunci antrean (disuntikkan: produksi = cariFaktur, uji = tiruan). */
export type Pencari = (q: { orderId: string; customerNo: string; queuedAt: Date }) => Promise<HasilCari>;

export function pencariFaktur(database: NodePgDatabase, session: SesiCari | null): Pencari {
    return (q) => cariFaktur({ db: database, key: q.orderId, customerNo: q.customerNo, queuedAt: q.queuedAt, session });
}

/**
 * Pencari dengan sesi Accurate PENEKAN — hanya bila sesi itu terbuka pada database tujuan faktur
 * (`ACCURATE_INVOICE_DB_ID`); database lain = list.do akan mencari di pembukuan yang salah. Tanpa
 * sesi yang sah, pencari hanya punya cache: tidak ketemu di cache = gagal_cek berikut sebabnya.
 */
export async function pencariPenekan(database: NodePgDatabase, userId: string): Promise<{ targetDb: string; cari: Pencari }> {
    const targetDb = String(process.env.ACCURATE_INVOICE_DB_ID || "").trim();
    const sesi = userId ? await getAccurateSession(userId).catch(() => null) : null;
    let session: SesiCari | null = null;
    let catatan = "";
    if (!sesi?.accessToken || !sesi.sessionHost || !sesi.sessionId || !isAllowedAccurateHost(sesi.sessionHost)) {
        catatan = "sesi Accurate Anda tidak lengkap — login Accurate di /api-wrapper";
    } else if (String(sesi.databaseId ?? "") !== targetDb) {
        catatan = `sesi Accurate Anda terbuka pada database ${sesi.databaseId ?? "?"}, bukan database faktur ${targetDb || "(ACCURATE_INVOICE_DB_ID kosong)"}`;
    } else {
        session = { sessionHost: sesi.sessionHost, sessionId: sesi.sessionId, accessToken: sesi.accessToken };
    }
    const dasar = pencariFaktur(database, session);
    return {
        targetDb,
        cari: async (q) => {
            const hasil = await dasar(q);
            return hasil.hasil === "gagal_cek" && catatan ? { ...hasil, alasan: `${hasil.alasan}; ${catatan}` } : hasil;
        },
    };
}

const ringkasCari = (hasil: HasilCari) => hasil.hasil === "ketemu"
    ? { hasil: hasil.hasil, sumber: hasil.sumber, id: hasil.id, number: hasil.number, semua: hasil.semua }
    : hasil.hasil === "tidak_ketemu_dicek"
        ? { hasil: hasil.hasil, sumber: hasil.sumber, diperiksa: hasil.diperiksa, baris_list_do: hasil.barisListDo }
        : { hasil: hasil.hasil, alasan: hasil.alasan };

const pesanGagalCari = (alasan: string) =>
    `Pencarian faktur di Accurate tidak bisa memastikan (${alasan}). Tidak ada yang diubah — `
    + "periksa manual di Accurate atau ulangi setelah sesi Accurate Anda aktif.";

const BERUBAH: AksiJawaban = { status: 409, body: { ok: false, error: "Status berubah sebelum tindakan dijalankan; muat ulang halaman" } };

export async function aksiAntrean(
    database: NodePgDatabase,
    // `cari` + `targetDb` wajib untuk `resend` (E2): tanpa pencari, antre ulang ditolak.
    input: { orderId: string; action: "resend" | "discard"; actor: string; reason: string; cari?: Pencari; targetDb?: string },
): Promise<AksiJawaban> {
    const { orderId, action, actor, reason } = input;
    const [row] = await database.select({ state: invoiceOutbox.state, customerNo: invoiceOutbox.customerNo, createdAt: invoiceOutbox.createdAt })
        .from(invoiceOutbox).where(eq(invoiceOutbox.orderId, orderId)).limit(1);
    if (!row) return { status: 404, body: { ok: false, error: "Baris antrean tidak ditemukan" } };

    const allowed = action === "discard" ? discardable(row.state as OutboxState) : resendable(row.state as OutboxState);
    if (!allowed) {
        const alasan = row.state === "unknown"
            ? "Statusnya TIDAK PASTI: Accurate tidak menjawab, jadi fakturnya mungkin sudah terbentuk di sana. "
              + "Selesaikan dulu lewat \"Selesaikan tidak pasti\" (pencarian faktur di Accurate); jangan pernah dikirim ulang dari sini."
            : action === "discard"
                ? `Status ${row.state} tidak boleh dibuang: fakturnya mungkin atau pasti sudah ada di Accurate.`
                : `Status ${row.state} tidak boleh dilepas ulang.`;
        return { status: 409, body: { ok: false, error: alasan } };
    }

    if (action === "discard") {
        // Yang DITOLAK (Accurate menjawab dan menolak) dan yang MASIH MENUNGGU (belum pernah
        // satu request pun terkirim) — keduanya dipastikan tidak punya faktur di Accurate.
        // `queued` ikut karena payload BEKU saat diantrekan: kalau aturan pembentuk payload
        // berubah (mis. salesman mulai ikut dikirim), satu-satunya cara memperbaruinya adalah
        // membuang barisnya lalu mengantrekan ulang dari batch.
        // BL-17: barisnya tetap DIHAPUS (PK bebas untuk antre ulang), salinannya masuk event `buang`.
        const removed = await database.transaction(async (tx) => {
            const rows = await tx.delete(invoiceOutbox)
                .where(and(eq(invoiceOutbox.orderId, orderId), inArray(invoiceOutbox.state, ["rejected", "queued"])))
                .returning();
            for (const gone of rows) {
                await catatEvent(tx, {
                    orderId, jenis: "buang", stateFrom: gone.state, stateTo: null, actor, reason,
                    detail: {
                        queued_at: gone.createdAt.toISOString(), queued_by: gone.queuedBy, attempts: gone.attempts,
                        last_error: gone.lastError, customer_no: gone.customerNo, order_date: String(gone.orderDate),
                        payload: gone.payload,
                    },
                });
            }
            return rows.length;
        });
        return removed ? { status: 200, body: { ok: true, orderId, action, state: null } } : BERUBAH;
    }

    // E2: antre ulang SELALU didahului pencarian faktur — "Ditolak" belum mutlak berarti tidak tersimpan.
    if (!input.cari || !input.targetDb) {
        return { status: 503, body: { ok: false, error: "Antre ulang butuh pencarian faktur di Accurate (database tujuan + sesi); tidak ada yang diubah." } };
    }
    const queuedAt = await waktuAntrePertama(database, orderId, row.createdAt) ?? row.createdAt;
    const hasil = await input.cari({ orderId, customerNo: row.customerNo, queuedAt });
    const pencarian = ringkasCari(hasil);
    if (hasil.hasil === "gagal_cek") {
        return { status: 409, body: { ok: false, error: pesanGagalCari(hasil.alasan), pencarian } };
    }
    if (hasil.hasil === "ketemu") {
        // Fakturnya SUDAH ada: tandai terposting, jangan pernah dikirim lagi.
        const done = await database.transaction(async (tx) => {
            const rows = await tx.update(invoiceOutbox)
                .set({ state: "posted", accurateDbId: input.targetDb, accurateId: hasil.id, accurateNumber: hasil.number, lastError: "", updatedAt: new Date() })
                .where(and(eq(invoiceOutbox.orderId, orderId), eq(invoiceOutbox.state, "rejected")))
                .returning({ orderId: invoiceOutbox.orderId });
            if (rows.length) {
                await catatEvent(tx, {
                    orderId, jenis: "posted", stateFrom: "rejected", stateTo: "posted", actor,
                    reason: `faktur ${hasil.number || hasil.id} ditemukan (${hasil.sumber}) sebelum antre ulang — tidak dikirim. ${reason}`.trim(),
                    detail: { pencarian, target_db: input.targetDb },
                });
            }
            return rows.length;
        });
        return done
            ? { status: 200, body: { ok: true, orderId, action, state: "posted", accurateId: hasil.id, number: hasil.number, pencarian,
                pesan: `Faktur ${hasil.number || hasil.id} sudah ada di Accurate — ditandai terposting, tidak dikirim ulang.` } }
            : BERUBAH;
    }

    // Tidak ketemu setelah diperiksa: kembalikan ke `queued` supaya pengirim mengambilnya. Angkanya
    // TIDAK dihitung ulang: payload dibekukan saat diantrekan. Kalau yang salah adalah
    // angkanya, yang benar adalah `discard` lalu antrekan ulang dari batch yang diperbaiki.
    const updated = await database.transaction(async (tx) => {
        const rows = await tx.update(invoiceOutbox)
            .set({ state: "queued", updatedAt: new Date() })
            .where(and(eq(invoiceOutbox.orderId, orderId), eq(invoiceOutbox.state, "rejected")))
            .returning({ orderId: invoiceOutbox.orderId, attempts: invoiceOutbox.attempts });
        if (rows.length) {
            await catatEvent(tx, { orderId, jenis: "antre_ulang", stateFrom: "rejected", stateTo: "queued", actor, reason, detail: { pencarian } });
        }
        return rows;
    });
    return updated.length
        ? { status: 200, body: { ok: true, orderId, action, state: "queued", attempts: updated[0].attempts, pencarian } }
        : BERUBAH;
}

export type CalonAntre = {
    orderId: string;
    customerNo: string;
    orderDate: string;
    payload: unknown;
    programSnapshot?: unknown;
};

export type HasilAntre = {
    queued: string[];
    /** SO yang pernah dibuang dan fakturnya ternyata SUDAH ada: ditandai terposting, tidak dikirim. */
    posted: { orderId: string; accurateId: string; number: string }[];
    blocked: { orderId: string; reason: string }[];
};

/**
 * Masukkan calon ke antrean. Kunci yang PERNAH dibuang (event `buang`) wajib lolos pencarian faktur
 * dulu (E2): ketemu -> baris dibuat langsung TERPOSTING; gagal -> tidak diantrekan, sebabnya dikembalikan.
 * Kunci yang sudah ada di antrean dilewati (ON CONFLICT) — pemanggil sudah menyaringnya.
 */
export async function antrekan(
    database: NodePgDatabase,
    input: { entries: CalonAntre[]; actor: string; targetDb: string; cari: Pencari | null; detail?: Record<string, unknown> },
): Promise<HasilAntre> {
    const hasil: HasilAntre = { queued: [], posted: [], blocked: [] };
    const dibuang = await pernahDibuang(database, input.entries.map((entry) => entry.orderId));
    const biasa: { entry: CalonAntre; pencarian?: Record<string, unknown> }[] = [];

    for (const entry of input.entries) {
        if (!dibuang.has(entry.orderId)) { biasa.push({ entry }); continue; }
        if (!input.cari || !input.targetDb) {
            hasil.blocked.push({ orderId: entry.orderId, reason: "pernah dibuang dari antrean; mengantrekannya lagi butuh pencarian faktur di Accurate (database tujuan + sesi Accurate Anda)" });
            continue;
        }
        const queuedAt = await waktuAntrePertama(database, entry.orderId) ?? new Date();
        const cari = await input.cari({ orderId: entry.orderId, customerNo: entry.customerNo, queuedAt });
        const pencarian = ringkasCari(cari);
        if (cari.hasil === "gagal_cek") {
            hasil.blocked.push({ orderId: entry.orderId, reason: `pernah dibuang dari antrean; ${pesanGagalCari(cari.alasan)}` });
            continue;
        }
        if (cari.hasil === "tidak_ketemu_dicek") { biasa.push({ entry, pencarian }); continue; }
        const masuk = await database.transaction(async (tx) => {
            const rows = await tx.insert(invoiceOutbox).values({
                orderId: entry.orderId, customerNo: entry.customerNo, orderDate: entry.orderDate, state: "posted",
                payload: entry.payload, programSnapshot: entry.programSnapshot ?? null, queuedBy: input.actor,
                accurateDbId: input.targetDb, accurateId: cari.id, accurateNumber: cari.number,
            }).onConflictDoNothing().returning({ orderId: invoiceOutbox.orderId });
            if (rows.length) {
                await catatEvent(tx, {
                    orderId: entry.orderId, jenis: "posted", stateTo: "posted", actor: input.actor,
                    reason: `pernah dibuang; faktur ${cari.number || cari.id} ditemukan (${cari.sumber}) sebelum antre — tidak dikirim`,
                    detail: { ...input.detail, pencarian, target_db: input.targetDb },
                });
            }
            return rows.length;
        });
        if (masuk) hasil.posted.push({ orderId: entry.orderId, accurateId: cari.id, number: cari.number });
    }

    if (biasa.length) {
        // Baris antrean + event `antre` dalam SATU transaksi (BL-17): yang masuk antrean selalu berjejak.
        const inserted = await database.transaction(async (tx) => {
            const rows = await tx.insert(invoiceOutbox).values(biasa.map(({ entry }) => ({
                orderId: entry.orderId, customerNo: entry.customerNo, orderDate: entry.orderDate, state: "queued",
                payload: entry.payload, programSnapshot: entry.programSnapshot ?? null, queuedBy: input.actor,
            }))).onConflictDoNothing().returning({ orderId: invoiceOutbox.orderId });
            const pencarianOf = new Map(biasa.map(({ entry, pencarian }) => [entry.orderId, pencarian]));
            await catatEvent(tx, ...rows.map((row) => ({
                orderId: row.orderId, jenis: "antre" as const, stateTo: "queued", actor: input.actor,
                detail: { ...input.detail, ...(pencarianOf.get(row.orderId) ? { pencarian: pencarianOf.get(row.orderId) } : {}) },
            })));
            return rows;
        });
        hasil.queued.push(...inserted.map((row) => row.orderId));
    }
    return hasil;
}
