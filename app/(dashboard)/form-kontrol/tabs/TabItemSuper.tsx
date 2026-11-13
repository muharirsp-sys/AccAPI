/*
 * Tujuan: Tab Item Super Form Kontrol (owner 13 Nov 2026): ringkasan daftar item super per principal × channel, isi daftar per principal, dan
 *   unggah berkas "Item Super per Channel per Principal" dengan pratinjau (saran, varian digabung, baris bermasalah) + peta principal/sales MT.
 * Caller: form-kontrol/FormKontrol.tsx (tab "item-super").
 * Dependensi: GET/POST /api/form-kontrol/item-super, GET /api/form-kontrol/sales-profiles (peta sales MT), lib/form-kontrol/item-super (murni:
 *   bacaItemSuper, nilaiUntukPetaItemSuper, tebakPetaItemSuper), ../shared, components/fiori/*, xlsx (dimuat saat dipakai).
 * Main Functions: TabItemSuper (default), bacaBerkas.
 * Side Effects: POST multipart (izin form_kontrol.manage) mengganti daftar item super principal yang dipetakan.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { SHEET_ITEM_SUPER, bacaItemSuper, nilaiUntukPetaItemSuper, tebakPetaItemSuper, type PetaItemSuper } from "@/lib/form-kontrol/item-super";
import { KOSONG, waktuWita } from "@/lib/tampil";
import { ambilFk, tulisFk, useIzinFk, type Scope } from "../shared";

type Ringkas = { principle: string; channel: string; jumlahChannel: number; jumlahSales: number; periode: string; diunggahPada: string };
type Baris = { channel: string; salesCode: string; peringkat: number; kodeBarang: string; kodeLain: string[]; namaBarang: string;
    kontribusi: number | null; omzetRata: number | null; jumlahToko: number | null };
type Profil = { salesCode: string; salesName: string };
type Berkas = { channel: Record<string, unknown>[]; mtSales: Record<string, unknown>[]; nilai: ReturnType<typeof nilaiUntukPetaItemSuper>; periode: string };

const rupiah = (n: number | null) => (n === null ? KOSONG : `Rp ${new Intl.NumberFormat("id-ID").format(Math.round(n))}`);

/** Baca berkas di peramban: tiga sheet ber-judul (header baris 3) + periode dari judul sheet pertama ("… - Mei s/d Okt 2026"). */
async function bacaBerkas(file: File): Promise<Berkas> {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = (nama: string) => {
        const s = wb.Sheets[wb.SheetNames.find((n) => n.trim().toLowerCase() === nama.toLowerCase()) ?? ""];
        return s ? XLSX.utils.sheet_to_json<Record<string, unknown>>(s, { defval: "", range: 2 }) : [];
    };
    const channel = sheet(SHEET_ITEM_SUPER.channel), mtSales = sheet(SHEET_ITEM_SUPER.mtSales);
    const judul = String((XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames.find((n) => n.trim().toLowerCase() === SHEET_ITEM_SUPER.channel.toLowerCase()) ?? ""] ?? {}, { header: 1 })[0] ?? [])[0] ?? "");
    return { channel, mtSales, nilai: nilaiUntukPetaItemSuper(channel, mtSales, sheet(SHEET_ITEM_SUPER.ringkasanSales)),
        periode: /-\s*([A-Za-z]+\s+s\/d\s+[A-Za-z]+\s+\d{4})\s*$/.exec(judul)?.[1] ?? "" };
}

