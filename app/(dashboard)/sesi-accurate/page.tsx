/*
 * Tujuan: Rute /sesi-accurate (S7-sesi, owner D-01 Q2): masuk Accurate + pilih database TANPA akses Konsol, untuk pemegang salah satu
 *   kunci SESI_ACCURATE_KEYS (lib/rbac.ts; guard halaman di layout dashboard). Kartu = komponen yang sama dengan Konsol.
 * Caller: menu profil (SidebarLayout), tautan "Masuk Accurate" di Pelunasan/Antrean, callback OAuth (?accurate=…&returnTo=…).
 * Dependensi: FioriScope, components/accurate/SesiAccurate, lib/accurate-oauth (returnTo daftar putih).
 * Main Functions: SesiAccuratePage.
 * Side Effects: Tidak ada di server; kartu memanggil route sesi Accurate dari peramban.
 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import { SesiAccurate } from "@/components/accurate/SesiAccurate";
import { LABEL_RETURN_TO, returnToAman } from "@/lib/accurate-oauth";

type Cari = Record<string, string | string[] | undefined>;
const satu = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

export default async function SesiAccuratePage({ searchParams }: { searchParams: Promise<Cari> }) {
    const sp = await searchParams;
    const returnTo = returnToAman(satu(sp.returnTo));
    return (
        <FioriScope>
            <div className="fi-page">
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Akun</span></li><li><span aria-current="page">Sesi Accurate</span></li></ol></nav>
                    <div className="fi-page-bar">
                        <h1>Sesi Accurate</h1>
                        <span className="fi-spacer" />
                        {returnTo !== "/sesi-accurate" && (
                            <Link className="fi-btn fi-btn--secondary" href={returnTo} prefetch={false}><ArrowLeft className="fi-icon" aria-hidden />Kembali ke {LABEL_RETURN_TO[returnTo]}</Link>
                        )}
                    </div>
                    <p>Masuk ke Accurate dengan akun Anda dan buka database tempat Anda bekerja. Faktur, pelunasan, dan posting yang Anda kirim
                        memakai sesi ini atas nama Anda.</p>
                </header>
                <SesiAccurate returnTo={returnTo} kabar={{ accurate: satu(sp.accurate), alasan: satu(sp.alasan) }} />
            </div>
        </FioriScope>
    );
}
