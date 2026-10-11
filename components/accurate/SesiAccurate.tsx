/*
 * Tujuan: Kartu Sesi Accurate bersama (S7-sesi, owner D-01 Q2): status sesi, Masuk Accurate (lewat /api/auth/accurate-login ber-`state`),
 *   daftar & buka database, Ganti database, Keluar (dikonfirmasi); kabar callback `?accurate=connected|error&alasan=<kode>` sebagai
 *   MessageStrip (pemetaan kode, bukan teks mentah). Fokus pindah ke pesan sesudah aksi (elemen yang ditekan bisa hilang).
 * Caller: app/(dashboard)/sesi-accurate/page.tsx dan Konsol app/(dashboard)/api-wrapper/page.tsx (kartu yang sama).
 * Dependensi: GET/DELETE /api/auth/accurate-session, GET /api/auth/db-list, POST /api/auth/open-db, lib/accurate-oauth, components/fiori.
 * Main Functions: SesiAccurate, StatusSesi.
 * Side Effects: fetch route sesi; membuang `accurate`/`alasan` dari URL saat dimuat (returnTo tetap); navigasi ke halaman authorize Accurate.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Database, LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button, EmptyState, KeyValues, MessageStrip, Section, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { kabarAccurate, type Kabar, type ReturnTo } from "@/lib/accurate-oauth";

export type StatusSesi = { connected: boolean; databaseConnected: boolean; sessionHost: string | null; databaseId: string | null; databaseAlias: string | null };
type Db = { id: string | number; alias: string };
/** `masukUlang` = sesi login aplikasi berakhir (401): yang menolong adalah masuk ulang, bukan Coba lagi. */
type Galat = { pesan: string; masukUlang?: boolean };
type Keadaan = { status: "memuat" } | ({ status: "galat" } & Galat) | { status: "siap"; sesi: StatusSesi };
type Daftar = { status: "memuat" } | ({ status: "galat" } & Galat) | { status: "siap"; dbs: Db[] };

class GalatBaca extends Error {
    constructor(message: string, readonly masukUlang: boolean) { super(message); }
}
const galatDari = (e: unknown, umum: string): Galat => (e instanceof GalatBaca ? { pesan: e.message, masukUlang: e.masukUlang } : { pesan: umum });
const SESI_APP_BERAKHIR = "Sesi login aplikasi Anda berakhir.";

async function bacaStatus(): Promise<StatusSesi> {
    const res = await fetch("/api/auth/accurate-session", { cache: "no-store", credentials: "include" });
    const d = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (res.status === 401) throw new GalatBaca(SESI_APP_BERAKHIR, true);
    if (!res.ok || !d?.ok) throw new GalatBaca("Server tidak memberi status sesi.", false);
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
    if (res.status === 401) throw new GalatBaca(SESI_APP_BERAKHIR, true);
    if (!res.ok || !Array.isArray(d?.d)) throw new GalatBaca("Daftar database Accurate tidak terbaca; bila berulang, keluar lalu masuk Accurate lagi.", false);
    return d.d as Db[];
}

/**
 * Galat baca: 401 → tautan masuk ulang (blok sendiri di bawah kalimat, setinggi kontrol = 44 px di layar sentuh); lainnya → Coba lagi.
 * Judul ada di lencana status, jadi strip tanpa judul ganda.
 */
function StripGalat({ galat, onCobaLagi }: { galat: Galat; onCobaLagi: () => void }) {
    return (
        <MessageStrip tone="neg">
            {galat.pesan}
            {galat.masukUlang
                ? <div style={{ marginTop: 8 }}><a className="fi-btn fi-btn--secondary" href="/login"><LogIn className="fi-icon" aria-hidden />Masuk ulang ke aplikasi</a></div>
                : <>{" "}<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={onCobaLagi}>Coba lagi</Button></>}
        </MessageStrip>
    );
}