export default function TabItemSuper({ scope }: { scope: Scope }) {
    const izin = useIzinFk("manage");
    const [ringkas, muatUlang] = useLoad(useCallback(() => ambilFk("/api/form-kontrol/item-super",
        (j) => (j.ringkasan ?? []) as Ringkas[], "Ringkasan item super belum berhasil dimuat."), []));
    const daftarPrincipal = [...new Set((ringkas.data ?? []).map((r) => r.principle))];
    const [pilih, setPilih] = useState("");
    const principal = pilih || daftarPrincipal[0] || "";
    const [isi, muatIsi] = useLoad(useCallback(async (): Promise<Load<Baris[]>> => (principal
        ? ambilFk(`/api/form-kontrol/item-super?principle=${encodeURIComponent(principal)}`, (j) => (j.rows ?? []) as Baris[], "Daftar item super belum berhasil dimuat.")
        : { status: "siap", data: [] }), [principal]), { pertahankan: true });

    // Dialog unggah.
    const [buka, setBuka] = useState(false);
    const [berkas, setBerkas] = useState<File | null>(null);
    const [baca, setBaca] = useState<{ status: "kosong" | "membaca" | "siap" | "galat"; data?: Berkas; galat?: string }>({ status: "kosong" });
    const [profil, setProfil] = useState<Profil[]>([]);
    const [peta, setPeta] = useState<PetaItemSuper>({ principal: {}, sales: {} });
    const [periode, setPeriode] = useState("");
    const [hasil, setHasil] = useState("");
    const giliran = useRef(0);

    const pilihBerkas = async (file: File | null) => {
        const ini = ++giliran.current;
        setBerkas(file);
        if (!file) { setBaca({ status: "kosong" }); return; }
        setBaca({ status: "membaca" });
        try {
            const [b, p] = await Promise.all([bacaBerkas(file),
                ambilFk("/api/form-kontrol/sales-profiles", (j) => (j.rows ?? []) as Profil[], "Profil sales belum berhasil dimuat.")]);
            if (ini !== giliran.current) return;
            if (b.channel.length === 0) { setBaca({ status: "galat", galat: `Sheet "${SHEET_ITEM_SUPER.channel}" tidak ditemukan atau kosong.` }); return; }
            const daftarProfil = p.status === "siap" ? p.data ?? [] : [];
            setProfil(daftarProfil);
            setPeta(tebakPetaItemSuper(b.nilai, scope.principles ?? [], daftarProfil));
            setPeriode(b.periode);
            setBaca({ status: "siap", data: b, galat: p.status === "galat" ? "Profil sales tidak termuat: daftar MT per sales tidak bisa dipetakan (daftar channel tetap)." : undefined });
        } catch {
            if (ini === giliran.current) setBaca({ status: "galat", galat: "Berkas tidak bisa dibaca sebagai Excel." });
        }
    };
    const pratinjau = baca.status === "siap" && baca.data ? bacaItemSuper(baca.data.channel, baca.data.mtSales, peta) : null;
    const blokir = izin ?? (!berkas ? "Pilih berkas dulu" : baca.status === "membaca" ? "Tunggu pratinjau selesai"
        : baca.status !== "siap" ? baca.galat ?? "Berkas belum terbaca" : !periode.trim() ? "Isi periode data"
        : pratinjau && pratinjau.galat.length ? `${pratinjau.galat.length} baris bermasalah` : pratinjau && pratinjau.saran.length === 0 ? "Petakan minimal satu principal" : undefined);

    const kolomRingkas: Column<Ringkas>[] = [
        { key: "p", header: "Principal", cell: (r) => r.principle },
        { key: "c", header: "Channel", cell: (r) => r.channel },
        { key: "j", header: "Item super", align: "end", cell: (r) => <span className="fi-tnum">{r.jumlahChannel}</span> },
        { key: "s", header: "Daftar MT per sales", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{r.jumlahSales || KOSONG}</span> },
        { key: "per", header: "Periode", secondary: true, cell: (r) => r.periode },
        { key: "u", header: "Diunggah", secondary: true, cell: (r) => waktuWita(r.diunggahPada) },
    ];
    const kolomIsi: Column<Baris>[] = [
        { key: "c", header: "Channel", cell: (r) => <>{r.channel}{r.salesCode && <span className="fi-codes">sales {r.salesCode}</span>}</> },
        { key: "r", header: "#", align: "end", cell: (r) => <span className="fi-tnum">{r.peringkat}</span> },
        { key: "k", header: "Kode", cell: (r) => <><span className="fi-mono">{r.kodeBarang}</span>{r.kodeLain.length > 0 && <span className="fi-codes">varian: {r.kodeLain.join(", ")}</span>}</> },
        { key: "n", header: "Nama barang", cell: (r) => r.namaBarang },
        { key: "o", header: "Omzet rata-rata/bln", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{rupiah(r.omzetRata)}</span> },
        { key: "kt", header: "Kontribusi", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{r.kontribusi === null ? KOSONG : `${(r.kontribusi * 100).toFixed(1)}%`}</span> },
        { key: "t", header: "Toko beli", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{r.jumlahToko ?? KOSONG}</span> },
    ];

    return (
        <>
            <div className="fi-page-bar">
                <h2 className="fi-title-2">Item Super</h2>
                <span className="fi-spacer" />
                <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={() => { muatUlang(); muatIsi(); }}>Muat ulang</Button>
                <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} disabled={Boolean(izin)} disabledReason={izin}
                    onClick={() => { setBerkas(null); setBaca({ status: "kosong" }); setPeta({ principal: {}, sales: {} }); setBuka(true); }}>Unggah berkas</Button>
            </div>
            <p className="fi-small fi-muted">
                Item super = item yang membentuk 80% omzet rata-rata per bulan per principal dan channel. Saat kunjungan, salesman mendapat saran
                item super yang belum dibeli toko 3 bulan terakhir (maks. 10) dan wajib mencatat penawaran, pesanan, dan alasan bila tidak dipesan.
                Varian berkode 13 digit sama (promo/banded/akhiran N) dan kode yang digabung di berkas menjadi satu saran.
            </p>
            {hasil && <MessageStrip tone="pos" title="Item super tersimpan." onClose={() => setHasil("")}>{hasil}</MessageStrip>}
            <ResponsiveTable title="Daftar per principal dan channel" count={ringkas.data?.length ?? 0} columns={kolomRingkas} rows={ringkas.data ?? []}
                rowKey={(r) => `${r.principle}|${r.channel}`} status={ringkas.status} error={ringkas.error} onRetry={muatUlang}
                mobileItem={(r) => <ListItem doc={r.channel} title={r.principle} amount={<span className="fi-tnum">{r.jumlahChannel} item</span>}
                    meta={`${r.periode}${r.jumlahSales ? ` · ${r.jumlahSales} daftar MT per sales` : ""} · diunggah ${waktuWita(r.diunggahPada)}`} />}
                empty={{ title: "Belum ada item super", message: "Unggah berkas Item Super per Channel per Principal untuk memulai." }} />
            {daftarPrincipal.length > 0 && (
                <>
                    <FormField label="Lihat isi principal">{(a) => (
                        <select {...a} className="fi-input" value={principal} onChange={(e) => setPilih(e.target.value)}>
                            {daftarPrincipal.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    )}</FormField>
                    <ResponsiveTable title={`Item super ${principal}`} count={isi.data?.length ?? 0} columns={kolomIsi} rows={isi.data ?? []}
                        rowKey={(r) => `${r.channel}|${r.salesCode}|${r.kodeBarang}`} status={isi.status} error={isi.error} onRetry={muatIsi}
                        mobileItem={(r) => <ListItem doc={<span className="fi-mono">{r.kodeBarang}</span>} title={r.namaBarang} amount={<span className="fi-tnum">#{r.peringkat}</span>}
                            meta={`${r.channel}${r.salesCode ? ` · sales ${r.salesCode}` : ""} · ${rupiah(r.omzetRata)}/bln${r.kodeLain.length ? ` · varian ${r.kodeLain.join(", ")}` : ""}`} />}
                        empty={{ title: "Tidak ada item", message: "Principal ini belum punya daftar." }} />
                </>
            )}
            <ConfirmDialog
                open={buka}
                onClose={() => setBuka(false)}
                tag="Item Super"
                title="Ganti daftar item super?"
                description="Daftar lama SEMUA channel principal yang dipetakan diganti isi berkas ini (termasuk daftar MT per sales). Principal yang tidak dipetakan tidak disentuh."
                confirmLabel="Ganti daftar"
                confirmDisabled={blokir}
                onConfirm={async () => {
                    const fd = new FormData();
                    fd.append("file", berkas!);
                    fd.append("peta", JSON.stringify(peta));
                    fd.append("periode", periode.trim());
                    const d = await tulisFk("/api/form-kontrol/item-super", { body: fd, gagal: "Unggah item super gagal; tidak ada yang ditulis." });
                    const principalDitulis = Array.isArray(d.principal) ? d.principal.length : 0;
                    setHasil(`${Number(d.ditulis ?? 0)} saran untuk ${principalDitulis} principal (menggantikan ${Number(d.diganti ?? 0)} baris lama); ${Number(d.varianDigabung ?? 0)} varian digabung.`);
                    setBuka(false);
                    muatUlang(); muatIsi();
                }}
            >
                <FormField label="Berkas Item Super (.xlsx)" required help={`Sheet "${SHEET_ITEM_SUPER.channel}" wajib; "${SHEET_ITEM_SUPER.mtSales}" dan "${SHEET_ITEM_SUPER.ringkasanSales}" bila ada.`}>{(a) => (
                    <input {...a} className="fi-input" type="file" accept=".xlsx" onChange={(e) => void pilihBerkas(e.target.files?.[0] ?? null)} />
                )}</FormField>
                {baca.status === "membaca" && <Skeleton rows={2} label={`Membaca ${berkas?.name ?? "berkas"}`} />}
                {baca.status === "galat" && <p className="fi-msg" role="alert">{baca.galat}</p>}
                {baca.status === "siap" && baca.data && pratinjau && (
                    <>
                        {baca.galat && <MessageStrip tone="warn" title="Sebagian tidak bisa dipetakan.">{baca.galat}</MessageStrip>}
                        <FormField label="Periode data" required>{(a) => (
                            <input {...a} className="fi-input" value={periode} maxLength={60} placeholder="mis. Mei s/d Okt 2026" onChange={(e) => setPeriode(e.target.value)} />
                        )}</FormField>
                        <KeyValues items={[
                            ["Baris item super", `${baca.data.channel.length} per channel · ${baca.data.mtSales.length} MT per sales`],
                            ["Saran siap ditulis", `${pratinjau.saran.length} (${pratinjau.varianDigabung} varian digabung)`],
                            ["Principal dilewati (belum dipetakan)", pratinjau.lewat.principal.length ? pratinjau.lewat.principal.join(", ") : KOSONG],
                            ["Sales MT dilewati", pratinjau.lewat.sales.length ? pratinjau.lewat.sales.join(", ") : KOSONG],
                        ]} />
                        {pratinjau.galat.length > 0 && (
                            <MessageStrip tone="neg" title={`${pratinjau.galat.length} baris bermasalah; tidak bisa diunggah.`}>
                                {pratinjau.galat.slice(0, 10).map((g) => `${g.sheet} baris ${g.baris}: ${g.pesan}`).join("; ")}
                            </MessageStrip>
                        )}
                        <fieldset className="grid gap-2" style={{ border: 0, padding: 0, margin: 0 }}>
                            <legend className="fi-title-3">Principal di berkas → principal JKS sistem</legend>
                            <datalist id="principal-item-super">{(scope.principles ?? []).map((p) => <option key={p} value={p} />)}</datalist>
                            {baca.data.nilai.principal.map((p) => (
                                <FormField key={p} label={p} help="Kosongkan untuk melewati principal ini (daftar lamanya tetap).">{(a) => (
                                    <input {...a} className="fi-input" list="principal-item-super" value={peta.principal[p] ?? ""}
                                        onChange={(e) => setPeta((x) => ({ ...x, principal: { ...x.principal, [p]: e.target.value.trim() } }))} />
                                )}</FormField>
                            ))}
                        </fieldset>
                        {baca.data.nilai.sales.length > 0 && (
                            <fieldset className="grid gap-2" style={{ border: 0, padding: 0, margin: 0 }}>
                                <legend className="fi-title-3">Sales MT di berkas → profil sales</legend>
                                {baca.data.nilai.sales.map((s) => (
                                    <FormField key={s.nilai} label={`${s.nilai}${s.salesmanData.length ? ` (${s.salesmanData.join("; ")})` : ""}`}
                                        help="Tanpa profil = daftar khusus sales ini dilewati; toko MT-nya memakai daftar channel MT.">{(a) => (
                                        <select {...a} className="fi-input" value={peta.sales[s.nilai] ?? ""}
                                            onChange={(e) => setPeta((x) => ({ ...x, sales: { ...x.sales, [s.nilai]: e.target.value } }))}>
                                            <option value="">Lewati</option>
                                            {profil.map((p) => <option key={p.salesCode} value={p.salesCode}>{p.salesName} · {p.salesCode}</option>)}
                                        </select>
                                    )}</FormField>
                                ))}
                            </fieldset>
                        )}
                        {pratinjau.saran.length > 0 && <StatusBadge tone="info">{`Principal ditulis: ${[...new Set(pratinjau.saran.map((s) => s.principle))].join(", ")}`}</StatusBadge>}
                    </>
                )}
            </ConfirmDialog>
        </>
    );
}
