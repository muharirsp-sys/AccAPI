/*
 * Tujuan: Salesman faktur Order Masuk (C7, owner 8 Okt 2026) — SATU salesman per order, disalin ke tiap baris faktur dengan bentuk
 *   yang sama dengan jalur Order Principal (`masterSalesmanId` di kepala + `salesmanListNumber` di setiap baris, lewat
 *   buildInvoicePayload). Menetapkan apakah salesman yang dipilih sah sebelum payload dibekukan ke antrean.
 * Caller: app/api/orders/[id]/invoice (pratinjau + antre).
 * Dependensi: drizzle-orm `sql` (ekspresi saja); baris pegawai dibaca pemanggil dari `accurate_employee` (sync employee/list.do).
 * Main Functions: salesmanOrder, salesmanDariPayload.
 * Side Effects: Tidak ada.
 *
 * Beda dengan jalur principal: di sana salesman datang dari laporan principal dan yang tidak ketemu membuat faktur terbit TANPA sales
 * (data yang memang belum pernah ada tidak boleh menghentikan antrean). Di Order Masuk salesman DIPILIH petugas saat antre, jadi yang
 * tidak sah (tidak ada, bukan sales, nonaktif, nomor ganda) DITOLAK — memasang sales lain atau tanpa sales diam-diam hanya
 * memindahkan kesalahan ke Accurate, tempat faktur tidak bisa ditarik.
 */
import { sql, type SQLWrapper } from "drizzle-orm";

/** Satu baris `accurate_employee`; `number` = kode salesman internal (dibuktikan live 2026-09-12). */
export type PegawaiAccurate = { id: number; number: string; name: string; salesman: boolean; suspended: boolean };

/** Opsi buildInvoicePayload; sama persis dengan yang dikirim app/api/principal-order/queue. */
export type OpsiSalesman = { masterSalesmanId: number; salesmanNumber: string };

export type PilihanSalesman =
    | { ok: true; opsi?: OpsiSalesman; nama?: string }
    | { ok: false; status: 400 | 409; error: string };

/** `pegawai` = baris `accurate_employee` dengan nomor yang sama dengan `kode` (pemanggil boleh mengirim lebih; yang lain diabaikan). */
export function salesmanOrder({ queue, kode, pegawai }: { queue: boolean; kode: string; pegawai: PegawaiAccurate[] }): PilihanSalesman {
    const nomor = String(kode ?? "").trim().toUpperCase();
    if (!nomor) {
        // Pratinjau boleh tanpa salesman (dialog memuatnya sebelum dipilih); antre TIDAK.
        return queue ? { ok: false, status: 400, error: "Pilih salesman order ini dulu; salesman disalin ke setiap baris faktur." } : { ok: true };
    }
    const cocok = pegawai.filter((row) => String(row.number ?? "").trim().toUpperCase() === nomor);
    if (cocok.length === 0) return { ok: false, status: 409, error: `Salesman ${nomor} tidak ditemukan di master pegawai Accurate; sinkronkan master atau pilih salesman lain.` };
    const aktif = cocok.filter((row) => row.salesman && !row.suspended);
    if (aktif.length > 1) return { ok: false, status: 409, error: `Ada lebih dari satu pegawai aktif bernomor ${nomor} di Accurate; rapikan master pegawai dulu.` };
    if (aktif.length === 0) {
        const sebab = cocok.some((row) => row.salesman) ? "nonaktif" : "bukan salesman";
        return { ok: false, status: 409, error: `Pegawai ${nomor} ${sebab} di Accurate; pilih salesman lain.` };
    }
    const [sales] = aktif;
    return { ok: true, opsi: { masterSalesmanId: sales.id, salesmanNumber: nomor }, nama: sales.name };
}

/**
 * Sales order INTERNAL untuk daftar Antrean Faktur: nomor salesman baris pertama payload beku (`detailItem[0].salesmanListNumber[0]`).
 * Satu salesman per order disalin ke SETIAP baris (C7), jadi baris pertama mewakili order. Payload lama tanpa sales → NULL (kosong).
 */
export const salesmanDariPayload = (payload: SQLWrapper) => sql<string | null>`(${payload})->'detailItem'->0->'salesmanListNumber'->>0`;
