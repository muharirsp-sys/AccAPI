/*
 * Tujuan: "Rute hari ini" (Fiori S5, it05, ponsel dulu): toko JKS hari ini (WITA) dengan kunjungan yang belum selesai paling atas,
 *   progres kunjungan, tanda prioritas, dan "Kirim status rute hari ini" lewat dialog (pengganti tombol Submit AO).
 * Caller: form-kontrol/page.tsx (shell tab, default export `({ scope })`).
 * Dependensi: GET/POST /api/form-kontrol/ao-control, ../shared (Scope, AoRow, PRINCIPLES, compareRoute, hariIniWita, jamWita, useIzinFk),
 *   ../lapangan (bacaFk, kirimFk, keBarisRute, simpanRute, useHariBeku), components/fiori/*, lib/rekapan-nota/ui (tanggalPanjang).
 * Main Functions: TabAo, badgeToko, susunKiriman.
 * Side Effects: HTTP GET rute; GET ulang + POST ao-control per toko saat Kirim status; sessionStorage daftar toko rute (Order Sales).
 *
 * Kirim status TIDAK dihapus (keputusan orkestrator S5): kunjungan sudah menulis check-in/status/merch/check-out per toko, TETAPI tanda
 * prioritas dan baris "tidak dikunjungi" hanya tertulis lewat kiriman ini, dan Dashboard SPV menghitung "Rute" dari baris AO.
 * Payload per toko sama dengan Submit AO lama (urut, berhenti di galat pertama). Dua penjaga (temuan peninjau S5): hanya salesman
 * pemilik rute yang mengirim (peran lain baca-saja), dan rute DIBACA ULANG sesaat sebelum mengirim — status dari bacaan terbaru, hanya
 * tanda bintang sesi ini di atasnya — supaya status kunjungan yang tersimpan sesudah layar dimuat tidak tertimpa.
 */
"use client";

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarDays, FileText, RefreshCw, Send, Star } from "lucide-react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, Section, Skeleton, StatusBadge, VariantNote, type Tone } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { type Scope, type AoRow, PRINCIPLES, compareRoute, hariIniWita, jamWita, useIzinFk, visitDurationMin } from "../shared";
import { adaHasilKunjungan, statusBintang } from "@/lib/form-kontrol/constants";
import { bacaFk, keBarisRute, kirimFk, simpanRute, useHariBeku } from "../lapangan";

type Saring = "semua" | "belum" | "tidak" | "perhatian";
const sedang = (r: AoRow) => Boolean(r.checkinAt && !r.checkoutAt);

/** Satu badge dominan per toko: ikon + label + warna, tidak pernah warna saja. */
function badgeToko(r: AoRow): { tone: Tone; label: string } {
    if (sedang(r)) return { tone: "info", label: "Lanjutkan" };
    if (r.status === "not_order") return { tone: "neg", label: "Tidak order" };
    if (r.status === "ordered" || r.status === "active") return { tone: "pos", label: "Order" };
    if (r.checkoutAt) return { tone: "pos", label: "Selesai" };
    if (r.isPriority) return { tone: "warn", label: "Prioritas" };
    if (r.needsAttention) return { tone: "warn", label: "Perhatian" };
    return { tone: "neu", label: "Belum" };
}

function metaToko(r: AoRow): string {
    const bagian: string[] = [];
    // #3: angka ini menghitung HARI dengan status order/aktif bulan ini (db.ts getTodayRoute), bukan jumlah kunjungan.
    if (r.monthlyOrderCount > 0) bagian.push(`${r.monthlyOrderCount} hari order bulan ini`);
    if (r.needsAttention) bagian.push("≥ 2× tidak order bulan ini");
    if (sedang(r)) bagian.push(`Sedang dikunjungi · check-in ${jamWita(r.checkinAt)}`);
    else if (r.checkoutAt) bagian.push(`Selesai ${jamWita(r.checkinAt)}–${jamWita(r.checkoutAt)} (${visitDurationMin(r) ?? "—"} menit)`);
    else bagian.push("Belum dikunjungi");
    return bagian.join(" · ");
}

/** Toggle bintang (lib/form-kontrol statusBintang); membatalkan bintang yang dipasang sesi ini mengembalikan baris semula. */
const bintang = (r: AoRow): AoRow => {
    const status = statusBintang(r.status);
    return { ...r, status, isPriority: status === "priority" };
};

