/*
 * Tujuan: Bagian kualitas data di halaman Data periode (Fiori S4c, it07): kode sales mirip (gabung/pisah), SPV tidak sinkron
 *   antara target dan laporan penjualan, kombinasi penjualan tanpa target (dimuat saat dibuka), dan "Tambah salesman ke tim
 *   saya" untuk SPV tanpa izin kelola hierarki (dulu di tab Input Penjualan). Semua keputusan lewat ConfirmDialog (it07 #19).
 * Caller: DataPeriode.tsx (dipasang ulang lewat `key` setelah data periode berubah).
 * Dependensi: components/fiori/{core,interactive}, lib/rekapan-nota/ui (ambil, tanggalPendek), lib/promo-ui (rupiah), lib/insentif-ui (readApi, formatQty).
 * Main Functions: KualitasData.
 * Side Effects: GET code-merge, spv-mismatch, unmatched (saat dibuka), hierarchy/my-identity; POST code-merge, POST spv-mismatch,
 *   POST hierarchy/spv-sales (SPV mandiri); clipboard (Salin daftar tanpa target).
 */
"use client";

import { useCallback, useState } from "react";
import { Copy, UserPlus } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { ambil, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { rupiah } from "@/lib/promo-ui";
import { formatQty, readApi } from "@/lib/insentif-ui";

// Konfirmasi penggabungan kode sales (pergantian orang di tengah bulan). Prefiks rute sama + kode beda. TIDAK otomatis:
// FS1_GITO (GT) vs FS1_MT_SYAHRUL (MT) prefiksnya sama tapi orang & channel beda — user yang memutuskan.
interface MergeMember { salesCode: string; salesName: string }
interface MergeGroup { prefix: string; members: MergeMember[] }
// Sinkronisasi SPV: target vs closing (kolom GOLONGAN). Sistem tidak menebak mana yang benar — semua kandidat ditampilkan.
interface SpvMismatchRow { salesCode: string; salesName: string; principle: string; spvTarget: string | null; spvClosing: string[] }
interface UnmatchedRow {
    salesCode: string; principle: string; branch: string; baris: number; dpp: number;
    tanggalAwal: string; tanggalAkhir: string; contohNota: string[]; sebab: "tanpa baris target" | "target 0";
}
interface MyIdentity { identity: { role: "spv" | "sm" | "sales"; name: string } | null; isAdmin: boolean }

type Dlg =
    | { kind: "gabung"; g: MergeGroup; to: string }
    | { kind: "pisah"; g: MergeGroup }
    | { kind: "spv"; r: SpvMismatchRow; spv: string }
    | { kind: "tim" }
    | null;

async function kirim(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readApi(res);
    if (!res.ok) throw new Error(String(data.error ?? "Gagal menyimpan."));
    return { status: res.status, data };
}

type Props = { month: number; year: number; label: string; bolehHierarki: boolean; onBerubah: () => void };

export function KualitasData({ month, year, label, bolehHierarki, onBerubah }: Props) {
    const [merge, muatMerge] = useLoad(useCallback(() => ambil<MergeGroup[]>(`/api/insentif-sales/code-merge?month=${month}&year=${year}`,
        (j) => (j as { groups?: MergeGroup[] }).groups ?? []), [month, year]));
    const [mismatch, muatMismatch] = useLoad(useCallback(() => ambil<SpvMismatchRow[]>(`/api/insentif-sales/spv-mismatch?month=${month}&year=${year}`,
        (j) => (j as { rows?: SpvMismatchRow[] }).rows ?? []), [month, year]));
    // Kombinasi sales × principal yang punya penjualan tapi tidak punya target. Diambil hanya saat dibuka — query agregasi
    // nota tidak perlu dibayar setiap kali halaman dibuka. Nomor nota ikut tampil karena tanpa itu "22 kombinasi tanpa target"
    // tidak bisa ditindaklanjuti: yang dibutuhkan orang untuk memetakan adalah nota yang bisa dibuka di Accurate.
    const [buka, setBuka] = useState(false);
    const [tanpa, muatTanpa] = useLoad(useCallback(async (): Promise<Load<UnmatchedRow[]>> => (buka
        ? ambil<UnmatchedRow[]>(`/api/insentif-sales/unmatched?month=${month}&year=${year}`, (j) => (j as { rows?: UnmatchedRow[] }).rows ?? [])
        : { status: "siap", data: [] }), [buka, month, year]));
    const [saya, muatSaya] = useLoad(useCallback(() => ambil<MyIdentity>("/api/insentif-sales/hierarchy/my-identity"), []));

    const [tujuan, setTujuan] = useState<Record<string, string>>({});
    const [dialog, setDialog] = useState<Dlg>(null);
    const [kodeBaru, setKodeBaru] = useState("");
    const [pesan, setPesan] = useState<{ tone: "pos" | "info" | "neg"; teks: string } | null>(null);

    const spvMandiri = saya.data && !saya.data.isAdmin && saya.data.identity?.role === "spv" ? saya.data.identity.name : null;
    const tanpaIzin = bolehHierarki ? undefined : "Butuh izin kelola hierarki";

    async function putuskan(g: MergeGroup, payload: Array<{ fromSalesCode: string; toSalesCode?: string; decision: "merge" | "separate" }>) {
        const { data } = await kirim("/api/insentif-sales/code-merge", payload.map((x) => ({ ...x, prefix: g.prefix, periodMonth: month, periodYear: year })));
        setPesan({ tone: "pos", teks: `${g.prefix}: ${Number(data.saved ?? 0)} keputusan tersimpan untuk ${label}.` });
        setDialog(null);
        muatMerge(); onBerubah();
    }

    async function sinkronSpv(r: SpvMismatchRow, spvName: string) {
        await kirim("/api/insentif-sales/spv-mismatch", { salesCode: r.salesCode, principle: r.principle, periodMonth: month, periodYear: year, spvName });
        setPesan({ tone: "pos", teks: `${r.salesCode} / ${r.principle} → SPV ${spvName}.` });
        setDialog(null);
        muatMismatch(); onBerubah();
    }

    async function tambahTim() {
        const kode = kodeBaru.trim();
        const { status } = await kirim("/api/insentif-sales/hierarchy/spv-sales", { salesCode: kode, spvName: "" });
        setPesan(status === 202
            ? { tone: "info", teks: `Salesman ${kode} sudah ditangani SPV lain. Permintaan klaim dikirim untuk persetujuan admin.` }
            : { tone: "pos", teks: `Salesman ${kode} ditambahkan ke tim Anda.` });
        setKodeBaru(""); setDialog(null);
        onBerubah();
    }

    function salin() {
        const rows = tanpa.data ?? [];
        if (!rows.length) return;
        const teks = ["Kode\tPrincipal\tCabang\tSebab\tBaris\tDPP\tContoh Nota"]
            .concat(rows.map((r) => [r.salesCode, r.principle, r.branch, r.sebab, r.baris, Math.round(r.dpp), r.contohNota.join(" ")].join("\t")))
            .join("\n");
        navigator.clipboard.writeText(teks)
            .then(() => setPesan({ tone: "pos", teks: `${rows.length} baris disalin, siap ditempel ke Excel.` }))
            .catch(() => setPesan({ tone: "neg", teks: "Gagal menyalin ke clipboard." }));
    }

    const kolomMerge: Column<MergeGroup>[] = [
        { key: "prefix", header: "Kelompok", cell: (g) => <span className="fi-mono">{g.prefix}</span> },
        { key: "kode", header: "Kode di kelompok", cell: (g) => g.members.map((m) => <div key={m.salesCode} className="fi-small"><span className="fi-mono">{m.salesCode}</span> · {m.salesName}</div>) },
        { key: "aksi", header: "Keputusan", cell: (g) => keputusan(g) },
    ];
    function keputusan(g: MergeGroup) {
        const to = tujuan[g.prefix] ?? "";
        return (
            <div className="grid gap-2" style={{ minWidth: 0 }}>
                {/* Lebar 100% (bukan auto): select selebar opsi terpanjang meluap di ponsel 390 px. */}
                <select className="fi-input" aria-label={`Kode tujuan ${g.prefix}`} style={{ minWidth: "10rem" }} value={to} disabled={!bolehHierarki}
                    onChange={(e) => setTujuan((prev) => ({ ...prev, [g.prefix]: e.target.value }))}>
                    <option value="">Gabung ke…</option>
                    {g.members.map((m) => <option key={m.salesCode} value={m.salesCode}>{m.salesCode} — {m.salesName}</option>)}
                </select>
                <div className="fi-btnrow">
                    <Button disabled={Boolean(tanpaIzin) || !to} disabledReason={tanpaIzin ?? "Pilih kode tujuan dulu"} onClick={() => setDialog({ kind: "gabung", g, to })}>Gabungkan…</Button>
                    <Button variant="tertiary" disabled={Boolean(tanpaIzin)} disabledReason={tanpaIzin} onClick={() => setDialog({ kind: "pisah", g })}>Orang berbeda…</Button>
                </div>
            </div>
        );
    }

    const pilihanSpv = (r: SpvMismatchRow) => [...(r.spvTarget ? [{ spv: r.spvTarget, asal: "target" }] : []), ...r.spvClosing.map((spv) => ({ spv, asal: "laporan" }))];
    const tombolSpv = (r: SpvMismatchRow) => (
        <div className="fi-btnrow">
            {pilihanSpv(r).map(({ spv, asal }) => (
                <Button key={`${asal}-${spv}`} disabled={Boolean(tanpaIzin)} disabledReason={tanpaIzin} onClick={() => setDialog({ kind: "spv", r, spv })}>
                    Pakai {spv}{asal === "laporan" ? " (laporan)" : ""}…
                </Button>
            ))}
        </div>
    );
    const kolomSpv: Column<SpvMismatchRow>[] = [
        { key: "sales", header: "Salesman", cell: (r) => <><span className="fi-mono">{r.salesCode}</span> · {r.salesName}</> },
        { key: "principle", header: "Principal", cell: (r) => r.principle },
        { key: "target", header: "Di target", cell: (r) => r.spvTarget ?? <span className="fi-why">kosong</span> },
        { key: "laporan", header: "Di laporan penjualan", cell: (r) => r.spvClosing.join(", ") },
        { key: "aksi", header: "Pakai", cell: tombolSpv },
    ];
    const kolomTanpa: Column<UnmatchedRow>[] = [
        { key: "kode", header: "Kode", cell: (r) => <span className="fi-mono">{r.salesCode}</span> },
        { key: "principle", header: "Principal", cell: (r) => r.principle },
        { key: "branch", header: "Cabang", secondary: true, cell: (r) => r.branch },
        { key: "sebab", header: "Sebab", cell: (r) => <StatusBadge tone={r.sebab === "target 0" ? "warn" : "neu"}>{r.sebab}</StatusBadge> },
        { key: "dpp", header: "Nilai (DPP)", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(Math.round(r.dpp))}</span> },
        { key: "baris", header: "Baris", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{formatQty(r.baris)}</span> },
        { key: "tgl", header: "Tanggal", secondary: true, cell: (r) => <span className="fi-tnum">{tanggalPendek(r.tanggalAwal)} s/d {tanggalPendek(r.tanggalAkhir)}</span> },
        { key: "nota", header: "Contoh nota", secondary: true, cell: (r) => <span className="fi-mono">{r.contohNota.join(", ") || "—"}</span> },
    ];

    const d = dialog;
    return (
        <>
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
            {saya.status === "galat" && !saya.data && (
                <MessageStrip tone="neg" title="Identitas hierarki akun Anda gagal dimuat.">
                    Bagian Tambah salesman ke tim saya (khusus SPV) belum bisa ditampilkan. {saya.error} <Button variant="tertiary" onClick={muatSaya}>Coba lagi</Button>
                </MessageStrip>
            )}

            <Section id="kode-mirip" title="Kode sales mirip" subtitle={`rute sama atau nama sama dengan kode berbeda · keputusan berlaku untuk ${label}`}>
                <div className="fi-sect-in">
                    <p className="fi-small fi-subtle">
                        Pilih kode tujuan bila pencapaiannya harus digabung (pergantian orang di tengah bulan, atau satu orang dua kode),
                        atau tandai Orang berbeda. Tidak ada yang digabung otomatis.
                    </p>
                </div>
                <ResponsiveTable<MergeGroup> title="Kode sales mirip" count={merge.data?.length} columns={kolomMerge} rows={merge.data ?? []} rowKey={(g) => g.prefix}
                    status={merge.status} error={merge.error ? `Kandidat gabung belum berhasil dimuat (${merge.error}).` : undefined} onRetry={muatMerge}
                    empty={{ title: "Tidak ada kode sales mirip", message: `Semua kode sales ${label} sudah diputuskan atau tidak punya kembaran.` }}
                    mobileItem={(g) => <ListItem doc={g.prefix} title={g.members.map((m) => `${m.salesCode} · ${m.salesName}`).join(" / ")} meta={keputusan(g)} />} />
            </Section>

            <Section id="spv-sinkron" title="SPV tidak sinkron" subtitle="SPV di target berbeda dengan kolom GOLONGAN di laporan penjualan">
                <ResponsiveTable<SpvMismatchRow> title="SPV tidak sinkron" count={mismatch.data?.length} columns={kolomSpv} rows={mismatch.data ?? []} rowKey={(r) => `${r.salesCode}|${r.principle}`}
                    status={mismatch.status} error={mismatch.error ? `Data SPV belum berhasil dimuat (${mismatch.error}).` : undefined} onRetry={muatMismatch}
                    empty={{ title: "SPV target dan laporan sudah sinkron", message: `Tidak ada perbedaan SPV di ${label}.` }}
                    mobileItem={(r) => <ListItem doc={r.salesCode} title={`${r.salesName} · ${r.principle}`} meta={<>Target: {r.spvTarget ?? "kosong"} · Laporan: {r.spvClosing.join(", ")}{tombolSpv(r)}</>} />} />
            </Section>

            <Section id="tanpa-target" title="Penjualan tanpa target" subtitle="kombinasi salesman × principal yang punya penjualan tetapi target tidak ada atau Rp 0"
                actions={buka && (tanpa.data?.length ?? 0) > 0 ? <Button variant="tertiary" icon={<Copy className="fi-icon" aria-hidden />} onClick={salin}>Salin</Button> : undefined}>
                {!buka ? (
                    <div className="fi-sect-in">
                        <p className="fi-small fi-subtle">Diurut dari nilai terbesar, dengan contoh nota yang bisa dibuka di Accurate untuk memastikan salesman sebenarnya.</p>
                        <div className="fi-btnrow"><Button onClick={() => setBuka(true)}>Tampilkan penjualan tanpa target</Button></div>
                    </div>
                ) : (
                    <ResponsiveTable<UnmatchedRow> title="Penjualan tanpa target" count={tanpa.data?.length} columns={kolomTanpa} rows={tanpa.data ?? []} rowKey={(r) => `${r.salesCode}|${r.principle}`}
                        status={tanpa.status} error={tanpa.error ? `Daftar belum berhasil dimuat (${tanpa.error}).` : undefined} onRetry={muatTanpa}
                        empty={{ title: "Semua kombinasi sudah punya target", message: `Setiap penjualan ${label} cocok dengan baris target bernilai.` }}
                        mobileItem={(r) => <ListItem doc={r.salesCode} amount={rupiah(Math.round(r.dpp))} title={`${r.principle} · ${r.branch}`} meta={r.contohNota.join(", ") || undefined}
                            badge={<StatusBadge tone={r.sebab === "target 0" ? "warn" : "neu"}>{r.sebab}</StatusBadge>} />} />
                )}
            </Section>

            {spvMandiri && (
                <Section id="tim-saya" title="Tambah salesman ke tim saya" subtitle={`sebagai SPV ${spvMandiri}`}
                    actions={<Button icon={<UserPlus className="fi-icon" aria-hidden />} onClick={() => setDialog({ kind: "tim" })}>Tambah salesman…</Button>}>
                    <div className="fi-sect-in"><p className="fi-small fi-subtle">Salesman baru langsung masuk tim Anda. Bila sudah ditangani SPV lain, permintaan klaim dikirim ke admin.</p></div>
                </Section>
            )}

            <ConfirmDialog open={d?.kind === "gabung"} onClose={() => setDialog(null)} tag="Kode sales" confirmLabel="Gabungkan"
                title={d?.kind === "gabung" ? `Gabungkan kelompok ${d.g.prefix} ke ${d.to}?` : ""}
                onConfirm={() => (d?.kind === "gabung" ? putuskan(d.g, d.g.members.filter((m) => m.salesCode !== d.to).map((m) => ({ fromSalesCode: m.salesCode, toSalesCode: d.to, decision: "merge" as const }))) : undefined)}
                facts={d?.kind === "gabung" ? [
                    ["Digabung", d.g.members.filter((m) => m.salesCode !== d.to).map((m) => `${m.salesCode} · ${m.salesName}`).join("; ")],
                    ["Ke", `${d.to} · ${d.g.members.find((m) => m.salesCode === d.to)?.salesName ?? ""}`],
                    ["Berlaku", label],
                    ["Akibat", "Realisasi kode yang digabung dijumlahkan ke kode tujuan pada hitungan berikutnya"],
                ] : []} />
            <ConfirmDialog open={d?.kind === "pisah"} onClose={() => setDialog(null)} tag="Kode sales" confirmLabel="Tandai orang berbeda"
                title={d?.kind === "pisah" ? `Tandai ${d.g.members.length} kode ${d.g.prefix} sebagai orang berbeda?` : ""}
                onConfirm={() => (d?.kind === "pisah" ? putuskan(d.g, d.g.members.map((m) => ({ fromSalesCode: m.salesCode, decision: "separate" as const }))) : undefined)}
                facts={d?.kind === "pisah" ? [
                    ["Kode", d.g.members.map((m) => `${m.salesCode} · ${m.salesName}`).join("; ")],
                    ["Berlaku", label],
                    ["Akibat", "Kelompok ini tidak ditanyakan lagi untuk periode ini; realisasi tetap per kode"],
                ] : []} />
            <ConfirmDialog open={d?.kind === "spv"} onClose={() => setDialog(null)} tag="SPV" confirmLabel={d?.kind === "spv" ? `Pakai ${d.spv}` : "Pakai"}
                title={d?.kind === "spv" ? `Pakai SPV ${d.spv} untuk ${d.r.salesName} · ${d.r.principle}?` : ""}
                onConfirm={() => (d?.kind === "spv" ? sinkronSpv(d.r, d.spv) : undefined)}
                facts={d?.kind === "spv" ? [
                    ["Salesman", `${d.r.salesCode} · ${d.r.salesName}`],
                    ["SPV di target", d.r.spvTarget ?? "kosong"],
                    ["SPV di laporan", d.r.spvClosing.join(", ")],
                    ["Diubah", `Baris target ${label} dan mapping hierarki Sales → SPV`],
                ] : []} />
            <ConfirmDialog open={d?.kind === "tim"} onClose={() => setDialog(null)} tag="Hierarki" confirmLabel="Tambahkan"
                title="Tambah salesman ke tim Anda?" confirmDisabled={kodeBaru.trim() ? undefined : "Isi kode sales dulu"} onConfirm={tambahTim}
                facts={[["SPV", spvMandiri ?? ""], ["Bila sudah milik SPV lain", "Permintaan klaim dikirim ke admin, bukan langsung dipindah"]]}>
                <FormField label="Kode sales" required>{(a) => <input {...a} className="fi-input" value={kodeBaru} onChange={(e) => setKodeBaru(e.target.value)} />}</FormField>
            </ConfirmDialog>
        </>
    );
}
