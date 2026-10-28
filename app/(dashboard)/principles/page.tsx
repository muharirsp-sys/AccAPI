/*
 * Tujuan: Master Principal (Fiori): unggah Excel master rujukan per principal dan kelola daftar master aktif. Hapus lewat dialog konfirmasi.
 * Caller: Route dashboard `/principles`.
 * Dependensi: FastAPI `/api/principles` (GET daftar, POST add, POST {id}/delete) lewat lib/apiBase, komponen Fiori, lib/tampil.
 * Main Functions: `PrincipleManagementPage`, `fetchPrinciples`, `handleUpload`, `handleDelete` (dipanggil ConfirmDialog).
 * Side Effects: HTTP baca/tulis ke FastAPI, unggah berkas Excel, hapus master (tidak bisa dibatalkan).
 */
"use client";

import { useEffect, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";
import { tanggalWita, sebabHttp } from "@/lib/tampil";

interface Principle {
    name: string;
    filename: string;
    uploaded_by: string;
    created_at: string;
}
type Baris = Principle & { id: string };

const API_BASE = resolveApiBase();
/** Jaringan putus (fetch melempar) dan penolakan server dibedakan; sebabnya ikut dibawa supaya orang yang tepat yang membetulkan. */
async function minta(url: string, init?: RequestInit) {
    const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
    return fetch(fetchUrl, { credentials: "include", ...init }).catch(() => { throw new Error(sebabHttp(0)); });
}
const api = {
    get: async (url: string) => {
        const res = await minta(url);
        if (!res.ok) throw new Error(sebabHttp(res.status));
        return { data: await res.json(), status: res.status, ok: res.ok };
    },
    post: async (url: string, data?: unknown) => {
        const isFormData = data instanceof FormData;
        const res = await minta(url, {
            method: "POST",
            body: isFormData ? data : JSON.stringify(data),
            headers: isFormData ? {} : { "Content-Type": "application/json" }
        });
        // Sebab yang SEBENARNYA ikut dibawa: server menolak dan kabel putus butuh orang berbeda untuk membetulkannya.
        if (!res.ok) {
            const teks = await res.text().catch(() => "");
            let sebab = teks.slice(0, 300);
            try { sebab = String(JSON.parse(teks).error ?? sebab); } catch { /* bukan JSON */ }
            throw new Error(`${sebabHttp(res.status)}${sebab ? ` ${sebab}` : ""}`);
        }
        return { data: await res.json(), status: res.status, ok: res.ok };
    }
};

export default function PrincipleManagementPage() {
    const [loading, setLoading] = useState(true);
    const [principles, setPrinciples] = useState<Record<string, Principle>>({});
    const [galatMuat, setGalatMuat] = useState<string | null>(null);

    // Upload Form States
    const [isUploading, setIsUploading] = useState(false);
    const [newPrincipleName, setNewPrincipleName] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [inputKe, setInputKe] = useState(0);
    const [galatForm, setGalatForm] = useState<string | null>(null);
    const [pesan, setPesan] = useState<{ tone: "pos" | "neg"; teks: string } | null>(null);
    const [hapus, setHapus] = useState<Baris | null>(null);

    useEffect(() => {
        fetchPrinciples();
    }, []);

    const fetchPrinciples = async () => {
        setLoading(true);
        try {
            const res = await api.get("/api/principles");
            if (res.data.ok) { setPrinciples(res.data.principles); setGalatMuat(null); }
            else setGalatMuat(String(res.data.error || "Server tidak mengirim daftar master."));
        } catch (e) {
            setGalatMuat(e instanceof Error ? e.message : sebabHttp(0));
        } finally {
            setLoading(false);
        }
    };

    const handleUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        setGalatForm(null); setPesan(null);
        if (!file || !newPrincipleName) { setGalatForm("Isi nama principal dan pilih berkas Excel master dulu."); return; }

        setIsUploading(true);
        const fd = new FormData();
        fd.append("name", newPrincipleName);
        fd.append("file", file);

        try {
            const res = await api.post("/api/principles/add", fd);
            if (res.data.ok) {
                setNewPrincipleName("");
                setFile(null);
                setInputKe((k) => k + 1);
                setPesan({ tone: "pos", teks: "Master berhasil diunggah." });
                fetchPrinciples();
            } else setPesan({ tone: "neg", teks: `Master belum terunggah. ${res.data.error ?? ""}`.trim() });
        } catch (e) { setPesan({ tone: "neg", teks: `Master belum terunggah. ${e instanceof Error ? e.message : sebabHttp(0)}` }); }
        finally { setIsUploading(false); }
    };

    const handleDelete = async (pid: string) => {
        const res = await api.post(`/api/principles/${pid}/delete`);
        if (!res.data.ok) throw new Error(String(res.data.error || "Server menolak penghapusan."));
        setHapus(null);
        setPesan({ tone: "pos", teks: "Master principal dihapus." });
        fetchPrinciples();
    };

    const baris: Baris[] = Object.entries(principles).map(([id, p]) => ({ id, ...p }));
    const tombolHapus = (p: Baris) => (
        <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} aria-label={`Hapus master ${p.name}`} onClick={() => setHapus(p)}>Hapus…</Button>
    );
    const kolom: Column<Baris>[] = [
        { key: "nama", header: "Principal", cell: (p) => p.name },
        { key: "berkas", header: "Berkas master", cell: (p) => <span className="fi-mono">{p.filename}</span> },
        { key: "oleh", header: "Diunggah oleh", secondary: true, cell: (p) => p.uploaded_by || "Sistem" },
        { key: "tanggal", header: "Tanggal", secondary: true, cell: (p) => <span className="fi-tnum">{tanggalWita(p.created_at)}</span> },
        { key: "aksi", header: "Tindakan", cell: tombolHapus },
    ];
    const status = loading ? "memuat" : galatMuat ? "galat" : "siap";

    return (
        <FioriScope>
            <div className="fi-page">
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">Master Principal</span></li></ol></nav>
                    <h1>Master Principal</h1>
                    <p>Unggah dan kelola master Excel rujukan per principal. Summary Promo memakainya untuk membaca surat dan menyusun kode barang.</p>
                </header>

                {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}

                <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                    <Section title="Tambah master baru" subtitle="satu berkas Excel per principal">
                        <form className="fi-sect-in" onSubmit={handleUpload}>
                            {galatForm && <MessageStrip tone="neg" title={galatForm} />}
                            <FormField label="Nama principal" required>
                                {(a11y) => <input {...a11y} className="fi-input" type="text" required value={newPrincipleName} placeholder="mis. PRINCIPLE A" onChange={(e) => setNewPrincipleName(e.target.value)} />}
                            </FormField>
                            <FormField label="Berkas Excel master" required help="Format .xlsx atau .xls.">
                                {(a11y) => <input {...a11y} key={inputKe} className="fi-input" type="file" required accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] || null)} />}
                            </FormField>
                            <div className="fi-btnrow">
                                <Button type="submit" variant="primary" icon={<Upload className="fi-icon" aria-hidden />} busy={isUploading}>Simpan master</Button>
                            </div>
                        </form>
                    </Section>

                    <Section title="Master principal aktif" subtitle={status === "siap" ? `${baris.length} master` : undefined}>
                        <ResponsiveTable<Baris> title="Master principal aktif" columns={kolom} rows={baris} rowKey={(p) => p.id} status={status} error={galatMuat ?? undefined} onRetry={fetchPrinciples}
                            empty={{ title: "Belum ada master principal", message: "Unggah berkas Excel master pertama lewat formulir di samping." }}
                            mobileItem={(p) => <ListItem doc={p.filename} title={p.name} meta={`${p.uploaded_by || "Sistem"} · ${tanggalWita(p.created_at)}`} badge={tombolHapus(p)} />} />
                    </Section>
                </div>

                <ConfirmDialog open={hapus !== null} onClose={() => setHapus(null)} tag="Hapus" tone="negative" title={`Hapus master ${hapus?.name ?? ""}?`} confirmLabel="Hapus master"
                    facts={[["Principal", hapus?.name ?? ""], ["Berkas", hapus?.filename ?? ""], ["Dipakai di", "Pilihan principal tersimpan di Summary Promo"], ["Akibat", "Master dihapus permanen. Unggah ulang berkasnya bila masih dibutuhkan"]]}
                    onConfirm={() => handleDelete(hapus!.id)} />
            </div>
        </FioriScope>
    );
}