/**
 * Baris yang dikirim = bacaan TERBARU server; tanda bintang sesi ini ditimpakan hanya bila status toko itu tidak berubah sejak layar
 * dimuat (bila berubah — mis. salesman baru menyimpan ORDER — bintang dilewati dan status server yang dikirim).
 */
function susunKiriman(segar: AoRow[], dimuat: AoRow[], bintangSesi: Record<string, AoRow>) {
    const lama = new Map(dimuat.map((r) => [r.custCode, r]));
    let dilewati = 0;
    const rows = segar.map((r) => {
        const mau = bintangSesi[r.custCode];
        if (!mau) return r;
        if (lama.get(r.custCode)?.status !== r.status) { dilewati++; return r; }
        return r.isPriority === mau.isPriority ? r : bintang(r);
    });
    return { rows, dilewati };
}

export default function TabAo({ scope }: { scope: Scope }) {
    const judulId = useId();
    // Akun salesman (profil tertaut): tanggal = hari ini WITA saat layar dibuka, tidak bisa diubah (it05 #1). Peran lain boleh melihat
    // tanggal lain.
    const salesman = Boolean(scope.salesCode);
    const tim = scope.allowedSalesCodes;
    const beku = useHariBeku();
    const [tanggalPilih, setTanggalPilih] = useState(beku.hari);
    const tanggal = salesman ? beku.hari : tanggalPilih;
    // ponytail: my-scope belum mengirim principal (#2) → bawaan GODREJ seperti hari ini; usulan di VariantNote.
    const [principle, setPrinciple] = useState(scope.principle ?? PRINCIPLES[0]);
    const [salesCode, setSalesCode] = useState(scope.salesCode ?? "");
    const [saring, setSaring] = useState<Saring>("semua");
    const [dialog, setDialog] = useState(false);
    const [sukses, setSukses] = useState("");
    const tanpaIzin = useIzinFk("submit");
    // Hanya salesman pemilik rute yang mengirim status (perilaku lama untuk peran salesman); SPV/SM/admin baca-saja.
    const bukanPemilik = salesman && salesCode === scope.salesCode ? undefined
        : "Hanya salesman pemilik rute yang mengirim status rute; tampilan ini baca-saja.";

    const loader = useCallback(async (): Promise<Load<AoRow[]>> => {
        // Tanpa salesman terpilih tidak ada permintaan: server menjawab baris AO lintas salesman (admin) atau kosong (SPV) — bukan rute.
        if (!salesCode) return { status: "siap", data: [] };
        const p = new URLSearchParams({ date: tanggal, principle });
        p.set("salesCode", salesCode);
        const hasil = await bacaFk(`/api/form-kontrol/ao-control?${p}`, (d) => keBarisRute(d.rows, principle));
        if (hasil.status === "siap" && tanggal === hariIniWita()) simpanRute(tanggal, salesCode, hasil.data!.map((r) => ({ kode: r.custCode, nama: r.custName })));
        return hasil;
    }, [tanggal, principle, salesCode]);
    const [load, muatUlang] = useLoad(loader);

    const asal = load.data;
    const [ubah, setUbah] = useState<{ dari?: AoRow[]; baris: Record<string, AoRow> }>({ baris: {} });
    const ubahan = useMemo(() => (asal && ubah.dari === asal ? ubah.baris : {}), [asal, ubah]);
    const rows = useMemo(() => (asal ?? []).map((r) => ubahan[r.custCode] ?? r), [asal, ubahan]);
    const nUbah = Object.keys(ubahan).length;
    useUnsavedGuard(nUbah > 0);

    function tandai(r: AoRow) {
        setSukses("");
        setUbah((prev) => {
            const baris = asal && prev.dari === asal ? { ...prev.baris } : {};
            if (baris[r.custCode]) delete baris[r.custCode];
            else baris[r.custCode] = bintang(r);
            return { dari: asal, baris };
        });
    }

    const n = {
        order: rows.filter((r) => r.status === "ordered").length,
        aktif: rows.filter((r) => r.status === "active").length,
        tidak: rows.filter((r) => r.status === "not_order").length,
        prioritas: rows.filter((r) => r.status === "priority").length,
        belum: rows.filter((r) => r.status === "not_visited").length,
        dikunjungi: rows.filter((r) => r.checkinAt).length,
        belumSelesai: rows.filter((r) => !r.checkoutAt).length,
        perhatian: rows.filter((r) => r.isPriority || r.needsAttention).length,
    };
    const shown = rows
        .filter((r) => saring === "semua" ? true : saring === "belum" ? !r.checkoutAt : saring === "tidak" ? r.status === "not_order" : (r.isPriority || r.needsAttention))
        .slice()
        // Kunjungan yang sedang berjalan selalu paling atas; sisanya urutan rute lama (tidak order → perhatian → order → belum → selesai).
        .sort((a, b) => Number(sedang(b)) - Number(sedang(a)) || compareRoute(a, b));

    const kirimTerkunci = bukanPemilik ?? tanpaIzin ?? (rows.length === 0 ? "Tidak ada toko di rute ini"
        : load.status === "memuat" ? "Menunggu rute selesai dimuat"
            : load.status === "galat" ? "Rute gagal dimuat ulang; muat ulang dulu supaya status yang dikirim tidak usang" : undefined);

    async function kirimStatus() {
        const p = new URLSearchParams({ date: tanggal, principle });
        p.set("salesCode", salesCode);
        const segar = await bacaFk(`/api/form-kontrol/ao-control?${p}`, (d) => keBarisRute(d.rows, principle));
        if (segar.status !== "siap") throw new Error(`Rute tidak bisa dibaca ulang sebelum dikirim, jadi tidak ada yang dikirim. ${segar.error ?? ""}`.trim());
        const { rows: kiriman, dilewati } = susunKiriman(segar.data!, asal ?? [], ubahan);
        let terkirim = 0;
        for (const row of kiriman) {
            try {
                await kirimFk("/api/form-kontrol/ao-control", {
                    salesCode: row.salesCode,
                    custCode: row.custCode,
                    principle,
                    date: tanggal,
                    status: row.status,
                    noOrderReasonCode: row.noOrderReasonCode ?? null,
                    noOrderNote: row.noOrderNote ?? null,
                }, { ulangAman: true });
            } catch (e) {
                const sebab = e instanceof Error ? e.message : "Gagal mengirim.";
                throw new Error(`${sebab} Berhenti di ${row.custName}: ${terkirim} dari ${kiriman.length} toko sudah terkirim. Kirim ulang membaca rute lagi dari server.`);
            }
            terkirim++;
        }
        setDialog(false);
        setUbah({ baris: {} });
        setSukses(`Status ${terkirim} toko terkirim untuk ${tanggalPanjang(tanggal)} dari rute terbaru di server.${dilewati
            ? ` ${dilewati} tanda prioritas tidak dikirim karena status tokonya berubah sejak layar dimuat.` : ""}`);
        muatUlang();
    }

    const hariLabel = tanggalPanjang(tanggal);
    const judulHari = tanggal === hariIniWita() ? "hari ini" : hariLabel;
    let isi: ReactNode;
    if (!salesCode) {
        isi = tim === null
            ? <EmptyState title="Isi kode salesman" message="Rute tampil per salesman. Ketik kode salesman di atas." />
            : tim.length === 0
                ? <EmptyState title="Belum ada salesman di tim Anda" message="Salesman muncul setelah Admin Sales mengisi SPV/SM mereka di Hierarki Sales." />
                : <EmptyState title="Pilih salesman tim Anda" message="Rute tampil per salesman." />;
    } else if (load.status === "galat" && rows.length === 0) {
        // Juga saat muat ulang gagal sesudah hasil kosong: galat tidak pernah tampil sebagai rute kosong.
        isi = <ErrorState title="Rute gagal dimuat" message={`${load.error} Ini bukan rute kosong; kunjungan yang sudah tersimpan tidak hilang.`} onRetry={muatUlang} />;
    } else if (!asal) {
        isi = <><Skeleton rows={2} label="Memuat rute" /><Skeleton rows={5} label="Memuat rute" /></>;
    } else if (rows.length === 0) {
        isi = <EmptyState title={tanggal === hariIniWita() ? "Tidak ada rute terjadwal hari ini" : "Tidak ada rute terjadwal pada tanggal ini"}
            message={`JKS ${salesCode} tidak punya toko ${principle} untuk ${hariLabel}. Bila ini keliru, minta SPV memeriksa JKS atau pilih principal lain.`} />;
    } else {
        const lebar = (k: number) => `${rows.length ? (k / rows.length) * 100 : 0}%`;
        const nOrder = n.order + n.aktif;
        isi = (
            <div className={load.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={load.status === "memuat" || undefined}>
                {load.status === "galat" && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {load.error} Yang tampil adalah hasil sebelumnya.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                    </MessageStrip>
                )}
                <div className="fi-panel">
                    <div className="flex flex-wrap justify-between gap-2">
                        <b className="fi-tnum">{n.dikunjungi} dari {rows.length} dikunjungi</b>
                        <span className="fi-small fi-subtle fi-tnum">{rows.length - n.dikunjungi} belum</span>
                    </div>
                    <div role="img" aria-label={`${nOrder} order, ${n.tidak} tidak order, ${rows.length - nOrder - n.tidak} belum`}
                        className="flex overflow-hidden" style={{ height: 8, borderRadius: "var(--r-pill)", background: "var(--surface-3)" }}>
                        <i style={{ width: lebar(nOrder), background: "var(--pos-solid)" }} />
                        <i style={{ width: lebar(n.tidak), background: "var(--neg-solid)" }} />
                    </div>
                    <p className="fi-small fi-muted fi-tnum">{nOrder} order · {n.tidak} tidak order · {rows.length - nOrder - n.tidak} belum</p>
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Saring toko">
                    {([["semua", "Semua", rows.length], ["belum", "Belum selesai", n.belumSelesai], ["tidak", "Tidak order", n.tidak], ["perhatian", "Perhatian", n.perhatian]] as const).map(([k, label, jml]) => (
                        <Button key={k} variant={saring === k ? "primary" : "secondary"} aria-pressed={saring === k} count={jml} onClick={() => setSaring(k)}>{label}</Button>
                    ))}
                </div>
                <Section title="Toko di rute" subtitle={`${shown.length} toko`}>
                    {shown.length === 0 ? <EmptyState title="Tidak ada toko pada saringan ini" message="Pilih saringan lain untuk melihat toko lainnya." /> : (
                        <ul aria-label="Toko di rute" style={{ listStyle: "none", padding: 0 }}>
                            {shown.map((r) => {
                                const b = badgeToko(r);
                                const q = new URLSearchParams({ salesCode: r.salesCode, principle, date: tanggal });
                                const alasanBintang = bukanPemilik ?? (adaHasilKunjungan(r.status) ? "Toko ini sudah punya hasil kunjungan" : undefined);
                                return (
                                    <li key={r.id ?? r.custCode} className="fi-wl-row" style={{ gridTemplateColumns: "auto minmax(0,1fr)", paddingLeft: 4 }}>
                                        <Button variant="icon" aria-pressed={r.isPriority} aria-label={`Prioritas ${r.custName}`} title="Tandai prioritas"
                                            disabled={Boolean(alasanBintang)} disabledReason={alasanBintang} onClick={() => tandai(r)}>
                                            <Star className="fi-icon" aria-hidden style={r.isPriority ? { fill: "var(--warn-solid)", color: "var(--warn-solid)" } : undefined} />
                                        </Button>
                                        <ListItem href={`/form-kontrol/visit/${encodeURIComponent(r.custCode)}?${q}`} doc={r.custCode} title={r.custName}
                                            meta={metaToko(r)} badge={<StatusBadge tone={b.tone}>{b.label}</StatusBadge>} />
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Section>
            </div>
        );
    }

    return (
        <section aria-labelledby={judulId} className="grid gap-4">
            <div className="grid gap-1">
                <h2 id={judulId} className="fi-title-2">Rute hari ini</h2>
                <p className="fi-small fi-muted flex flex-wrap items-center gap-x-2">
                    <CalendarDays className="fi-icon" aria-hidden />
                    <span>{hariLabel} · WITA</span>
                    {salesCode && <span>· <span className="fi-mono">{salesCode}</span>{scope.salesName && salesman ? ` ${scope.salesName}` : ""} · {principle}</span>}
                </p>
            </div>

            <div className="fi-formgrid">
                <FormField label="Principal">
                    {(a) => (
                        <select {...a} className="fi-input" value={principle} onChange={(e) => { setPrinciple(e.target.value); setSukses(""); }}>
                            {PRINCIPLES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    )}
                </FormField>
                {!salesman && tim === null && (
                    <FormField label="Kode salesman">
                        {(a) => <input {...a} className="fi-input fi-mono" value={salesCode} placeholder="mis. S01" onChange={(e) => { setSalesCode(e.target.value); setSukses(""); }} />}
                    </FormField>
                )}
                {!salesman && tim !== null && tim.length > 0 && (
                    <FormField label="Salesman tim">
                        {(a) => (
                            <select {...a} className="fi-input" value={salesCode} onChange={(e) => { setSalesCode(e.target.value); setSukses(""); }}>
                                <option value="">Pilih salesman</option>
                                {tim.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        )}
                    </FormField>
                )}
                {!salesman && (
                    <FormField label="Tanggal">
                        {(a) => <input {...a} type="date" className="fi-input" value={tanggalPilih} onChange={(e) => { if (e.target.value) setTanggalPilih(e.target.value); setSukses(""); }} />}
                    </FormField>
                )}
                {salesCode && (
                    <div className="flex items-end">
                        <Button icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang} busy={load.status === "memuat" && Boolean(asal)}>Muat ulang</Button>
                    </div>
                )}
            </div>

            {salesman && beku.berganti && (
                <MessageStrip tone="warn" title="Tanggal sudah berganti.">
                    Rute dan isian yang tampil masih untuk {hariLabel}; tidak ada yang dibuang.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => { setSukses(""); beku.pakaiHariBaru(); }}>Muat rute {tanggalPanjang(beku.hariBaru)}</button>
                </MessageStrip>
            )}
            {sukses && <MessageStrip tone="pos" title="Terkirim.">{sukses}</MessageStrip>}
            {nUbah > 0 && <p className="fi-draft" role="status">{nUbah} tanda prioritas belum dikirim — kirim lewat “Kirim status rute {judulHari}”.</p>}

            {isi}

            <Section title="Akhir hari" subtitle="setelah kunjungan terakhir">
                <div className="fi-sect-in">
                    <p className="fi-small fi-muted">
                        Kirim status rute mengirim status setiap toko di daftar ini apa adanya, termasuk tanda prioritas. Toko yang belum disentuh
                        tercatat “tidak dikunjungi”. Laporan harian (tindak lanjut untuk SPV) dikirim di tab Laporan Harian.
                    </p>
                    <div className="fi-btnrow">
                        <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(kirimTerkunci)} disabledReason={kirimTerkunci}
                            onClick={() => setDialog(true)}>Kirim status rute {judulHari}…</Button>
                        <Link className="fi-btn fi-btn--secondary" href="/form-kontrol?tab=laporan"><FileText className="fi-icon" aria-hidden />Buka laporan harian</Link>
                    </div>
                    {kirimTerkunci && rows.length > 0 && <p className="fi-small fi-why">{kirimTerkunci}</p>}
                    <VariantNote bl="it05 #4">
                        Status kunjungan sudah tersimpan per toko saat check-in/status/check-out, tetapi tanda prioritas dan toko yang tidak
                        dikunjungi baru tercatat lewat kiriman ini, dan Dashboard SPV menghitung rute dari baris kiriman ini. Usulan: status
                        ditulis hanya per kunjungan dan rute direncanakan dibaca dari JKS; tombol ini lalu dihapus.
                    </VariantNote>
                </div>
            </Section>

            <VariantNote bl="BL-28">Tanggal “hari ini” dihitung di ponsel dalam WITA. Usulan: server yang menetapkan tanggal dan cap foto WITA.</VariantNote>
            <VariantNote bl="BL-32">
                Principal dipilih manual (bawaan GODREJ) karena profil belum mengirim principal salesman. Usulan: principal dari profil; pilihan
                hanya muncul bila salesman memegang lebih dari satu.
            </VariantNote>

            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Kirim status ${rows.length} toko rute ${judulHari}?`}
                description="Rute dibaca ulang dari server sesaat sebelum dikirim; status setiap toko dikirim dari bacaan itu, satu per satu, ditambah tanda prioritas dari layar ini. Toko yang belum disentuh tercatat “tidak dikunjungi”; Dashboard SPV menghitung rute dari kiriman ini."
                facts={[
                    ["Tanggal", `${hariLabel} · WITA`],
                    ["Salesman · principal", `${salesCode} · ${principle}`],
                    ["Order", String(n.order)],
                    ...(n.aktif ? [["Aktif", String(n.aktif)] as [string, string]] : []),
                    ["Tidak order", String(n.tidak)],
                    ["Prioritas", String(n.prioritas)],
                    ["Belum dikunjungi", String(n.belum)],
                ]}
                confirmLabel="Kirim status" onConfirm={kirimStatus} />
        </section>
    );
}
