/*
 * Tujuan: Menyusun aturan promo dengan tangan — tambah, ubah, hapus (satuan maupun borongan),
 *         dan salin tarif ke beberapa outlet sekaligus.
 * Caller: pengguna lewat menu Promo & Klaim > Aturan Promo.
 * Dependensi: /api/promo-rule. Main Functions: AturanPromoPage.
 * Side Effects: HTTP; setiap simpan langsung menulis `promo_rule`.
 *
 * Halaman ini dan importir berkas di Rekap Promo menulis TABEL YANG SAMA. Impor dipakai saat
 * satu principal dimuat sekaligus; halaman ini saat satu baris perlu diperbaiki.
 *
 * Kenapa banyak kalimat penjelas di layar: yang mengisi halaman ini bukan orang yang menulis
 * kodenya. Angka "2.25" tidak berarti apa-apa sampai ada yang bilang itu 2,25% dan siapa yang
 * menanggungnya — dan salah menaruh posisi berarti uang berpindah penanggung tanpa terlihat.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Copy, RefreshCw, X, Info } from "lucide-react";
import { toast } from "sonner";
import DaftarOutlet from "./daftar-outlet";
import DariSummary from "./dari-summary";

type Rule = {
    id: number; principal: string; suratProgram: string; promoLabel: string; promoGroup: string;
    itemCode: string; itemName: string; customerCode: string;
    periodStart: string | null; periodEnd: string | null; active: boolean;
    tierNo: number; triggerQty: string; triggerUnit: string;
    benefitType: string; benefitValue: string; benefitUnit: string; benefitBeban: string;
    onFaktur: boolean; outletList: string; outletListMode: string; note: string; importedBy: string;
};

const KOSONG: Partial<Rule> = {
    principal: "KINO NON FOOD", suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR",
    promoLabel: "", itemCode: "", itemName: "", customerCode: "",
    periodStart: "", periodEnd: "", active: true, tierNo: 1, triggerQty: "0", triggerUnit: "PCS",
    benefitType: "DISC_PCT", benefitValue: "", benefitUnit: "%", benefitBeban: "DISTRIBUTOR",
    onFaktur: true, outletList: "", outletListMode: "", note: "",
};

/** Bentuk aturan, dibaca dari isinya — bukan dari kolom penanda yang bisa berbeda dari isinya. */
function bentuk(rule: Pick<Rule, "customerCode" | "itemCode">) {
    if (rule.customerCode && !rule.itemCode) return { label: "Tarif outlet", hint: "berlaku untuk semua barang outlet ini" };
    if (rule.itemCode) return { label: "Per barang", hint: "hanya untuk barang ini" };
    return { label: "Tingkat faktur", hint: "satu potongan untuk seluruh nota" };
}

const rupiah = (value: string | number) => Number(value || 0).toLocaleString("id-ID");
const persen = (value: string) => String(value).replace(".", ",");

/** Satu kalimat yang menjelaskan arti sebuah aturan, untuk orang yang tidak membaca kolom. */
function artinya(rule: Partial<Rule>): string {
    // Daftar peserta ikut disebut di kalimatnya: aturan yang sama persis bisa berlaku untuk 41
    // toko atau untuk semua toko KECUALI 41 itu, dan bedanya tidak terlihat dari kolom lain.
    const daftar = rule.outletList
        ? rule.outletListMode === "EXCLUDE" ? ` yang BUKAN peserta ${rule.outletList}` : ` peserta ${rule.outletList}`
        : "";
    const siapa = rule.customerCode ? `Outlet ${rule.customerCode}` : `Semua outlet${daftar}`;
    const barang = rule.itemCode ? `barang ${rule.itemCode}` : "semua barang";
    const beban = rule.benefitBeban === "PRINCIPAL"
        ? "ditanggung principal — bisa ditagihkan kembali"
        : "ditanggung kita sendiri — jadi biaya distributor";
    const ambang = Number(rule.triggerQty) > 0
        ? rule.triggerUnit === "RP"
            ? ` kalau belanjanya minimal Rp ${rupiah(rule.triggerQty ?? 0)},`
            : ` kalau beli minimal ${rupiah(rule.triggerQty ?? 0)} ${rule.triggerUnit},`
        : "";
    if (rule.benefitType === "DISC_RP") {
        return `${siapa}${ambang} dapat potongan Rp ${rupiah(rule.benefitValue ?? 0)} untuk seluruh nota. Potongan ini ${beban}.`;
    }
    if (rule.benefitType === "BONUS_QTY") {
        return `${siapa}${ambang} dapat bonus barang ${rule.benefitValue ?? ""}. Bonus ini ${beban}.`;
    }
    return `${siapa} dapat diskon ${persen(rule.benefitValue ?? "")}% atas ${barang}${ambang ? ambang.replace(",", "") : ""}, `
        + `tertulis di kolom DISC_${rule.tierNo} pada laporan Kino. Potongan ini ${beban}.`;
}

