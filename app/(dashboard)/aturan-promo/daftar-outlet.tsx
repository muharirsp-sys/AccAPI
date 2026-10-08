/*
 * Tujuan: Daftar outlet peserta program (Fiori S4a) — "toko mana saja yang ikut". Tab di Aturan Promo.
 *   Tiga confirm browser diganti dialog: ganti tunjukan daftar (paksa), ubah periode semua anggota, keluarkan anggota.
 * Caller: app/(dashboard)/aturan-promo/AturanPromo.tsx.
 * Dependensi: GET|POST|PATCH|DELETE /api/promo-outlet; components/fiori/*; lib/promo-ui.
 * Main Functions: DaftarOutlet, PilihDaftar.
 * Side Effects: HTTP; setiap simpan menulis `promo_outlet` (izin summary.edit).
 *
 * Nama daftar adalah satu-satunya tali antara aturan promo dan daftar peserta. Daftar yang tidak ditunjuk aturan mana pun tersimpan
 * tetapi tidak memengaruhi gerbang apa pun — gagal yang sunyi — jadi talinya selalu diperlihatkan.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { CalendarRange, Download, FileUp, Plus, Trash2 } from "lucide-react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { tgl } from "@/lib/promo-ui";

type Member = { id: number; listName: string; customerCode: string; customerName: string; tier: string; sourceCode: string;
    periodStart: string | null; periodEnd: string | null; active: boolean; note: string; importedBy: string };
type ListInfo = { name: string; members: number; tiers: Record<string, number>; linked: { suratProgram: string; mode: string; rules: number }[] };
type Program = { suratProgram: string; promoLabel: string; periodStart: string | null; periodEnd: string | null; rules: number };
type Payload = { lists: ListInfo[]; members: Member[]; programs?: Program[]; distCode?: string };
type Tambah = { listName: string; codes: string; tier: string; periodStart: string; periodEnd: string; note: string };
type Laporan = { tone: "pos" | "warn" | "neg"; judul: string; rincian: string[] };

const modeLabel = (m: string) => (m === "EXCLUDE" ? "semua KECUALI peserta" : "hanya peserta");

/** Isian nama daftar yang memperlihatkan talinya ke aturan (datalist: promo berjalan bisa dipilih, daftar mandiri tetap bisa diketik). */
function PilihDaftar({ id, label, value, onChange, lists, programs, onTunjuk, help, kunci }: {
    id: string; label: string; value: string; onChange: (v: string) => void; lists: ListInfo[]; programs: Program[];
    onTunjuk?: (surat: string) => void; help?: string; kunci?: boolean;
}) {
    const nama = value.trim().toUpperCase();
    const linked = lists.find((e) => e.name.toUpperCase() === nama)?.linked ?? [];
    const [tujuan, setTujuan] = useState("");
    const pilihan = tujuan || (programs.some((p) => p.suratProgram.toUpperCase() === nama) ? nama : "");
    return (
        <div style={{ display: "grid", gap: 6 }}>
            <FormField label={label} help={help}>{(a11y) => <input {...a11y} className="fi-input" list={id} disabled={kunci} placeholder="LOYALTY atau nomor surat" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />}</FormField>
            <datalist id={id}>
                {programs.map((p) => <option key={`p-${p.suratProgram}`} value={p.suratProgram}>{`promo berjalan · ${p.rules} aturan${p.promoLabel ? ` · ${p.promoLabel}` : ""}`}</option>)}
                {lists.filter((e) => !programs.some((p) => p.suratProgram === e.name)).map((e) => <option key={`l-${e.name}`} value={e.name}>{`daftar yang sudah ada · ${e.members} toko`}</option>)}
            </datalist>
            {nama && (linked.length > 0
                ? <p className="fi-small" style={{ color: "var(--pos)" }}>Tersambung ke {linked.map((l) => `${l.suratProgram} (${modeLabel(l.mode)}, ${l.rules} aturan)`).join("; ")}.</p>
                : <MessageStrip tone="warn" title="Belum ada aturan promo yang menunjuk nama ini.">Selama begitu, daftarnya tidak memengaruhi gerbang mana pun.
                    {onTunjuk && !kunci && programs.length > 0 && (
                        <span className="fi-page-bar" style={{ marginTop: 6 }}>
                            <select className="fi-input" aria-label="Promo berjalan yang akan ditunjuk" value={pilihan} onChange={(e) => setTujuan(e.target.value)} style={{ width: "auto" }}>
                                <option value="">Pilih promo berjalan…</option>
                                {programs.map((p) => <option key={p.suratProgram} value={p.suratProgram}>{`${p.suratProgram}${p.promoLabel ? ` · ${p.promoLabel}` : ""} (${p.rules} aturan)`}</option>)}
                            </select>
                            <Button disabled={!pilihan} onClick={() => onTunjuk(pilihan)}>Tunjuk ke daftar ini</Button>
                        </span>
                    )}
                </MessageStrip>)}
        </div>
    );
}

