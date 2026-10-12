/*
 * Tujuan: Bagian hierarki dan tautan akun di halaman Pengaturan Insentif Sales (Fiori S4c, it07): SPV → SM, Sales → SPV, klaim
 *   salesman tertunda (rolling antar-SPV), akun belum ditautkan + dialog Tautkan (it07 #21), akun tertaut (ubah/cabut).
 *   Hapus hierarki dan cabut akses lewat dialog (it07 #19). Assignment additive; tautan akun mengaktifkan pembatasan
 *   "SPV/SM/sales cuma lihat timnya sendiri" per akun (lib/insentif-hierarchy-scope).
 * Caller: Pengaturan.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/rekapan-nota/ui (ambil), lib/insentif-ui (readApi).
 * Main Functions: Hierarki, AkunTautan.
 * Side Effects: GET hierarchy/sm-spv, spv-sales, spv-sales/requests, user-identity; POST/DELETE sm-spv, spv-sales;
 *   POST spv-sales/requests (setujui/tolak); POST user-identity (tautkan/cabut).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button, EmptyState, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { readApi } from "@/lib/insentif-ui";

interface SpvSalesRow { id: string; salesCode: string; spvName: string }
interface SmSpvRow { id: string; spvName: string; smName: string }
interface ClaimRequestRow { id: string; salesCode: string; requestedBySpvName: string; previousSpvName: string | null }
type Peran = "spv" | "sm" | "sales";
interface UserIdentityRow { id: string; name: string; email: string; hierarchyRole: Peran | null; hierarchyName: string | null }

const LABEL_PERAN: Record<Peran, string> = { spv: "SPV", sm: "SM", sales: "Sales" };
const TANPA_IZIN = "Butuh izin kelola hierarki";

async function tulis(url: string, method: "POST" | "DELETE", body?: unknown) {
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await readApi(res);
    if (!res.ok) throw new Error(String(data.error ?? "Gagal menyimpan."));
    return { status: res.status, data };
}

type DlgH =
    | { kind: "tambahSm" } | { kind: "hapusSm"; row: SmSpvRow }
    | { kind: "tambahSales" } | { kind: "hapusSales"; row: SpvSalesRow }
    | { kind: "klaim"; row: ClaimRequestRow; decision: "approve" | "reject" }
    | null;

export function Hierarki({ bolehHierarki }: { bolehHierarki: boolean }) {
    const [smSpv, muatSm] = useLoad(useCallback(() => ambil<SmSpvRow[]>("/api/insentif-sales/hierarchy/sm-spv", (j) => (j as { rows?: SmSpvRow[] }).rows ?? []), []));
    const [spvSales, muatSales] = useLoad(useCallback(() => ambil<SpvSalesRow[]>("/api/insentif-sales/hierarchy/spv-sales", (j) => (j as { rows?: SpvSalesRow[] }).rows ?? []), []));
    // Daftar klaim hanya untuk pemegang izin kelola hierarki (route-nya menolak yang lain).
    const [klaim, muatKlaim] = useLoad(useCallback(async (): Promise<Load<ClaimRequestRow[]>> => (bolehHierarki
        ? ambil<ClaimRequestRow[]>("/api/insentif-sales/hierarchy/spv-sales/requests", (j) => (j as { rows?: ClaimRequestRow[] }).rows ?? [])
        : { status: "siap", data: [] }), [bolehHierarki]));

    const [dialog, setDialog] = useState<DlgH>(null);
    const [isian, setIsian] = useState({ a: "", b: "" });
    const [pesan, setPesan] = useState<{ tone: "pos" | "info"; teks: string } | null>(null);
    const tutup = () => { setDialog(null); setIsian({ a: "", b: "" }); };
    const tanpaIzin = bolehHierarki ? undefined : TANPA_IZIN;

    async function tambahSm() {
        await tulis("/api/insentif-sales/hierarchy/sm-spv", "POST", { spvName: isian.a.trim(), smName: isian.b.trim() });
        setPesan({ tone: "pos", teks: `SPV ${isian.a.trim()} → SM ${isian.b.trim()} tersimpan.` }); tutup(); muatSm();
    }
    async function tambahSales() {
        const { status } = await tulis("/api/insentif-sales/hierarchy/spv-sales", "POST", { salesCode: isian.a.trim(), spvName: isian.b.trim() });
        setPesan(status === 202
            ? { tone: "info", teks: `Salesman ${isian.a.trim()} sudah ditangani SPV lain. Permintaan klaim dikirim untuk persetujuan admin.` }
            : { tone: "pos", teks: `Sales ${isian.a.trim()} → SPV ${isian.b.trim()} tersimpan.` });
        tutup(); muatSales(); muatKlaim();
    }
    async function hapus(kind: "sm-spv" | "spv-sales", id: string, teks: string) {
        await tulis(`/api/insentif-sales/hierarchy/${kind}?id=${encodeURIComponent(id)}`, "DELETE");
        setPesan({ tone: "pos", teks }); tutup();
        if (kind === "sm-spv") muatSm(); else muatSales();
    }
    async function putuskan(row: ClaimRequestRow, decision: "approve" | "reject") {
        await tulis("/api/insentif-sales/hierarchy/spv-sales/requests", "POST", { requestId: row.id, decision });
        setPesan({ tone: "pos", teks: decision === "approve" ? `Klaim ${row.salesCode} disetujui.` : `Klaim ${row.salesCode} ditolak.` });
        tutup(); muatKlaim(); muatSales();
    }

    const tombolHapus = (onClick: () => void) => <Button variant="tertiary" disabled={Boolean(tanpaIzin)} disabledReason={tanpaIzin} onClick={onClick}>Hapus…</Button>;
    const kolomSm: Column<SmSpvRow>[] = [
        { key: "spv", header: "SPV", cell: (r) => <b>{r.spvName}</b> },
        { key: "sm", header: "SM", cell: (r) => r.smName },
        { key: "aksi", header: "Tindakan", cell: (r) => tombolHapus(() => setDialog({ kind: "hapusSm", row: r })) },
    ];
    const kolomSales: Column<SpvSalesRow>[] = [
        { key: "kode", header: "Kode sales", cell: (r) => <span className="fi-mono">{r.salesCode}</span> },
        { key: "spv", header: "SPV", cell: (r) => r.spvName },
        { key: "aksi", header: "Tindakan", cell: (r) => tombolHapus(() => setDialog({ kind: "hapusSales", row: r })) },
    ];
    const tombolKlaim = (r: ClaimRequestRow) => (
        <div className="fi-btnrow">
            <Button onClick={() => setDialog({ kind: "klaim", row: r, decision: "approve" })}>Setujui…</Button>
            <Button variant="tertiary" onClick={() => setDialog({ kind: "klaim", row: r, decision: "reject" })}>Tolak…</Button>
        </div>
    );
    const kolomKlaim: Column<ClaimRequestRow>[] = [
        { key: "kode", header: "Salesman", cell: (r) => <span className="fi-mono">{r.salesCode}</span> },
        { key: "lama", header: "SPV sekarang", cell: (r) => r.previousSpvName ?? "—" },
        { key: "baru", header: "Diminta oleh", cell: (r) => <b>{r.requestedBySpvName}</b> },
        { key: "aksi", header: "Keputusan", cell: tombolKlaim },
    ];

    const d = dialog;
    return (
        <>
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
            <Section id="hierarki" title="Hierarki SPV → SM" subtitle="dipakai untuk pengelompokan insentif SPV dan SM"
                actions={<Button icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(tanpaIzin)} disabledReason={tanpaIzin} onClick={() => setDialog({ kind: "tambahSm" })}>Tambah SPV → SM…</Button>}>
                <ResponsiveTable<SmSpvRow> title="Hierarki SPV → SM" count={smSpv.data?.length} columns={kolomSm} rows={smSpv.data ?? []} rowKey={(r) => r.id}
                    status={smSpv.status} error={smSpv.error ? `Hierarki SPV → SM belum berhasil dimuat (${smSpv.error}).` : undefined} onRetry={muatSm}
                    empty={{ title: "Belum ada SPV yang ditempatkan di bawah SM" }}
                    mobileItem={(r) => <ListItem doc={r.spvName} title={`SM ${r.smName}`} badge={tombolHapus(() => setDialog({ kind: "hapusSm", row: r }))} />} />
            </Section>
            <Section id="hierarki-sales" title="Hierarki Sales → SPV" subtitle="pembatasan akses hanya berlaku untuk akun yang ditautkan"
                actions={<Button icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(tanpaIzin)} disabledReason={tanpaIzin} onClick={() => setDialog({ kind: "tambahSales" })}>Tambah Sales → SPV…</Button>}>
                <ResponsiveTable<SpvSalesRow> title="Hierarki Sales → SPV" count={spvSales.data?.length} columns={kolomSales} rows={spvSales.data ?? []} rowKey={(r) => r.id}
                    status={spvSales.status} error={spvSales.error ? `Hierarki Sales → SPV belum berhasil dimuat (${spvSales.error}).` : undefined} onRetry={muatSales}
                    empty={{ title: "Belum ada salesman yang ditempatkan di bawah SPV" }}
                    mobileItem={(r) => <ListItem doc={r.salesCode} title={`SPV ${r.spvName}`} badge={tombolHapus(() => setDialog({ kind: "hapusSales", row: r }))} />} />
            </Section>
            <Section id="klaim-tertunda" title="Klaim salesman tertunda" subtitle="SPV meminta salesman yang sedang dipegang SPV lain">
                {!bolehHierarki ? (
                    <div className="fi-sect-in"><p className="fi-small fi-subtle">Hanya pemegang izin kelola hierarki yang melihat dan memutuskan klaim.</p></div>
                ) : (
                    <ResponsiveTable<ClaimRequestRow> title="Klaim salesman tertunda" count={klaim.data?.length} columns={kolomKlaim} rows={klaim.data ?? []} rowKey={(r) => r.id}
                        status={klaim.status} error={klaim.error ? `Klaim belum berhasil dimuat (${klaim.error}).` : undefined} onRetry={muatKlaim}
                        empty={{ title: "Tidak ada klaim tertunda" }}
                        mobileItem={(r) => <ListItem doc={r.salesCode} title={`${r.previousSpvName ?? "—"} → ${r.requestedBySpvName}`} meta={tombolKlaim(r)} />} />
                )}
            </Section>

            <ConfirmDialog open={d?.kind === "tambahSm"} onClose={tutup} tag="Hierarki" title="Tambah SPV di bawah SM?" confirmLabel="Simpan"
                confirmDisabled={isian.a.trim() && isian.b.trim() ? undefined : "Isi nama SPV dan SM dulu"} onConfirm={tambahSm}
                facts={[["Akibat", "Bila SPV ini sudah punya SM, SM-nya diganti"]]}>
                <FormField label="Nama SPV" required>{(a) => <input {...a} className="fi-input" value={isian.a} onChange={(e) => setIsian((s) => ({ ...s, a: e.target.value }))} />}</FormField>
                <FormField label="Nama SM" required>{(a) => <input {...a} className="fi-input" value={isian.b} onChange={(e) => setIsian((s) => ({ ...s, b: e.target.value }))} />}</FormField>
            </ConfirmDialog>
            <ConfirmDialog open={d?.kind === "tambahSales"} onClose={tutup} tag="Hierarki" title="Tempatkan salesman di bawah SPV?" confirmLabel="Simpan"
                confirmDisabled={isian.a.trim() && isian.b.trim() ? undefined : "Isi kode sales dan nama SPV dulu"} onConfirm={tambahSales}
                facts={[["Akibat", "Bila salesman ini sudah punya SPV, SPV-nya diganti"]]}>
                <FormField label="Kode sales" required>{(a) => <input {...a} className="fi-input" value={isian.a} onChange={(e) => setIsian((s) => ({ ...s, a: e.target.value }))} />}</FormField>
                <FormField label="Nama SPV" required>{(a) => <input {...a} className="fi-input" value={isian.b} onChange={(e) => setIsian((s) => ({ ...s, b: e.target.value }))} />}</FormField>
            </ConfirmDialog>
            <ConfirmDialog open={d?.kind === "hapusSm"} onClose={tutup} tone="negative" tag="Hapus" confirmLabel="Hapus"
                title={d?.kind === "hapusSm" ? `Hapus SPV ${d.row.spvName} dari SM ${d.row.smName}?` : ""}
                onConfirm={() => (d?.kind === "hapusSm" ? hapus("sm-spv", d.row.id, `SPV ${d.row.spvName} dilepas dari SM ${d.row.smName}.`) : undefined)}
                facts={[["Akibat", "SPV ini tidak lagi dikelompokkan di bawah SM tersebut pada perhitungan berikutnya"]]} />
            <ConfirmDialog open={d?.kind === "hapusSales"} onClose={tutup} tone="negative" tag="Hapus" confirmLabel="Hapus"
                title={d?.kind === "hapusSales" ? `Hapus ${d.row.salesCode} dari SPV ${d.row.spvName}?` : ""}
                onConfirm={() => (d?.kind === "hapusSales" ? hapus("spv-sales", d.row.id, `${d.row.salesCode} dilepas dari SPV ${d.row.spvName}.`) : undefined)}
                facts={[["Akibat", "Salesman ini tidak lagi masuk tim SPV tersebut untuk pembatasan akses dan pengelompokan"]]} />
            <ConfirmDialog open={d?.kind === "klaim"} onClose={tutup} tone={d?.kind === "klaim" && d.decision === "reject" ? "negative" : "primary"} tag="Klaim"
                title={d?.kind === "klaim" ? `${d.decision === "approve" ? "Setujui" : "Tolak"} klaim ${d.row.requestedBySpvName} atas ${d.row.salesCode}?` : ""}
                confirmLabel={d?.kind === "klaim" && d.decision === "reject" ? "Tolak klaim" : "Setujui klaim"}
                onConfirm={() => (d?.kind === "klaim" ? putuskan(d.row, d.decision) : undefined)}
                facts={d?.kind === "klaim" ? [
                    ["SPV sekarang", d.row.previousSpvName ?? "—"],
                    ["Diminta oleh", d.row.requestedBySpvName],
                    ["Akibat", d.decision === "approve" ? `${d.row.salesCode} pindah ke tim ${d.row.requestedBySpvName}` : `${d.row.salesCode} tetap di tim ${d.row.previousSpvName ?? "sekarang"}`],
                ] : []} />
        </>
    );
}

type DlgA = { kind: "tautkan"; user: UserIdentityRow } | { kind: "cabut"; user: UserIdentityRow } | null;

export function AkunTautan({ bolehHierarki }: { bolehHierarki: boolean }) {
    // Daftar akun hanya untuk pemegang izin kelola hierarki (route user-identity menolak yang lain).
    const [users, muat] = useLoad(useCallback(async (): Promise<Load<UserIdentityRow[]>> => (bolehHierarki
        ? ambil<UserIdentityRow[]>("/api/insentif-sales/hierarchy/user-identity", (j) => (j as { users?: UserIdentityRow[] }).users ?? [])
        : { status: "siap", data: [] }), [bolehHierarki]));
    const [cari, setCari] = useState("");
    const [dialog, setDialog] = useState<DlgA>(null);
    const [peran, setPeran] = useState<Peran>("sales");
    const [nama, setNama] = useState("");
    const [pesan, setPesan] = useState<string | null>(null);

    const q = cari.trim().toLowerCase();
    const cocok = (u: UserIdentityRow) => !q || `${u.name} ${u.email} ${u.hierarchyName ?? ""}`.toLowerCase().includes(q);
    const belum = useMemo(() => (users.data ?? []).filter((u) => !u.hierarchyRole), [users.data]);
    const tertaut = useMemo(() => (users.data ?? []).filter((u) => u.hierarchyRole), [users.data]);

    const bukaTautkan = (u: UserIdentityRow) => { setPeran(u.hierarchyRole ?? "sales"); setNama(u.hierarchyName ?? ""); setDialog({ kind: "tautkan", user: u }); };

    async function tautkan(u: UserIdentityRow) {
        await tulis("/api/insentif-sales/hierarchy/user-identity", "POST", { userId: u.id, hierarchyRole: peran, hierarchyName: nama.trim() });
        setPesan(`${u.name} ditautkan ke ${LABEL_PERAN[peran]} ${nama.trim()}. Pembatasan akses aktif untuk akun ini.`);
        setDialog(null); muat();
    }
    async function cabut(u: UserIdentityRow) {
        await tulis("/api/insentif-sales/hierarchy/user-identity", "POST", { userId: u.id, hierarchyRole: null, hierarchyName: null });
        setPesan(`Tautan ${u.name} dicabut. Akun ini kembali melihat semua data.`);
        setDialog(null); muat();
    }

    const kolomBelum: Column<UserIdentityRow>[] = [
        { key: "nama", header: "Akun", cell: (u) => <b>{u.name}</b> },
        { key: "email", header: "Email", secondary: true, cell: (u) => u.email },
        { key: "aksi", header: "Tindakan", cell: (u) => <Button onClick={() => bukaTautkan(u)}>Tautkan…</Button> },
    ];
    const kolomTertaut: Column<UserIdentityRow>[] = [
        { key: "nama", header: "Akun", cell: (u) => <b>{u.name}</b> },
        { key: "email", header: "Email", secondary: true, cell: (u) => u.email },
        { key: "peran", header: "Peran", cell: (u) => <StatusBadge tone="info">{LABEL_PERAN[u.hierarchyRole as Peran] ?? u.hierarchyRole}</StatusBadge> },
        { key: "identitas", header: "Identitas", cell: (u) => <span className={u.hierarchyRole === "sales" ? "fi-mono" : undefined}>{u.hierarchyName}</span> },
        { key: "aksi", header: "Tindakan", cell: (u) => <div className="fi-btnrow"><Button variant="tertiary" onClick={() => bukaTautkan(u)}>Ubah…</Button><Button variant="tertiary" onClick={() => setDialog({ kind: "cabut", user: u })}>Cabut…</Button></div> },
    ];
    const kosongCari = { title: "Tidak ada akun yang cocok dengan pencarian", message: "Ubah atau hapus kata pencarian." };

    if (!bolehHierarki) {
        return (
            <Section id="akun" title="Akun belum ditautkan" subtitle="tautan akun ke identitas Sales, SPV, atau SM">
                <EmptyState title="Butuh izin kelola hierarki" message="Daftar akun dan tautannya hanya terlihat oleh pemegang izin kelola hierarki insentif." />
            </Section>
        );
    }
    const d = dialog;
    return (
        <>
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            <Section id="akun" title="Akun belum ditautkan" subtitle="tanpa tautan, akun melihat seluruh data insentif (perilaku hari ini)">
                <div className="fi-sect-in">
                    <FormField label="Cari akun">{(a) => <input {...a} className="fi-input" type="search" value={cari} placeholder="Nama, email, atau identitas" onChange={(e) => setCari(e.target.value)} />}</FormField>
                    <VariantNote bl="BL-26">
                        Hari ini akun tanpa tautan melihat seluruh data insentif, dan daftar ini memuat semua akun aplikasi (termasuk yang tidak memakai
                        insentif). Usulan BL-26 + D-17: akun tanpa tautan tidak melihat data apa pun, dan daftar hanya memuat akun berizin insentif.
                    </VariantNote>
                </div>
                <ResponsiveTable<UserIdentityRow> title="Akun belum ditautkan" count={users.data ? belum.length : undefined} columns={kolomBelum} rows={belum.filter(cocok)} rowKey={(u) => u.id}
                    status={users.status} error={users.error ? `Daftar akun belum berhasil dimuat (${users.error}).` : undefined} onRetry={muat}
                    empty={q && belum.length ? kosongCari : { title: "Semua akun sudah ditautkan", message: "Setiap akun sudah punya identitas Sales, SPV, atau SM." }}
                    mobileItem={(u) => <ListItem doc={u.name} title={u.email} badge={<Button onClick={() => bukaTautkan(u)}>Tautkan…</Button>} />} />
            </Section>
            <Section id="akun-tertaut" title="Akun tertaut" subtitle="hanya melihat data tim atau dirinya sendiri">
                <ResponsiveTable<UserIdentityRow> title="Akun tertaut" count={users.data ? tertaut.length : undefined} columns={kolomTertaut} rows={tertaut.filter(cocok)} rowKey={(u) => u.id}
                    status={users.status} error={users.error ? `Daftar akun belum berhasil dimuat (${users.error}).` : undefined} onRetry={muat}
                    empty={q && tertaut.length ? kosongCari : { title: "Belum ada akun yang ditautkan", message: "Secara bawaan semua akun melihat semua data." }}
                    mobileItem={(u) => <ListItem doc={u.name} title={`${LABEL_PERAN[u.hierarchyRole as Peran] ?? u.hierarchyRole} · ${u.hierarchyName}`} meta={u.email}
                        badge={<Button variant="tertiary" onClick={() => setDialog({ kind: "cabut", user: u })}>Cabut…</Button>} />} />
            </Section>

            <ConfirmDialog open={d?.kind === "tautkan"} onClose={() => setDialog(null)} tag="BL-26" confirmLabel="Tautkan"
                title={d?.kind === "tautkan" ? `Tautkan akun ${d.user.name}?` : ""}
                confirmDisabled={nama.trim() ? undefined : "Isi identitas dulu"}
                onConfirm={() => (d?.kind === "tautkan" ? tautkan(d.user) : undefined)}
                facts={d?.kind === "tautkan" ? [
                    ["Akun", `${d.user.name} · ${d.user.email}`],
                    ...(d.user.hierarchyRole ? [["Tautan sekarang", `${LABEL_PERAN[d.user.hierarchyRole]} ${d.user.hierarchyName ?? ""}`] as [string, string]] : []),
                    ["Akibat", "Akun ini hanya melihat data identitas tersebut di Dashboard dan Insentif saya"],
                ] : []}>
                <FormField label="Peran" required>{(a) => (
                    <select {...a} className="fi-input" value={peran} onChange={(e) => setPeran(e.target.value as Peran)}>
                        <option value="sales">Sales</option><option value="spv">SPV</option><option value="sm">SM</option>
                    </select>
                )}</FormField>
                <FormField label="Identitas" required help={peran === "sales" ? "Kode sales persis seperti di target, mis. M-FS." : `Nama ${LABEL_PERAN[peran]} persis seperti di target.`}>
                    {(a) => <input {...a} className="fi-input" value={nama} onChange={(e) => setNama(e.target.value)} />}
                </FormField>
            </ConfirmDialog>
            <ConfirmDialog open={d?.kind === "cabut"} onClose={() => setDialog(null)} tone="negative" tag="Akses" confirmLabel="Cabut tautan"
                title={d?.kind === "cabut" ? `Cabut tautan ${d.user.name}?` : ""}
                onConfirm={() => (d?.kind === "cabut" ? cabut(d.user) : undefined)}
                facts={d?.kind === "cabut" ? [
                    ["Tautan sekarang", `${LABEL_PERAN[d.user.hierarchyRole as Peran] ?? d.user.hierarchyRole} ${d.user.hierarchyName ?? ""}`],
                    ["Akibat", "Akun kembali melihat seluruh data insentif (perilaku hari ini, BL-26)"],
                ] : []} />
        </>
    );
}
