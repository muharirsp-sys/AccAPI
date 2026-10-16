/*
 * Tujuan: halaman UJI sementara untuk Peta Supervisor Review (SR-3) — memuat jawaban GET /api/supervisor-review (di uji: di-mock) lalu
 *   menampilkan Peta + pemilih salesman, supaya Peta bisa diuji Playwright sebelum layar SR-2 ada. Mati di produksi (404).
 * Caller: tests/fiori-supervisor-peta.spec.ts. Keputusan dipertahankan / dihapus: orkestrator (lihat badan PR SR-3).
 * Dependensi: ./UjiPeta (klien), FioriScope.
 */
import { notFound } from "next/navigation";
import { FioriScope } from "@/components/fiori/Scope";
import UjiPeta from "./UjiPeta";

export default function UjiPetaPage() {
    if (process.env.NODE_ENV === "production") notFound();
    return <FioriScope><UjiPeta /></FioriScope>;
}
