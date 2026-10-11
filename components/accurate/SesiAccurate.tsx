/*
 * Tujuan: Kartu Sesi Accurate bersama (S7-sesi, owner D-01 Q2): status sesi, Masuk Accurate (lewat /api/auth/accurate-login ber-`state`),
 *   daftar & buka database, Keluar; kabar callback `?accurate=connected|error&alasan=<kode>` sebagai MessageStrip (pemetaan kode, bukan teks mentah).
 * Caller: app/(dashboard)/sesi-accurate/page.tsx dan Konsol app/(dashboard)/api-wrapper/page.tsx (kartu yang sama).
 * Dependensi: GET/DELETE /api/auth/accurate-session, GET /api/auth/db-list, POST /api/auth/open-db, lib/accurate-oauth, components/fiori.
 * Main Functions: SesiAccurate, StatusSesi.
 * Side Effects: fetch route sesi; membuang `accurate`/`alasan` dari URL saat dimuat (returnTo tetap); navigasi ke halaman authorize Accurate.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Database, LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button, KeyValues, MessageStrip, Section, StatusBadge } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { kabarAccurate, type Kabar, type ReturnTo } from "@/lib/accurate-oauth";

export type StatusSesi = { connected: boolean; databaseConnected: boolean; sessionHost: string | null; databaseId: string | null; databaseAlias: string | null };
type Db = { id: string | number; alias: string };
type Keadaan = { status: "memuat" } | { status: "galat"; pesan: string } | { status: "siap"; sesi: StatusSesi };
type Daftar = { status: "memuat" } | { status: "galat"; pesan: string } | { status: "siap"; dbs: Db[] };

const pesanDari = (e: unknown, umum: string) => (e instanceof Error && e.message ? e.message : umum);

async function bacaStatus(): Promise<StatusSesi> {
    const res = await fetch("/api/auth/accurate-session", { cache: "no-store", credentials: "include" });
    const d = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || !d?.ok) throw new Error(res.status === 401 ? "Sesi login aplikasi berakhir; masuk ulang ke aplikasi." : "Sesi Accurate tidak terbaca; coba lagi.");
    return {
        connected: Boolean(d.connected),
        databaseConnected: Boolean(d.databaseConnected),
        sessionHost: typeof d.sessionHost === "string" ? d.sessionHost : null,
        databaseId: d.databaseId == null ? null : String(d.databaseId),
        databaseAlias: typeof d.databaseAlias === "string" ? d.databaseAlias : null,
    };
}

async function bacaDaftar(): Promise<Db[]> {
    const res = await fetch("/api/auth/db-list", { cache: "no-store", credentials: "include" });
    const d = await res.json().catch(() => null) as { d?: unknown } | null;
    if (!res.ok || !Array.isArray(d?.d)) throw new Error("Daftar database Accurate tidak terbaca. Coba lagi; bila berulang, keluar lalu masuk Accurate lagi.");
    return d.d as Db[];
}

export function SesiAccurate({ returnTo, kabar: kabarUrl, onStatus }: {
    /** Tujuan sesudah callback (daftar putih lib/accurate-oauth). */
    returnTo: ReturnTo;
    /** Nilai `accurate`/`alasan` dari URL halaman pemanggil. */
    kabar?: { accurate?: string | null; alasan?: string | null };
    /** Dipanggil tiap status terbaca (null = galat) — Konsol memakainya untuk mengunci eksekusi. */
    onStatus?: (s: StatusSesi | null) => void;
}) {
    const [keadaan, setKeadaan] = useState<Keadaan>({ status: "memuat" });
    const [daftar, setDaftar] = useState<Daftar | null>(null);
    const [pilih, setPilih] = useState("");
    const [sibuk, setSibuk] = useState<"buka" | "keluar" | null>(null);
    const [kabar, setKabar] = useState<Kabar | null>(() => kabarAccurate(kabarUrl?.accurate, kabarUrl?.alasan));
    const [galatAksi, setGalatAksi] = useState<string | null>(null);
    const [versi, setVersi] = useState(0);
    const onStatusRef = useRef(onStatus);
    useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);

    // Kabar sudah dibaca: buang dari URL agar muat ulang tidak menampilkannya lagi (returnTo dan parameter lain tetap).
    useEffect(() => {
        const url = new URL(window.location.href);
        if (!url.searchParams.has("accurate") && !url.searchParams.has("alasan")) return;
        url.searchParams.delete("accurate");
        url.searchParams.delete("alasan");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }, []);

    useEffect(() => {
        let hidup = true;
        bacaStatus().then(async (sesi) => {
            if (!hidup) return;
            setKeadaan({ status: "siap", sesi });
            onStatusRef.current?.(sesi);
            if (!sesi.connected || sesi.databaseConnected) { setDaftar(null); return; }
            setDaftar({ status: "memuat" });
            try {
                const dbs = await bacaDaftar();
                if (hidup) setDaftar({ status: "siap", dbs });
            } catch (e) {
                if (hidup) setDaftar({ status: "galat", pesan: pesanDari(e, "Daftar database Accurate tidak terbaca.") });
            }
        }, (e: unknown) => {
            if (!hidup) return;
            setKeadaan({ status: "galat", pesan: pesanDari(e, "Sesi Accurate tidak terbaca; coba lagi.") });
            onStatusRef.current?.(null);
        });
        return () => { hidup = false; };
    }, [versi]);
    const muatUlang = () => setVersi((v) => v + 1);

    async function buka() {
        if (!pilih) { setGalatAksi("Pilih database dulu."); return; }
        setSibuk("buka"); setGalatAksi(null);
        try {
            const db = daftar?.status === "siap" ? daftar.dbs.find((x) => String(x.id) === pilih) : undefined;
            const res = await fetch("/api/auth/open-db", {
                method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: pilih, alias: db?.alias || null }),
            });
            const d = await res.json().catch(() => null) as { host?: unknown; session?: unknown } | null;
            if (!res.ok || !d?.host || !d?.session) throw new Error("Database tidak bisa dibuka. Coba lagi; bila berulang, keluar lalu masuk Accurate lagi.");
            setKabar({ tone: "pos", title: "Database terbuka.", text: db?.alias ? `Sesi Accurate Anda kini memakai ${db.alias}.` : undefined });
        } catch (e) {
            setGalatAksi(pesanDari(e, "Database tidak bisa dibuka."));
        } finally {
            setSibuk(null);
            muatUlang();
        }
    }

    async function keluar() {
        setSibuk("keluar"); setGalatAksi(null);
        try {
            const res = await fetch("/api/auth/accurate-session", { method: "DELETE", credentials: "include" });
            if (!res.ok) throw new Error();
            setKabar({ tone: "info", title: "Anda sudah keluar dari Accurate.", text: "Sesi Accurate Anda dihapus dari aplikasi; masuk lagi untuk memilih database." });
            setPilih("");
        } catch {
            setGalatAksi("Keluar gagal; sesi Accurate mungkin masih aktif. Coba lagi.");
        } finally {
            setSibuk(null);
            muatUlang();
        }
    }

    const s = keadaan.status === "siap" ? keadaan.sesi : null;
    const badge = keadaan.status === "memuat" ? <StatusBadge tone="neu" busy>Memeriksa sesi Accurate…</StatusBadge>
        : !s ? <StatusBadge tone="neg">Sesi Accurate tidak terbaca</StatusBadge>
            : !s.connected ? <StatusBadge tone="warn">Belum masuk ke Accurate</StatusBadge>
                : !s.databaseConnected ? <StatusBadge tone="warn">Database belum dibuka</StatusBadge>
                    : <StatusBadge tone="pos">Database aktif</StatusBadge>;

    return (
        <Section title="Sesi Accurate" subtitle={<span aria-live="polite">{badge}</span>}
            actions={s?.connected ? <Button icon={<LogOut className="fi-icon" aria-hidden />} busy={sibuk === "keluar"} disabled={Boolean(sibuk)} onClick={keluar}>Keluar dari Accurate</Button> : undefined}>
            <div className="fi-sect-in">
                {kabar && <MessageStrip tone={kabar.tone} title={kabar.title} onClose={() => setKabar(null)}>{kabar.text}</MessageStrip>}
                {galatAksi && <MessageStrip tone="neg" onClose={() => setGalatAksi(null)}>{galatAksi}</MessageStrip>}
                {keadaan.status === "memuat" ? <p className="fi-small">Memeriksa sesi Accurate Anda…</p>
                    : keadaan.status === "galat" ? (
                        <MessageStrip tone="neg" title="Sesi Accurate tidak terbaca.">
                            {keadaan.pesan}{" "}<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Coba lagi</Button>
                        </MessageStrip>
                    ) : !s?.connected ? (
                        <>
                            <p className="fi-small">Masuk dengan akun Accurate Anda sendiri. Dokumen yang Anda kirim ke Accurate memakai sesi ini.</p>
                            <div><a className="fi-btn fi-btn--primary" href={`/api/auth/accurate-login?returnTo=${encodeURIComponent(returnTo)}`}>
                                <LogIn className="fi-icon" aria-hidden />Masuk Accurate</a></div>
                        </>
                    ) : !s.databaseConnected ? (
                        daftar?.status === "galat" ? (
                            <MessageStrip tone="neg" title="Daftar database tidak terbaca.">
                                {daftar.pesan}{" "}<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Coba lagi</Button>
                            </MessageStrip>
                        ) : daftar?.status !== "siap" ? <p className="fi-small">Mengambil daftar database…</p> : (
                            <>
                                <FormField label="Database Accurate" required help="Database tempat Anda bekerja; dokumen dikirim ke database ini.">
                                    {(a11y) => (
                                        <select {...a11y} className="fi-input" value={pilih} onChange={(e) => setPilih(e.target.value)}>
                                            <option value="">Pilih database</option>
                                            {daftar.dbs.map((db) => <option key={String(db.id)} value={String(db.id)}>{db.alias}</option>)}
                                        </select>
                                    )}
                                </FormField>
                                <div><Button variant="primary" icon={<Database className="fi-icon" aria-hidden />} busy={sibuk === "buka"} disabled={Boolean(sibuk)} onClick={buka}>Buka database</Button></div>
                            </>
                        )
                    ) : (
                        <KeyValues items={[
                            ["Database", s.databaseAlias ? `${s.databaseAlias} (id ${s.databaseId ?? "?"})` : `id ${s.databaseId ?? "?"}`],
                            ["Host", s.sessionHost ?? "—"],
                        ]} />
                    )}
            </div>
        </Section>
    );
}