export default function DaftarOutlet({ bolehUbah }: { bolehUbah: boolean }) {
    const [list, setList] = useState("");
    const [q, setQ] = useState("");
    const [distCodeKetik, setDistCode] = useState<string | null>(null);
    const [listName, setListName] = useState("LOYALTY");
    const [tambah, setTambah] = useState<Tambah | null>(null);
    const [ubah, setUbah] = useState<{ id: number; periodStart: string; periodEnd: string } | null>(null);
    const [periodeSemua, setPeriodeSemua] = useState<{ periodStart: string; periodEnd: string } | null>(null);
    const [keluarkan, setKeluarkan] = useState<Member | null>(null);
    const [paksa, setPaksa] = useState<{ nama: string; surat: string; pesan: string } | null>(null);
    const [laporan, setLaporan] = useState<Laporan | null>(null);
    const [sibuk, setSibuk] = useState(false);

    const query = new URLSearchParams(Object.entries({ list, q: q.trim() }).filter(([, v]) => v)).toString();
    const [data, muat] = useLoad(useCallback(() => ambil<Payload>(`/api/promo-outlet?${query}`, (j) => {
        const d = j as Payload & { ok?: boolean; error?: string };
        if (d.ok === false) throw new Error(d.error ?? "Gagal memuat daftar outlet");
        return d;
    }), [query]), { pertahankan: true });
    const lists = useMemo(() => data.data?.lists ?? [], [data]);
    const programs = useMemo(() => data.data?.programs ?? [], [data]);
    const members = data.data?.members ?? [];
    const distCode = distCodeKetik ?? data.data?.distCode ?? "";
    const infoList = lists.find((e) => e.name === list);

    /** Galat jaringan menjadi jawaban galat biasa, supaya selalu tampil sebagai pesan (bukan penolakan promise yang sunyi). */
    async function kirim(init: RequestInit, url = "/api/promo-outlet"): Promise<{ ok: boolean; body: Record<string, unknown> & { ok?: boolean; error?: string } }> {
        try {
            const res = await fetch(url, init);
            const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
            return { ok: res.ok && body.ok === true, body: res.ok || body.error ? body : { ...body, error: `HTTP ${res.status}` } };
        } catch (e) {
            return { ok: false, body: { error: `Server tidak terhubung: ${e instanceof Error ? e.message : String(e)}` } };
        }
    }

    /** Tunjuk aturan surat ke daftar; bila sudah tertunjuk daftar lain, server minta paksa → dialog. */
    async function tunjuk(nama: string, surat: string, denganPaksa = false) {
        const daftar = nama.trim().toUpperCase();
        if (!daftar || !surat) return;
        setSibuk(true);
        try {
            const r = await kirim({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aksi: "tunjuk", listName: daftar, suratProgram: surat, paksa: denganPaksa }) });
            if (!r.ok) {
                if (r.body.perluPaksa && !denganPaksa) { setPaksa({ nama: daftar, surat, pesan: String(r.body.error ?? "") }); return; }
                if (denganPaksa) throw new Error(String(r.body.error ?? "Gagal menunjuk aturan ke daftar ini"));
                setLaporan({ tone: "neg", judul: String(r.body.error ?? "Gagal menunjuk aturan ke daftar ini"), rincian: [] });
                return;
            }
            const sebelumnya = (r.body.sebelumnya as string[] | undefined) ?? [];
            setPaksa(null);
            setLaporan({ tone: "pos", judul: `${r.body.aturanDitunjuk} aturan surat ${surat} kini menunjuk daftar ${daftar}${sebelumnya.length ? ` (sebelumnya ${sebelumnya.join(", ")})` : ""}.`, rincian: [] });
            muat();
        } finally {
            setSibuk(false);
        }
    }

    async function simpanTambah() {
        if (!tambah) return;
        setSibuk(true);
        try {
            const r = await kirim({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tambah) });
            if (!r.ok) { setLaporan({ tone: "neg", judul: String(r.body.error ?? "Gagal menyimpan"), rincian: [] }); return; }
            const ditolak = (r.body.ditolak as string[] | undefined) ?? [];
            setLaporan({ tone: ditolak.length ? "warn" : "pos", judul: `${r.body.ditambah} outlet masuk daftar ${r.body.listName} (dari ${r.body.diminta} kode${Number(r.body.kembar) > 0 ? `, ${r.body.kembar} kembar digabung` : ""}).`, rincian: ditolak });
            setTambah(null);
            muat();
        } finally {
            setSibuk(false);
        }
    }

    async function unggah(file: File) {
        setSibuk(true);
        try {
            const form = new FormData();
            form.append("file", file); form.append("distCode", distCode); form.append("listName", listName);
            const r = await kirim({ method: "POST", body: form });
            if (!r.ok) { setLaporan({ tone: "neg", judul: String(r.body.error ?? "Gagal membaca berkas"), rincian: [] }); return; }
            const b = r.body as Record<string, unknown>;
            const kembar = Number(b.kembar) > 0 ? `, ${b.kembar} kembar digabung` : "";
            const lewat = Number(b.ocrPages) > 0 ? ` (dibaca ${b.sumberTeks}, ${b.ocrPages} halaman)` : "";
            const ditolak = (b.ditolak as string[] | undefined) ?? [];
            setLaporan({
                tone: ditolak.length ? "warn" : "pos",
                judul: b.sumber === "surat" ? `Surat ${b.listName}: ${b.ditambah} outlet peserta dimuat${kembar}, ${b.aturanDitunjuk} aturan surat ini ditunjuk ke daftarnya${lewat}.` : `${b.ditambah} outlet masuk daftar ${b.listName}${kembar}.`,
                rincian: [...ditolak, ...((b.catatan as string[] | undefined) ?? [])],
            });
            muat();
        } finally {
            setSibuk(false);
        }
    }

    async function simpanPeriode(member: Member) {
        if (!ubah) return;
        if (!ubah.periodStart || !ubah.periodEnd || ubah.periodStart > ubah.periodEnd) { setLaporan({ tone: "neg", judul: "Isi tanggal mulai dan sampai; tanggal sampai tidak boleh sebelum tanggal mulai.", rincian: [] }); return; }
        setSibuk(true);
        try {
            const r = await kirim({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aksi: "periode", ids: [member.id], periodStart: ubah.periodStart, periodEnd: ubah.periodEnd }) });
            if (!r.ok) { setLaporan({ tone: "neg", judul: String(r.body.error ?? "Gagal mengubah periode"), rincian: [] }); return; }
            setLaporan({ tone: "pos", judul: `Periode ${member.customerCode} kini ${tgl(ubah.periodStart)} s/d ${tgl(ubah.periodEnd)}.`, rincian: [] });
            setUbah(null); muat();
        } finally {
            setSibuk(false);
        }
    }

    async function simpanPeriodeSemua() {
        if (!periodeSemua || !list) return;
        const r = await kirim({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aksi: "periode", listName: list, periodStart: periodeSemua.periodStart, periodEnd: periodeSemua.periodEnd }) });
        if (!r.ok) throw new Error(String(r.body.error ?? "Gagal mengubah periode"));
        setLaporan({ tone: "pos", judul: `${r.body.diubah} anggota ${list} kini ${tgl(periodeSemua.periodStart)} s/d ${tgl(periodeSemua.periodEnd)}.`, rincian: [] });
        setPeriodeSemua(null); muat();
    }

    async function hapus(member: Member) {
        const r = await kirim({ method: "DELETE" }, `/api/promo-outlet?ids=${member.id}`);
        if (!r.ok) throw new Error(String(r.body.error ?? "Gagal mengeluarkan"));
        setLaporan({ tone: "pos", judul: `${r.body.deleted} outlet dikeluarkan dari ${member.listName}.`, rincian: [] });
        setKeluarkan(null); muat();
    }

    const kolom: Column<Member>[] = [
        { key: "daftar", header: "Daftar", secondary: true, cell: (m) => <span className="fi-small">{m.listName}</span> },
        { key: "outlet", header: "Outlet", cell: (m) => <>{m.customerName}<span className="fi-codes">{m.customerCode}</span>{!m.active && <> <StatusBadge tone="neu">Nonaktif</StatusBadge></>}</> },
        { key: "ket", header: "Keterangan", secondary: true, cell: (m) => m.tier || "—" },
        { key: "kode", header: "Kode principal", secondary: true, cell: (m) => m.sourceCode ? <span className="fi-mono fi-small">{m.sourceCode}</span> : <span className="fi-small fi-subtle">diketik langsung</span> },
        { key: "ikut", header: "Ikut", cell: (m) => ubah?.id === m.id ? (
            <span className="fi-page-bar">
                <input className="fi-input" type="date" aria-label="Ikut mulai" value={ubah.periodStart} onChange={(e) => setUbah({ ...ubah, periodStart: e.target.value })} />
                <input className="fi-input" type="date" aria-label="Ikut sampai" value={ubah.periodEnd} onChange={(e) => setUbah({ ...ubah, periodEnd: e.target.value })} />
                <Button variant="primary" busy={sibuk} onClick={() => void simpanPeriode(m)}>Simpan</Button>
                <Button variant="tertiary" onClick={() => setUbah(null)}>Batal</Button>
            </span>
        ) : <span className="fi-tnum fi-small">{tgl(m.periodStart) || "kapan pun"} – {tgl(m.periodEnd) || "dikeluarkan"}</span> },
        { key: "aksi", header: bolehUbah ? "Tindakan" : "", cell: (m) => bolehUbah ? <span className="fi-btnrow">
            <Button variant="icon" aria-label={`Ubah periode ${m.customerCode}`} onClick={() => setUbah({ id: m.id, periodStart: m.periodStart ?? "", periodEnd: m.periodEnd ?? "" })}><CalendarRange className="fi-icon" aria-hidden /></Button>
            <Button variant="icon" aria-label={`Keluarkan ${m.customerCode}`} onClick={() => setKeluarkan(m)}><Trash2 className="fi-icon" aria-hidden /></Button>
        </span> : null },
    ];

    return (
        <div style={{ display: "grid", gap: 16 }}>
            {laporan && (
                <MessageStrip tone={laporan.tone} title={laporan.judul} onClose={() => setLaporan(null)}>
                    {laporan.rincian.length ? <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>{laporan.rincian.slice(0, 20).map((x) => <li key={x}>{x}</li>)}</ul> : null}
                </MessageStrip>
            )}
            <Section title="Daftar outlet peserta" subtitle="dipakai gerbang untuk “khusus peserta” dan “semua kecuali peserta”; satu daftar bisa dipakai beberapa surat"
                actions={<>
                    <a className="fi-btn fi-btn--tertiary" href="/api/promo-outlet?template=1"><Download className="fi-icon" aria-hidden />Template daftar</a>
                    <a className="fi-btn fi-btn--tertiary" href="/api/promo-recap?template=1"><Download className="fi-icon" aria-hidden />Template aturan &amp; tarif MT</a>
                    {bolehUbah && <label className={`fi-btn fi-btn--secondary${sibuk ? " fi-busy" : ""}`}><FileUp className="fi-icon" aria-hidden />Unggah surat / berkas<input type="file" accept=".pdf,.xlsx,.xls,.csv" disabled={sibuk} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void unggah(f); }} /></label>}
                    {bolehUbah && <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setTambah({ listName: list || lists[0]?.name || "LOYALTY", codes: "", tier: "", periodStart: "", periodEnd: "", note: "" })}>Ketik manual</Button>}
                </>}>
                <div className="fi-sect-in">
                    <p className="fi-small fi-muted">Daftar yang tercetak di surat: unggah suratnya — sistem mengambil baris milik kode distributor kita dan langsung menunjuk semua aturan surat itu ke daftarnya. Template + berkas terpisah hanya untuk daftar yang tidak tercetak di surat (mis. peserta loyalty kuartalan). Surat hasil scan dibaca OCR berbayar per halaman, hanya bila lapisan teksnya tidak menjawab.</p>
                    {bolehUbah && (
                        <div className="fi-formgrid">
                            <FormField label="Kode distributor kita" help="Tujuh angka di kolom KODE DIST lampiran surat.">{(a11y) => <input {...a11y} className="fi-input" placeholder="1201671" value={distCode} onChange={(e) => setDistCode(e.target.value)} />}</FormField>
                            <PilihDaftar id="daftar-unggah" label="Nama daftar (berkas terpisah)" help="Surat memakai nomornya sendiri sebagai nama daftar." value={listName} onChange={setListName} lists={lists} programs={programs} onTunjuk={(s) => void tunjuk(listName, s)} />
                        </div>
                    )}
                </div>
            </Section>

            {tambah && (
                <Section title="Ketik anggota manual" actions={<><Button variant="tertiary" onClick={() => setTambah(null)}>Batal</Button><Button variant="primary" busy={sibuk} disabled={!tambah.codes.trim() || !tambah.listName.trim()} disabledReason="Isi nama daftar dan kode outlet" onClick={() => void simpanTambah()}>Simpan</Button></>}>
                    <div className="fi-sect-in">
                        <div className="fi-formgrid">
                            <PilihDaftar id="daftar-ketik" label="Nama daftar / promo" value={tambah.listName} onChange={(v) => setTambah({ ...tambah, listName: v })} lists={lists} programs={programs} onTunjuk={(s) => void tunjuk(tambah.listName, s)} />
                            <FormField label="Keterangan" help="Bebas, mis. PLATINUM; tidak dipakai memutuskan.">{(a11y) => <input {...a11y} className="fi-input" value={tambah.tier} onChange={(e) => setTambah({ ...tambah, tier: e.target.value })} />}</FormField>
                            <FormField label="Ikut mulai" help="Kosong = sejak kapan pun.">{(a11y) => <input {...a11y} className="fi-input" type="date" value={tambah.periodStart} onChange={(e) => setTambah({ ...tambah, periodStart: e.target.value })} />}</FormField>
                            <FormField label="Ikut sampai" help="Kosong = sampai dikeluarkan.">{(a11y) => <input {...a11y} className="fi-input" type="date" value={tambah.periodEnd} onChange={(e) => setTambah({ ...tambah, periodEnd: e.target.value })} />}</FormField>
                        </div>
                        <FormField label="Kode outlet" required help="Kode internal Accurate (C-WIN013) atau kode pelanggan principal (22160031402), dipisah koma, spasi, atau baris baru. Yang tidak dikenali ditolak satu per satu.">{(a11y) => <textarea {...a11y} className="fi-input" rows={4} value={tambah.codes} onChange={(e) => setTambah({ ...tambah, codes: e.target.value })} />}</FormField>
                        <FormField label="Catatan">{(a11y) => <input {...a11y} className="fi-input" value={tambah.note} onChange={(e) => setTambah({ ...tambah, note: e.target.value })} />}</FormField>
                    </div>
                </Section>
            )}

            <div className="fi-page-bar">
                <FormField label="Daftar">{(a11y) => <select {...a11y} className="fi-input" value={list} onChange={(e) => setList(e.target.value)}><option value="">Semua daftar</option>{lists.map((e) => <option key={e.name} value={e.name}>{e.name} ({e.members})</option>)}</select>}</FormField>
                <FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Kode atau nama toko" value={q} onChange={(e) => setQ(e.target.value)} />}</FormField>
                {bolehUbah && list && <Button icon={<CalendarRange className="fi-icon" aria-hidden />} onClick={() => setPeriodeSemua({ periodStart: "", periodEnd: "" })} style={{ alignSelf: "end" }}>Ubah periode semua anggota {list} ({infoList?.members ?? members.length})…</Button>}
            </div>
            {lists.length > 0 && (
                <ul className="fi-chips" aria-label="Daftar dan tali ke aturan">
                    {lists.map((e) => (
                        <li key={e.name}>
                            <button type="button" className="fi-chip" aria-pressed={list === e.name} data-tone={e.linked.length ? undefined : "warn"} onClick={() => setList(list === e.name ? "" : e.name)}
                                title={e.linked.length ? e.linked.map((l) => `${l.suratProgram}: ${modeLabel(l.mode)}, ${l.rules} aturan`).join("; ") : "Belum ada aturan promo yang menunjuk daftar ini"}>
                                {e.name} · {e.members} toko · {e.linked.length ? e.linked.map((l) => `${l.suratProgram} ${l.mode === "EXCLUDE" ? "(kecuali)" : "(hanya)"}`).join(" · ") : "belum dipakai aturan"}
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {data.status === "memuat" && !data.data ? <div className="fi-panel"><Skeleton rows={5} label="Memuat daftar outlet" /></div>
                : data.status === "galat" && !data.data ? <div className="fi-panel"><ErrorState message={data.error} onRetry={muat} /></div>
                : (
                    <ResponsiveTable<Member> title="Anggota daftar" count={members.length} columns={kolom} rows={members} rowKey={(m) => String(m.id)} status={data.status} error={data.error} onRetry={muat}
                        empty={{ title: "Belum ada outlet di daftar ini", message: "Selama daftarnya kosong, aturan yang menunjuknya tidak berlaku untuk siapa pun — disengaja: lebih baik tertahan daripada lolos tanpa dasar." }}
                        mobileItem={(m) => <ListItem doc={m.customerCode} title={m.customerName} meta={`${m.listName} · ${tgl(m.periodStart) || "kapan pun"} – ${tgl(m.periodEnd) || "dikeluarkan"}`} badge={bolehUbah ? <Button variant="tertiary" onClick={() => setKeluarkan(m)}>Keluarkan…</Button> : undefined} />} />
                )}
            {!data.data && data.status !== "memuat" && data.status !== "galat" && <EmptyState title="Belum ada daftar" />}

            <ConfirmDialog open={paksa !== null} onClose={() => setPaksa(null)} tag="Ganti daftar" title={`Ganti daftar yang ditunjuk aturan ${paksa?.surat ?? ""}?`} confirmLabel="Ganti sekarang"
                description={paksa?.pesan} onConfirm={() => tunjuk(paksa!.nama, paksa!.surat, true)}
                facts={[["Daftar baru", paksa?.nama ?? ""], ["Akibat", "Peserta program ini berganti ke anggota daftar baru"]]} />
            <ConfirmDialog open={periodeSemua !== null} onClose={() => setPeriodeSemua(null)} tag="Periode" title={`Ubah periode ${infoList?.members ?? members.length} anggota daftar ${list}?`} confirmLabel="Ubah periode"
                confirmDisabled={!periodeSemua?.periodStart || !periodeSemua?.periodEnd ? "Isi kedua tanggal" : periodeSemua.periodStart > periodeSemua.periodEnd ? "Tanggal sampai sebelum tanggal mulai" : undefined}
                onConfirm={simpanPeriodeSemua}
                facts={[["Dipakai aturan surat", infoList?.linked.length ? infoList.linked.map((l) => l.suratProgram).join(", ") : "Tidak ada"], ["Tidak berubah", "Keterangan, catatan, dan kode principal anggota"]]}>
                <div className="fi-formgrid">
                    <FormField label="Ikut mulai" required>{(a11y) => <input {...a11y} className="fi-input" type="date" value={periodeSemua?.periodStart ?? ""} onChange={(e) => setPeriodeSemua((p) => ({ periodEnd: p?.periodEnd ?? "", periodStart: e.target.value }))} />}</FormField>
                    <FormField label="Ikut sampai" required>{(a11y) => <input {...a11y} className="fi-input" type="date" value={periodeSemua?.periodEnd ?? ""} onChange={(e) => setPeriodeSemua((p) => ({ periodStart: p?.periodStart ?? "", periodEnd: e.target.value }))} />}</FormField>
                </div>
            </ConfirmDialog>
            <ConfirmDialog open={keluarkan !== null} onClose={() => setKeluarkan(null)} tag="Keluarkan" tone="negative" title={`Keluarkan ${keluarkan?.customerCode ?? ""} dari daftar ${keluarkan?.listName ?? ""}?`} confirmLabel="Keluarkan"
                onConfirm={() => hapus(keluarkan!)} facts={[["Outlet", keluarkan?.customerName ?? ""], ["Akibat", "Aturan yang menunjuk daftar ini berhenti berlaku untuk outlet ini"]]} />
        </div>
    );
}