const inputCls = "w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-sm";

/*
 * `F` dan `G` hidup di ruang MODUL, bukan di dalam komponen.
 *
 * Komponen yang dibuat ulang tiap render punya identitas tipe yang baru tiap render, dan React
 * membongkar-pasang seluruh isinya. Akibatnya kotak isian kehilangan fokus setiap satu huruf
 * diketik — bug yang terbaca sebagai "layarnya lemot", bukan sebagai bug, jadi ia bertahan lama.
 */
function F({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="text-sm">
            <span className="mb-1 block text-slate-300">{label}</span>
            {children}
            {hint && <span className="mt-1 block text-xs leading-snug text-slate-500">{hint}</span>}
        </label>
    );
}

/**
 * Satu kelompok isian. Enam belas kotak dalam satu kisi rata tidak punya urutan baca: yang
 * mengisi harus menebak kotak mana berkaitan dengan kotak mana, dan kesalahan yang paling
 * mahal di halaman ini (salah kolom diskon, salah penanggung) lahir persis dari situ.
 * Dikelompokkan menurut pertanyaan yang dijawabnya, bukan menurut urutan kolom tabel.
 */
const G = ({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) => (
    <fieldset className="rounded border border-white/10 px-3 pb-3">
        <legend className="px-1 text-sm font-semibold text-slate-300">{title}</legend>
        <p className="mb-3 text-xs text-slate-500">{hint}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </fieldset>
);

export default function AturanPromoPage() {
    const [rules, setRules] = useState<Rule[]>([]);
    const [principals, setPrincipals] = useState<string[]>([]);
    const [principal, setPrincipal] = useState("");
    const [jenis, setJenis] = useState("");
    const [beban, setBeban] = useState("");
    const [q, setQ] = useState("");
    const [total, setTotal] = useState(0);
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState<Partial<Rule> | null>(null);
    const [salin, setSalin] = useState<{ rule: Rule; kode: string } | null>(null);
    const [pilih, setPilih] = useState<Set<number>>(new Set());
    // Halaman ini menumpuk tiga pekerjaan yang berbeda dalam satu kolom: menyusun aturan,
    // menarik dari Summary, dan menyusun daftar peserta. Dengan ratusan aturan, panel daftar
    // peserta terdorong berlembar-lembar ke bawah — dan panel yang harus dicari dengan
    // menggulung akan dianggap tidak ada. Satu tab berarti satu pekerjaan.
    const [tab, setTab] = useState<"aturan" | "summary" | "outlet">("aturan");

    const load = useCallback(async () => {
        setBusy(true);
        try {
            const params = new URLSearchParams();
            if (principal) params.set("principal", principal);
            if (jenis) params.set("jenis", jenis);
            if (beban) params.set("beban", beban);
            if (q) params.set("q", q);
            const res = await fetch(`/api/promo-rule?${params}`);
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal memuat aturan");
            setRules(body.rules); setPrincipals(body.principals); setTotal(body.total);
            setPilih(new Set());
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat aturan");
        } finally { setBusy(false); }
    }, [principal, jenis, beban, q]);

    useEffect(() => { void load(); }, [load]);

    const semuaTerpilih = rules.length > 0 && pilih.size === rules.length;
    const terpilih = useMemo(() => rules.filter((rule) => pilih.has(rule.id)), [rules, pilih]);

    function toggle(id: number) {
        setPilih((lama) => {
            const baru = new Set(lama);
            if (baru.has(id)) baru.delete(id); else baru.add(id);
            return baru;
        });
    }

    async function simpan() {
        if (!draft) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-rule", {
                method: draft.id ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(draft),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan");
            toast.success(draft.id ? "Aturan diperbarui" : "Aturan ditambahkan");
            setDraft(null); await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyimpan");
        } finally { setBusy(false); }
    }

    async function hapus(ids: number[], sebutan: string) {
        if (!ids.length) return;
        if (!confirm(`Hapus ${sebutan}?\n\n`
            + "Potongan yang tadinya dijelaskan aturan ini akan kembali tertahan gerbang validasi, "
            + "dan fakturnya tidak bisa dikirim sampai ada aturan penggantinya.")) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/promo-rule?ids=${ids.join(",")}`, { method: "DELETE" });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menghapus");
            toast.success(`${body.deleted} aturan dihapus`);
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menghapus");
        } finally { setBusy(false); }
    }

    async function salinKeOutlet() {
        if (!salin) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-rule", {
                method: "PUT", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: salin.rule.id, customerCodes: salin.kode }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyalin");
            toast.success(`Tarif disalin ke ${body.outlets} outlet`);
            setSalin(null); await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyalin");
        } finally { setBusy(false); }
    }

    const isTarif = Boolean(draft?.customerCode) && !draft?.itemCode;

    return (
        <div className="space-y-4 p-4">
            <header className="space-y-1">
                <h1 className="text-lg font-semibold">Aturan Promo</h1>
                <p className="max-w-3xl text-sm text-slate-400">
                    Daftar potongan yang <strong>boleh</strong> muncul di faktur. Gerbang validasi menahan setiap
                    potongan yang tidak ada di sini, jadi aturan yang salah atau hilang akan langsung terasa:
                    fakturnya tidak bisa dikirim. Yang dimuat dari berkas dan yang diketik di sini masuk ke tabel
                    yang sama.
                </p>
            </header>

            <nav className="flex flex-wrap gap-1 border-b border-white/10">
                {([
                    ["aturan", `Aturan promo${total ? ` (${total})` : ""}`],
                    ["summary", "Tarik dari Summary"],
                    ["outlet", "Daftar outlet peserta"],
                ] as const).map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setTab(key)}
                        aria-current={tab === key ? "page" : undefined}
                        className={`-mb-px rounded-t border-b-2 px-3 py-2 text-sm transition ${tab === key
                            ? "border-blue-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
                        {label}
                    </button>
                ))}
            </nav>

            {tab === "aturan" && (<>

            <section className="flex flex-wrap items-end gap-2">
                <F label="Principal">
                    <select value={principal} onChange={(e) => setPrincipal(e.target.value)} className={inputCls}>
                        <option value="">Semua</option>
                        {principals.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                </F>
                <F label="Berlaku untuk">
                    <select value={jenis} onChange={(e) => setJenis(e.target.value)} className={inputCls}>
                        <option value="">Semua</option>
                        <option value="tarif">Satu outlet, semua barang</option>
                        <option value="barang">Satu barang</option>
                        <option value="faktur">Seluruh nota</option>
                    </select>
                </F>
                <F label="Tanggungan">
                    <select value={beban} onChange={(e) => setBeban(e.target.value)} className={inputCls}>
                        <option value="">Semua</option>
                        <option value="DISTRIBUTOR">Kita (distributor)</option>
                        <option value="PRINCIPAL">Principal (bisa ditagih)</option>
                    </select>
                </F>
                <F label="Cari">
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="kode outlet, barang, atau surat" className={`${inputCls} min-w-56`} />
                </F>
                <button onClick={() => void load()} disabled={busy}
                    className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">
                    <RefreshCw size={15} /> Muat ulang
                </button>
                <button onClick={() => setDraft({ ...KOSONG })} disabled={busy}
                    className="ml-auto inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                    <Plus size={15} /> Aturan baru
                </button>
            </section>

            {draft && (
                <section className="space-y-3 rounded border border-blue-500/30 bg-blue-500/5 p-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">{draft.id ? `Ubah aturan #${draft.id}` : "Aturan baru"}</h2>
                        <button onClick={() => setDraft(null)} className="rounded p-1 hover:bg-white/10" aria-label="Tutup"><X size={16} /></button>
                    </div>

                    <p className="flex gap-2 rounded bg-white/5 p-3 text-sm text-slate-200">
                        <Info size={15} className="mt-0.5 shrink-0 text-blue-300" />
                        <span>{artinya(draft)}</span>
                    </p>

                    <G title="Asal aturan" hint="Dari mana aturan ini datang. Tanpa ini tidak ada yang bisa menjawab “kenapa boleh potong?” saat ditanya.">
                        <F label="Principal" hint="Pemilik programnya."><input value={draft.principal ?? ""} onChange={(e) => setDraft({ ...draft, principal: e.target.value })} className={inputCls} /></F>
                        <F label="Surat / program" hint="Asal aturannya. Tanpa ini tidak ada yang bisa menjawab “kenapa boleh potong?”">
                            <input value={draft.suratProgram ?? ""} onChange={(e) => setDraft({ ...draft, suratProgram: e.target.value })} className={inputCls} />
                        </F>
                        <F label="Kelompok" hint="Pengelompokan di dalam surat itu."><input value={draft.promoGroup ?? ""} onChange={(e) => setDraft({ ...draft, promoGroup: e.target.value })} className={inputCls} /></F>
                        <F label="Nama program" hint="Bebas — untuk dibaca manusia saja."><input value={draft.promoLabel ?? ""} onChange={(e) => setDraft({ ...draft, promoLabel: e.target.value })} className={inputCls} /></F>
                    </G>

                    <G title="Berlaku untuk siapa dan barang apa" hint="Dikosongkan berarti “semua”. Daftar peserta menyempitkannya lagi, dan di situlah salah sasaran paling sering terjadi.">
                        <F label="Kode outlet" hint="Kode internal tanpa akhiran cabang, mis. C-AL0063. Dikosongkan = berlaku untuk semua outlet.">
                            <input value={draft.customerCode ?? ""} onChange={(e) => setDraft({ ...draft, customerCode: e.target.value })} placeholder="kosong = semua outlet" className={inputCls} />
                        </F>
                        <F label="Kode barang" hint="Dikosongkan = berlaku untuk semua barang yang dibeli outlet itu.">
                            <input value={draft.itemCode ?? ""} onChange={(e) => setDraft({ ...draft, itemCode: e.target.value })} placeholder="kosong = semua barang" className={inputCls} />
                        </F>
                        <F label="Nama barang" hint="Untuk dibaca manusia; tidak dipakai mencocokkan."><input value={draft.itemName ?? ""} onChange={(e) => setDraft({ ...draft, itemName: e.target.value })} className={inputCls} /></F>
                        <F label="Hanya untuk peserta daftar" hint="Nama daftar outlet, mis. LOYALTY. Dikosongkan = berlaku untuk semua outlet. Daftarnya disusun di tab “Daftar outlet peserta”, dan namanya harus sama persis.">
                            <input value={draft.outletList ?? ""} onChange={(e) => setDraft({ ...draft, outletList: e.target.value.toUpperCase() })} placeholder="kosong = semua outlet" className={inputCls} />
                        </F>
                        <F label="Arah daftar" hint="“Hanya peserta” untuk program yang khusus mereka; “Semua kecuali peserta” untuk program yang justru mengecualikan mereka (MSG).">
                            <select value={draft.outletListMode ?? ""} onChange={(e) => setDraft({ ...draft, outletListMode: e.target.value })} className={inputCls} disabled={!draft.outletList}>
                                <option value="">— tanpa daftar —</option>
                                <option value="INCLUDE">Hanya peserta daftar</option>
                                <option value="EXCLUDE">Semua KECUALI peserta daftar</option>
                            </select>
                        </F>
                    </G>

                    <G title="Potongannya" hint="Berapa, dalam bentuk apa, di kolom mana, dan siapa yang menanggung. Salah kolom berarti uang berpindah penanggung tanpa terlihat.">
                        <F label="Siapa yang menanggung" hint="Principal = uangnya bisa ditagihkan kembali. Distributor = jadi biaya kita sendiri.">
                            <select value={draft.benefitBeban ?? "PRINCIPAL"} onChange={(e) => setDraft({ ...draft, benefitBeban: e.target.value })} className={inputCls}>
                                <option value="DISTRIBUTOR">Kita sendiri (distributor)</option>
                                <option value="PRINCIPAL">Principal (bisa ditagih)</option>
                            </select>
                        </F>

                        <F label="Bentuk potongan" hint="Persen memotong harga; rupiah memotong total nota.">
                            <select value={draft.benefitType ?? "DISC_PCT"} onChange={(e) => setDraft({ ...draft, benefitType: e.target.value })} className={inputCls}>
                                <option value="DISC_PCT">Diskon persen (%)</option>
                                <option value="DISC_RP">Potongan rupiah (Rp)</option>
                                <option value="BONUS_QTY">Bonus barang</option>
                            </select>
                        </F>
                        <F label={draft.benefitType === "DISC_RP" ? "Besar potongan (rupiah)" : "Besar diskon (persen)"}
                            hint={draft.benefitType === "DISC_RP"
                                ? "Tulis angkanya saja, mis. 20000 berarti Rp 20.000."
                                : "Tulis angkanya saja, mis. 2.25 berarti 2,25% dipotong dari harga. Pakai titik untuk koma."}>
                            <input value={draft.benefitValue ?? ""} onChange={(e) => setDraft({ ...draft, benefitValue: e.target.value })}
                                placeholder={draft.benefitType === "DISC_RP" ? "20000" : "2.25"} className={inputCls} />
                        </F>
                        <F label={isTarif ? "Di kolom diskon ke berapa" : "Tingkat (tier)"}
                            hint={isTarif
                                ? "Nomor kolom DISC_n pada laporan Kino. 1–3 = kita yang menanggung, 4–5 = bisa ditagih ke principal. Salah kolom berarti salah penanggung."
                                : "Urutan tingkat pembelian, mulai dari 1."}>
                            <input type="number" min={1} value={draft.tierNo ?? 1} onChange={(e) => setDraft({ ...draft, tierNo: Number(e.target.value) })} className={inputCls} />
                        </F>
                        <F label="Baru berlaku kalau belanja minimal" hint="Isi 0 kalau tidak ada syarat minimal. Pilih RP untuk nilai belanja.">
                            <div className="flex gap-1">
                                <input value={draft.triggerQty ?? "0"} onChange={(e) => setDraft({ ...draft, triggerQty: e.target.value })} className={inputCls} />
                                <select value={draft.triggerUnit ?? "PCS"} onChange={(e) => setDraft({ ...draft, triggerUnit: e.target.value })} className={inputCls}>
                                    <option value="PCS">PCS</option><option value="KRT">KRT</option><option value="RP">RP</option>
                                </select>
                            </div>
                        </F>

                    </G>

                    <G title="Masa berlaku dan catatan" hint="Aturan dinilai per TANGGAL SO, bukan per periode batch: satu berkas bisa memuat beberapa tanggal, dan aturan bisa berganti di antaranya.">
                        <F label="Berlaku mulai" hint="Dikosongkan = berlaku sejak kapan pun."><input type="date" value={draft.periodStart ?? ""} onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })} className={inputCls} /></F>
                        <F label="Berlaku sampai" hint="Dikosongkan = berlaku sampai dicabut."><input type="date" value={draft.periodEnd ?? ""} onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })} className={inputCls} /></F>
                        <F label="Catatan" hint="Mis. sumber datanya, atau siapa yang memastikan."><input value={draft.note ?? ""} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={inputCls} /></F>
                        <label className="flex items-center gap-2 pt-6 text-sm">
                            <input type="checkbox" id="aturan-aktif" checked={draft.active !== false} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                            <span>Aktif <span className="text-slate-500">(dimatikan = diabaikan gerbang)</span></span>
                        </label>
                    </G>

                    {isTarif && draft.benefitType === "DISC_PCT" && (
                        <p className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200">
                            Nomor kolom menentukan <strong>siapa yang menanggung</strong>, jadi ia tidak boleh asal.
                            Kolom 1–3 beban kita, 4–5 klaim principal — dan tanggungan yang tidak cocok dengan kolomnya
                            akan ditolak waktu disimpan, karena aturan seperti itu tidak akan pernah cocok dengan
                            potongan mana pun: ia hanya terlihat ada.
                        </p>
                    )}

                    <div className="flex gap-2">
                        <button onClick={() => void simpan()} disabled={busy}
                            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                            <Save size={15} /> Simpan
                        </button>
                        <button onClick={() => setDraft(null)} className="rounded bg-white/10 px-3 py-2 text-sm">Batal</button>
                    </div>
                </section>
            )}

            {salin && (
                <section className="space-y-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <h2 className="text-sm font-semibold">
                        Salin diskon {persen(salin.rule.benefitValue)}% (kolom DISC_{salin.rule.tierNo}) dari {salin.rule.customerCode} ke outlet lain
                    </h2>
                    <p className="text-xs leading-relaxed text-slate-300">
                        Satu jaringan berbagi tarif yang sama, tetapi tetap disimpan <strong>satu baris per kode outlet</strong>:
                        pencocokan dilakukan per pelanggan, dan anggota satu jaringan tidak selalu berkode mirip
                        (Satu Sama Jaya punya <code>C-SA0269</code> sekaligus <code>C-SAT015</code>). Tulis kodenya
                        dipisah koma, spasi, atau baris baru.
                    </p>
                    <textarea id="salin-kode" value={salin.kode} onChange={(e) => setSalin({ ...salin, kode: e.target.value })}
                        rows={2} placeholder="C-SAT015, C-SAT016" className={inputCls} />
                    <div className="flex gap-2">
                        <button onClick={() => void salinKeOutlet()} disabled={busy}
                            className="inline-flex items-center gap-2 rounded bg-emerald-600 px-3 py-2 text-sm disabled:opacity-40">
                            <Copy size={15} /> Salin
                        </button>
                        <button onClick={() => setSalin(null)} className="rounded bg-white/10 px-3 py-2 text-sm">Batal</button>
                    </div>
                </section>
            )}

            <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-slate-400">
                    Menampilkan {rules.length} dari {total} aturan.
                </p>
                {terpilih.length > 0 && (
                    <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/5 px-3 py-1.5">
                        <span className="text-sm text-red-200">{terpilih.length} dipilih</span>
                        <button onClick={() => void hapus(terpilih.map((r) => r.id), `${terpilih.length} aturan terpilih`)}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded bg-red-600 px-2.5 py-1 text-xs disabled:opacity-40">
                            <Trash2 size={13} /> Hapus yang dipilih
                        </button>
                        <button onClick={() => setPilih(new Set())} className="rounded px-2 py-1 text-xs hover:bg-white/10">Batal pilih</button>
                    </div>
                )}
            </div>

            {/* Tinggi dibatasi supaya daftar yang panjang tidak mendorong apa pun keluar layar,
                dan kepalanya menempel supaya kolom masih terbaca di baris ke-200. */}
            <div className="max-h-[32rem] overflow-auto rounded border border-white/10">
                <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white/5 text-slate-300 backdrop-blur">
                        <tr>
                            <th className="w-9 px-2 py-2">
                                <input type="checkbox" id="pilih-semua" aria-label="Pilih semua yang tampil"
                                    checked={semuaTerpilih}
                                    onChange={(e) => setPilih(e.target.checked ? new Set(rules.map((r) => r.id)) : new Set())} />
                            </th>
                            {["Berlaku untuk", "Outlet / barang", "Potongan", "Ditanggung", "Asal aturan", "Berlaku", ""].map((h) => (
                                <th key={h} className="whitespace-nowrap px-2 py-2 text-left font-medium">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rules.map((rule) => {
                            const b = bentuk(rule);
                            const dipilih = pilih.has(rule.id);
                            return (
                                <tr key={rule.id} className={`border-t border-white/5 ${rule.active ? "" : "opacity-50"} ${dipilih ? "bg-blue-500/10" : ""}`}>
                                    <td className="px-2 py-1.5 align-top">
                                        <input type="checkbox" checked={dipilih} onChange={() => toggle(rule.id)}
                                            aria-label={`Pilih aturan ${rule.id}`} />
                                    </td>
                                    <td className="px-2 py-1.5 align-top">
                                        {b.label}
                                        <span className="block text-xs text-slate-500">{b.hint}</span>
                                    </td>
                                    <td className="px-2 py-1.5 align-top">
                                        {/* Aturan yang dibatasi DAFTAR PESERTA tidak boleh tetap tertulis
                                            "semua outlet": kolom ini yang dibaca orang untuk menjawab
                                            "berlaku di toko mana", dan jawabannya jadi kebalikannya. */}
                                        {rule.customerCode || (rule.outletList
                                            ? <span className={rule.outletListMode === "EXCLUDE" ? "text-rose-300" : "text-sky-300"}>
                                                {rule.outletListMode === "EXCLUDE"
                                                    ? `semua KECUALI peserta ${rule.outletList}`
                                                    : `hanya peserta ${rule.outletList}`}
                                            </span>
                                            : <span className="text-slate-500">semua outlet</span>)}
                                        <span className="block text-xs text-slate-500">
                                            {rule.itemCode ? `${rule.itemCode} ${rule.itemName}`.trim() : "semua barang"}
                                        </span>
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 align-top tabular-nums">
                                        {rule.benefitType === "DISC_PCT" ? `${persen(rule.benefitValue)}%`
                                            : rule.benefitType === "DISC_RP" ? `Rp ${rupiah(rule.benefitValue)}`
                                                : `bonus ${rule.benefitValue}`}
                                        <span className="block text-xs text-slate-500">
                                            {rule.benefitType === "DISC_PCT" && rule.customerCode && !rule.itemCode
                                                ? `di kolom DISC_${rule.tierNo}`
                                                : `tingkat ${rule.tierNo}`}
                                            {Number(rule.triggerQty) > 0 && ` · min ${rupiah(rule.triggerQty)} ${rule.triggerUnit}`}
                                        </span>
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 align-top">
                                        <span className={`rounded px-1.5 py-0.5 text-xs ${rule.benefitBeban === "PRINCIPAL"
                                            ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                                            {rule.benefitBeban === "PRINCIPAL" ? "Principal" : "Kita"}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 align-top">
                                        {rule.suratProgram}
                                        <span className="block text-xs text-slate-500">{rule.promoGroup || rule.promoLabel}</span>
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-slate-400">
                                        {rule.periodStart ?? "kapan pun"}<br />s/d {rule.periodEnd ?? "dicabut"}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 text-right align-top">
                                        <button onClick={() => setDraft({ ...rule, periodStart: rule.periodStart ?? "", periodEnd: rule.periodEnd ?? "" })}
                                            className="rounded px-2 py-1 text-xs hover:bg-white/10">Ubah</button>
                                        {rule.customerCode && !rule.itemCode && (
                                            <button onClick={() => setSalin({ rule, kode: "" })}
                                                className="rounded px-2 py-1 text-xs hover:bg-white/10" title="Salin ke outlet lain">
                                                <Copy size={13} />
                                            </button>
                                        )}
                                        <button onClick={() => void hapus([rule.id], `aturan ${rule.suratProgram} ${rule.customerCode || rule.itemCode || "(seluruh nota)"}`)}
                                            className="rounded px-2 py-1 text-xs text-red-300 hover:bg-white/10" title="Hapus">
                                            <Trash2 size={13} />
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                        {rules.length === 0 && (
                            <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-400">Tidak ada aturan yang cocok dengan saringan ini.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            </>)}

            {tab === "summary" && <DariSummary setelahMuat={() => void load()} />}

            {tab === "outlet" && <DaftarOutlet />}
        </div>
    );
}
