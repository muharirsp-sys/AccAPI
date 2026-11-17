/*
 * Tujuan: Rute /tagihan-kunjungan (owner 16 Nov 2026): Incaso melihat toko yang sudah dikunjungi salesman tetapi tidak tertagih dan tidak order.
 * Caller: menu Keuangan › Tagihan Kunjungan. Guard halaman: layout dashboard (pagePermissions /tagihan-kunjungan = IZIN_TAGIHAN_KUNJUNGAN, lib/rbac.ts).
 * Dependensi: FioriScope, todayWita, TagihanKunjungan (klien).
 * Main Functions: TagihanKunjunganPage.
 * Side Effects: Tidak ada (data dimuat klien dari GET /api/form-kontrol/tagihan).
 */
import { FioriScope } from "@/components/fiori/Scope";
import { todayWita } from "@/lib/insentif-payment-date";
import TagihanKunjungan from "./TagihanKunjungan";

export default function TagihanKunjunganPage() {
    return <FioriScope><TagihanKunjungan hariIni={todayWita(new Date())} /></FioriScope>;
}