export function SesiAccurate({ returnTo, kabar: kabarUrl, onStatus, judul = "Sesi Accurate" }: {
    /** Tujuan sesudah callback (daftar putih lib/accurate-oauth). */
    returnTo: ReturnTo;
    /** Nilai `accurate`/`alasan` dari URL halaman pemanggil. */
    kabar?: { accurate?: string | null; alasan?: string | null };
    /** Dipanggil tiap status terbaca (null = galat) — Konsol memakainya untuk mengunci eksekusi. */
    onStatus?: (s: StatusSesi | null) => void;
    /** Judul bagian; bedakan dari h1 halaman bila halaman itu sendiri bernama Sesi Accurate. */
    judul?: string;
}) {
    const [keadaan, setKeadaan] = useState<Keadaan>({ status: "memuat" });
    const [daftar, setDaftar] = useState<Daftar | null>(null);
    const [pilih, setPilih] = useState("");
    const [galatPilih, setGalatPilih] = useState<string>();
    const [ganti, setGanti] = useState(false);
    const [sibuk, setSibuk] = useState<"buka" | null>(null);
    const [konfirmasiKeluar, setKonfirmasiKeluar] = useState(false);
    const [kabar, setKabar] = useState<Kabar | null>(() => kabarAccurate(kabarUrl?.accurate, kabarUrl?.alasan));
    const [galatAksi, setGalatAksi] = useState<string | null>(null);
    const [versi, setVersi] = useState(0);
    const [fokus, setFokus] = useState<{ ke: "pesan" | "pilih"; n: number } | null>(null);
    const onStatusRef = useRef(onStatus);
    const pesanRef = useRef<HTMLDivElement>(null);
    const pilihRef = useRef<HTMLDivElement>(null);
    useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
    // Tombol yang ditekan bisa hilang sesudah aksi (Keluar, Buka) — fokus dipindah ke pesan/isian, bukan jatuh ke <body>.
    useEffect(() => {
        if (!fokus) return;
        if (fokus.ke === "pesan") pesanRef.current?.focus();
        else pilihRef.current?.querySelector("select")?.focus();
    }, [fokus]);
    const fokuskan = (ke: "pesan" | "pilih") => setFokus((f) => ({ ke, n: (f?.n ?? 0) + 1 }));

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
            if (!sesi.connected) { setDaftar(null); return; }
            if (sesi.databaseConnected) return; // daftar hanya dimuat untuk memilih; Ganti database memuatnya sendiri
            // Daftar lama tetap tampil selama dimuat ulang (isian yang sedang difokus tidak hilang).
            setDaftar((d) => (d?.status === "siap" ? d : { status: "memuat" }));
            try {
                const dbs = await bacaDaftar();
                if (hidup) setDaftar({ status: "siap", dbs });
            } catch (e) {
                if (hidup) setDaftar({ status: "galat", ...galatDari(e, "Daftar database Accurate tidak terbaca.") });
            }
        }, (e: unknown) => {
            if (!hidup) return;
            setKeadaan({ status: "galat", ...galatDari(e, "Server tidak memberi status sesi.") });
            onStatusRef.current?.(null);
        });
        return () => { hidup = false; };
    }, [versi]);
    const muatUlang = () => setVersi((v) => v + 1);

    async function mulaiGanti() {
        setGanti(true); setGalatAksi(null); setGalatPilih(undefined); setPilih("");
        setDaftar({ status: "memuat" });
        try {
            setDaftar({ status: "siap", dbs: await bacaDaftar() });
            fokuskan("pilih");
        } catch (e) {
            setDaftar({ status: "galat", ...galatDari(e, "Daftar database Accurate tidak terbaca.") });
            fokuskan("pesan"); // tombol Ganti database sudah dibongkar; strip galat diumumkan (role alert)
        }
    }

    async function buka() {
        if (!pilih) { setGalatPilih("Pilih database dulu."); fokuskan("pilih"); return; }
        setSibuk("buka"); setGalatAksi(null);
        try {
            const db = daftar?.status === "siap" ? daftar.dbs.find((x) => String(x.id) === pilih) : undefined;
            const res = await fetch("/api/auth/open-db", {
                method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: pilih, alias: db?.alias || null }),
            });
            if (res.status === 401) throw new Error(`${SESI_APP_BERAKHIR} Masuk ulang ke aplikasi lalu ulangi.`);
            if (!res.ok) throw new Error("Database tidak bisa dibuka. Coba lagi; bila berulang, keluar lalu masuk Accurate lagi.");
            setKabar({ tone: "pos", title: "Database terbuka.", text: db?.alias ? `Sesi Accurate Anda kini memakai ${db.alias}.` : undefined });
            setGanti(false);
        } catch (e) {
            setGalatAksi(e instanceof Error && e.message ? e.message : "Database tidak bisa dibuka.");
        } finally {
            setSibuk(null);
            fokuskan("pesan");
            muatUlang();
        }
    }

    async function keluar() {
        const res = await fetch("/api/auth/accurate-session", { method: "DELETE", credentials: "include" }).catch(() => null);
        if (!res?.ok) throw new Error("Keluar gagal; sesi Accurate mungkin masih aktif. Coba lagi.");
        setKonfirmasiKeluar(false);
        setKabar({ tone: "info", title: "Anda sudah keluar dari Accurate.", text: "Masuk lagi untuk memilih database." });
        setGalatAksi(null); setPilih(""); setGanti(false);
        fokuskan("pesan");
        muatUlang();
    }

    const s = keadaan.status === "siap" ? keadaan.sesi : null;
    const badge = keadaan.status === "memuat" ? <StatusBadge tone="neu" busy>Memeriksa sesi Accurate…</StatusBadge>
        : !s ? <StatusBadge tone="neg">Sesi Accurate tidak terbaca</StatusBadge>
            : !s.connected ? <StatusBadge tone="warn">Belum masuk ke Accurate</StatusBadge>
                : !s.databaseConnected ? <StatusBadge tone="warn">Database belum dibuka</StatusBadge>
                    : <StatusBadge tone="pos">Database aktif</StatusBadge>;
    const alasanSibuk = sibuk === "buka" ? "Tunggu, database sedang dibuka." : undefined;
    const tampilDaftar = Boolean(s?.connected && (!s.databaseConnected || ganti));

    const pemilih = daftar?.status === "galat" ? <StripGalat galat={daftar} onCobaLagi={ganti ? () => void mulaiGanti() : muatUlang} />
        : daftar?.status !== "siap" ? <p className="fi-small">Mengambil daftar database…</p>
            : daftar.dbs.length === 0 ? (
                <EmptyState title="Akun Accurate ini tidak punya database"
                    message="Minta admin Accurate menambahkan akun Anda ke database perusahaan, lalu muat ulang."
                    action={<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={ganti ? () => void mulaiGanti() : muatUlang}>Muat ulang daftar</Button>} />
            ) : (
                <div ref={pilihRef} className="fi-sect-in" style={{ padding: 0 }}>
                    <FormField label="Database Accurate" required error={galatPilih} help="Database tempat Anda bekerja; dokumen dikirim ke database ini.">
                        {(a11y) => (
                            <select {...a11y} className="fi-input" value={pilih} onChange={(e) => { setPilih(e.target.value); setGalatPilih(undefined); }}>
                                <option value="">Pilih database</option>
                                {daftar.dbs.map((db) => <option key={String(db.id)} value={String(db.id)}>{db.alias}</option>)}
                            </select>
                        )}
                    </FormField>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <Button variant="primary" icon={<Database className="fi-icon" aria-hidden />} busy={sibuk === "buka"} onClick={buka}>Buka database</Button>
                        {ganti && <Button disabled={Boolean(sibuk)} disabledReason={alasanSibuk} onClick={() => { setGanti(false); setGalatPilih(undefined); fokuskan("pesan"); }}>Batal ganti</Button>}
                    </div>
                </div>
            );

    return (
        <Section title={judul} subtitle={<span aria-live="polite">{badge}</span>}
            actions={s?.connected ? (
                <>
                    {alasanSibuk && <span className="fi-small fi-why" id="sesi-accurate-sibuk">{alasanSibuk}</span>}
                    <Button icon={<LogOut className="fi-icon" aria-hidden />} disabled={Boolean(sibuk)} disabledReason={alasanSibuk}
                        aria-describedby={alasanSibuk ? "sesi-accurate-sibuk" : undefined} onClick={() => setKonfirmasiKeluar(true)}>Keluar dari Accurate</Button>
                </>
            ) : undefined}>
            <div className="fi-sect-in">
                <div ref={pesanRef} tabIndex={-1} style={{ outline: "none", display: "grid", gap: 10 }}>
                    {kabar && <MessageStrip tone={kabar.tone} title={kabar.title} onClose={() => setKabar(null)}>{kabar.text}</MessageStrip>}
                    {galatAksi && <MessageStrip tone="neg" onClose={() => setGalatAksi(null)}>{galatAksi}</MessageStrip>}
                </div>
                {keadaan.status === "memuat" ? null
                    : keadaan.status === "galat" ? <StripGalat galat={keadaan} onCobaLagi={muatUlang} />
                        : !s?.connected ? (
                            <>
                                <p className="fi-small">Masuk dengan akun Accurate Anda sendiri. Dokumen yang Anda kirim ke Accurate memakai sesi ini.</p>
                                <div><a className="fi-btn fi-btn--primary" href={`/api/auth/accurate-login?returnTo=${encodeURIComponent(returnTo)}`}>
                                    <LogIn className="fi-icon" aria-hidden />Masuk Accurate</a></div>
                            </>
                        ) : (
                            <>
                                {s.databaseConnected && (
                                    <KeyValues items={[
                                        ["Database", s.databaseAlias ? `${s.databaseAlias} (id ${s.databaseId ?? "?"})` : `id ${s.databaseId ?? "?"}`],
                                        ["Host", s.sessionHost ?? "—"],
                                    ]} />
                                )}
                                {tampilDaftar ? pemilih : (
                                    <div><Button icon={<ArrowLeftRight className="fi-icon" aria-hidden />} onClick={() => void mulaiGanti()}>Ganti database</Button></div>
                                )}
                            </>
                        )}
            </div>
            <ConfirmDialog open={konfirmasiKeluar} onClose={() => setKonfirmasiKeluar(false)} title="Keluar dari Accurate?" tone="negative"
                description="Sesi Accurate Anda dihapus dari aplikasi. Mengirim faktur, pelunasan, atau posting butuh masuk lagi dan memilih database."
                confirmLabel="Keluar dari Accurate" onConfirm={keluar} />
        </Section>
    );
}
