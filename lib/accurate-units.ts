/*
 * Tujuan: Master satuan Accurate (nama -> id) sebagai sumber `itemUnitId` baris faktur.
 * Caller: app/api/orders/[id]/invoice, app/api/principal-order/queue.
 * Dependensi: db `accurate_unit` — hasil sync `unit/list.do`, BUKAN panggilan live.
 * Main Functions: accurateUnits.
 * Side Effects: DB read-only.
 *
 * Satuan TIDAK boleh ditebak: satu item bisa berselisih 72x antar satuan, dan Accurate
 * mengabaikan field yang tidak dikenal tanpa galat. Master kosong = payload gagal dibuat.
 *
 * ponytail: dibaca dari tabel hasil sync, bukan dari Accurate langsung. Isinya sama persis
 * (37 baris, id yang sama: PCS=50, KRT=100) dan daftar satuan hampir tidak pernah berubah,
 * sementara panggilan live menambah satu titik gagal — termasuk saat token OAuth sedang
 * dipegang sesi lain. Ceilingnya: satuan yang BARU dibuat di Accurate belum ada di sini
 * sampai sync berikutnya; gejalanya payload ditolak dengan sebutan satuannya, bukan salah
 * diam-diam. Naiknya: jalankan sync master, atau panggil `unit/list.do` di sini bila
 * ternyata satuan baru sering muncul di tengah hari.
 */
import { db } from "@/lib/db";
import { accurateUnit } from "@/db/schema";

export async function accurateUnits(): Promise<{ units?: Map<string, number>; error?: string }> {
    const rows = await db.select({ id: accurateUnit.id, name: accurateUnit.name }).from(accurateUnit);
    const units = new Map<string, number>();
    for (const row of rows) {
        const name = String(row.name ?? "").trim().toUpperCase();
        if (name && Number.isFinite(Number(row.id))) units.set(name, Number(row.id));
    }
    if (units.size === 0) {
        return { error: "Master satuan Accurate kosong; jalankan sync master satuan dulu" };
    }
    return { units };
}
