/*
 * Tujuan: Halaman order kunjungan (owner 14 Nov 2026, dua alur salesman). Urutan di layar = urutan kerja: Stok toko sekarang (dari riwayat
 *   pengambilan) → Item super (WAJIB ditawarkan sebelum input order) → order.
 *   - Salesman input di AccAPI (sales_profile.sumber_order = accapi): Order Sales mode kunjungan (../../../../sales/OrderSales) — isian barang
 *     terkunci sampai stok + item super lengkap; Kirim order = simpan stok + item super lalu kirim ke antrean Web Sales, lalu order dicatat ke
 *     kunjungan (ref websales:<id>) dan kembali ke wizard (Merchandising).
 *   - Salesman input di sistem principal: TIDAK ada isian order; tombol "Sudah input order" mencatat langkah ini saja (ref principal + nomor
 *     order principal opsional). Tidak ada yang dikirim ke Accurate maupun Web Sales.
 * Caller: ./page.tsx.
 * Dependensi: GET /api/form-kontrol/visit, /item-super/saran (../ItemSuper ambilSaran), /api/customers/rute (cocokkanTokoRute), /api/customers/
 *   riwayat-beli (lib/riwayat-beli); POST /api/form-kontrol/order-kunjungan (kirimFk); ./StokToko, ../ItemSuper, ../langkah,
 *   app/(dashboard)/sales/OrderSales (mode kunjungan), components/fiori/*, components/order/*.
 * Main Functions: OrderKunjungan (muat/galat/bukan ORDER), Isi (dua alur).
 * Side Effects: HTTP baca; POST order-kunjungan (idempoten); mode AccAPI juga POST FastAPI /websales/orders lewat OrderSales.
 */
"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Plus } from "lucide-react";
import { Button, EmptyState, ErrorState, Flow, FooterToolbar, MessageStrip, ObjectPageHeader, Skeleton, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { kunciBaris, bacaRiwayat, urlRiwayat, type Riwayat } from "@/lib/riwayat-beli";
import { REF_PRINCIPAL, nomorDariRef, refWebsales, type LimitToko } from "@/lib/form-kontrol/order-kunjungan";
import { cocokkanTokoRute, bacaBarangKode } from "@/components/order/order-cabang-api";
import { galatDariJawaban, kalimatGalat, type PelangganPilih } from "@/components/order/order-cabang";
import OrderSales, { type ApiOrderKunjungan } from "../../../../sales/OrderSales";
import { GagalKirim, PESAN_SINYAL, ambilJson, ditolakBukanRute, kirimFk, sebabGagal } from "../../../lapangan";
import { alasanIzinFk } from "../../../shared";
import { ItemSuperBlok, ambilSaran, isianTawaran, jawabanAwal, jumlahBelum, ringkasItemSuper, ubahJawabanDi, type ItemSuperInfo, type Jawaban, type SaranItem } from "../ItemSuper";
import { L, LANGKAH, TeksLimit, bacaLimit, urlKunjungan } from "../langkah";
import { StokToko, barisStokWajib, bacaStok, isianStok } from "./StokToko";

type Props = { custCode: string; salesCode: string; principle: string; date: string; akunId: string; izinFk: string[] };
type Store = { custCode: string; custName: string; principle: string; salesName: string };
type Data = {
    store: Store; status: string | null; sumberOrder: "accapi" | "principal"; limit: LimitToko | null;
    stok: { kodeBarang: string; satuan: string; stok: number }[]; orderRef: string | null; nomorPrincipal: string;
    /** Langkah Order selesai (order_dicatat_pada). Kosong + orderRef terisi = hasil sempat diubah ke TIDAK ORDER lalu ORDER lagi. */
    dicatat: boolean;
    itemSuper: ItemSuperInfo | null; saranGalat: string | null;
    /** Pelanggan cabang toko ini (cocokkan kode JKS); null + alasan = tidak cocok / tidak terbaca. */
    pelanggan: PelangganPilih | null; alasanPelanggan: string | null;
};

export default function OrderKunjungan(props: Props) {
    const { custCode, salesCode, principle, date } = props;
    const loader = useCallback(async (): Promise<Load<Data>> => {
        const p = new URLSearchParams({ salesCode, custCode, principle, date });
        const [v, s, c] = await Promise.all([ambilJson(`/api/form-kontrol/visit?${p}`), ambilSaran(p), cocokkanTokoRute([custCode], undefined, "sales")]);
        if (v.status === 404) return { status: "galat", error: "Toko ini tidak ada di JKS Anda untuk principal ini. Buka order dari Rute hari ini." };
        if (v.status < 200 || v.status >= 300 || !v.data?.store) {
            return { status: "galat", error: v.status === 0 ? `${PESAN_SINYAL} Coba lagi saat ada sinyal.` : sebabGagal(v.status) };
        }
        const ao = (v.data.ao ?? null) as { status?: string; orderRef?: string | null; orderDicatatPada?: string | null; invoiceNumber?: string | null } | null;
        const cocok = c.ok ? c.data.find((x) => x.kode === custCode) ?? null : null;
        return { status: "siap", data: {
            store: v.data.store as Store, status: ao?.status ?? null,
            sumberOrder: v.data.sumberOrder === "principal" ? "principal" : "accapi",
            limit: bacaLimit(v.data.limit),
            stok: Array.isArray(v.data.stok) ? v.data.stok as Data["stok"] : [],
            orderRef: ao?.orderRef ?? null, nomorPrincipal: ao?.invoiceNumber ?? "", dicatat: Boolean(ao?.orderDicatatPada),
            itemSuper: "info" in s ? s.info : null, saranGalat: "galat" in s ? s.galat : null,
            pelanggan: cocok?.pelanggan ?? null,
            alasanPelanggan: cocok?.pelanggan ? null : cocok ? cocok.alasan : !c.ok && !("batal" in c) ? `${c.galat.judul}. ${kalimatGalat(c.galat)}` : "Toko belum terbaca sebagai pelanggan cabang Anda.",
        } };
    }, [salesCode, custCode, principle, date]);
    const [load, muatUlang] = useLoad(loader);
    const kembaliKe = urlKunjungan(props);
    const crumbs = [{ label: "Rute hari ini", href: "/form-kontrol?tab=ao" }, { label: "Kunjungan", href: kembaliKe }, { label: "Order" }];

    if (!load.data) {
        return (
            <div>
                <ObjectPageHeader breadcrumbs={crumbs} title={custCode} attributes={[{ label: "Tanggal", value: `${tanggalPanjang(date)} · WITA` }]} />
                <div className="fi-page" style={{ maxWidth: "48rem" }}>
                    {load.status === "galat" ? <ErrorState title="Halaman order gagal dimuat" message={load.error} onRetry={muatUlang} /> : <Skeleton rows={6} label="Memuat halaman order" />}
                </div>
            </div>
        );
    }
    const d = load.data;
    if (d.status !== "ordered" && d.status !== "active") {
        return (
            <div>
                <ObjectPageHeader breadcrumbs={crumbs} title={d.store.custName} attributes={[{ label: "Tanggal", value: `${tanggalPanjang(date)} · WITA` }]} />
                <div className="fi-page" style={{ maxWidth: "48rem" }}>
                    <EmptyState title="Hasil kunjungan belum ORDER" message="Halaman order dibuka sesudah hasil kunjungan toko ini disimpan sebagai ORDER di langkah Status."
                        action={<Link className="fi-btn fi-btn--secondary" href={kembaliKe}><ArrowLeft className="fi-icon" aria-hidden />Kembali ke kunjungan</Link>} />
                </div>
            </div>
        );
    }
    return <Isi {...props} d={d} kembaliKe={kembaliKe} crumbs={crumbs} />;
}

function Isi({ custCode, salesCode, principle, date, akunId, izinFk, d, kembaliKe, crumbs }: Props & { d: Data; kembaliKe: string; crumbs: { label: string; href?: string }[] }) {
    const router = useRouter();
    const principal = d.sumberOrder === "principal";
    const tanpaIzin = alasanIzinFk(new Set(izinFk), "submit");
    const [stok, setStok] = useState<Record<string, string>>(() => Object.fromEntries(d.stok.map((s) => [kunciBaris(s.kodeBarang, s.satuan), String(s.stok).replace(".", ",")])));
    const [saranIs, setSaranIs] = useState<ItemSuperInfo | null>(d.itemSuper);
    const [galatSaran, setGalatSaran] = useState<string | null>(d.saranGalat);
    const [memuatSaran, setMemuatSaran] = useState(false);
    const [jawaban, setJawaban] = useState<Record<string, Jawaban>>(() => jawabanAwal(d.itemSuper, {}));
    const [nomor, setNomor] = useState(d.nomorPrincipal);
    // Order yang tercatat di kunjungan ini; sesudah hasil sempat diubah ke TIDAK ORDER (dicatat kosong) order lama bisa dicatat lagi lewat
    // "Catat ke kunjungan ini" tanpa kirim ulang.
    const [tercatat, setTercatat] = useState<string[]>(() => !d.dicatat ? [] : (d.orderRef ?? "").split(",").filter((r) => r.startsWith("websales:")).map((r) => r.slice(9)));
    const [ubah, setUbah] = useState(false);
    const [galat, setGalat] = useState("");
    const [dialog, setDialog] = useState(false);
    const [mencatat, setMencatat] = useState(false);
    useUnsavedGuard(ubah);

    const pelanggan = d.pelanggan;
    const muatRiwayat = useCallback(async (): Promise<Load<Riwayat>> => {
        if (!pelanggan) return { status: "siap", data: { jendela: { bulan: 3, dari: "", sampai: "", bulanTeramati: 3 }, ringkasan: { jumlahFaktur: 0, tanpaRincian: 0, dilewati: 0, dataSejak: null }, items: [] } };
        const j = await ambilJson(urlRiwayat(pelanggan.customerNo), { credentials: "include" });
        const r = j.status >= 200 && j.status < 300 && j.data?.ok === true ? bacaRiwayat(j.data) : null;
        return r ? { status: "siap", data: r } : { status: "galat", error: kalimatGalat(galatDariJawaban(j, "sales")) };
    }, [pelanggan]);
    const [riwayat, muatUlangRiwayat] = useLoad(muatRiwayat);

    const isKurang = jumlahBelum(saranIs, jawaban);
    // Stok wajib hanya bila riwayat terbaca (galat/tanpa pelanggan = tidak menahan kunjungan; layar menyebutnya).
    const wajibStok = pelanggan && riwayat.status !== "galat" ? barisStokWajib(riwayat.data) : [];
    const kurangStok = wajibStok.filter((x) => bacaStok(stok[kunciBaris(x.code, x.unit)]) === null).length;
    const salahStok = Object.values(stok).some((v) => v.trim() !== "" && bacaStok(v) === null);
    const kunci = tanpaIzin
        ?? (pelanggan && riwayat.status === "memuat" && !riwayat.data ? "Menunggu riwayat pengambilan toko" : undefined)
        ?? (salahStok ? "Perbaiki isian stok yang bukan angka" : kurangStok > 0 ? `Isi stok ${kurangStok} barang lagi` : undefined)
        ?? (!saranIs ? "Muat ulang saran item super dulu" : isKurang > 0 ? `Tawarkan ${isKurang} item super dulu` : undefined);

    const ubahJawaban = (kode: string, patch: Partial<Jawaban>) => { setUbah(true); setGalat(""); setJawaban((p) => ubahJawabanDi(p, kode, patch)); };
    async function muatUlangSaran(): Promise<boolean> {
        setMemuatSaran(true);
        const s = await ambilSaran(new URLSearchParams({ salesCode, custCode, principle, date }));
        setMemuatSaran(false);
        if ("galat" in s) { setGalatSaran(s.galat); return false; }
        setSaranIs(s.info); setGalatSaran(null);
        setJawaban((p) => jawabanAwal(s.info, p));
        return true;
    }

    /** Simpan stok + item super (+ tanda selesai). Lempar Error berkalimat; daftar saran berubah = dimuat ulang, isian tetap. */
    async function simpan(selesai: { ref: string; nomorOrderPrincipal?: string | null } | null) {
        try {
            await kirimFk("/api/form-kontrol/order-kunjungan", { salesCode, custCode, principle, date, itemSuper: isianTawaran(jawaban),
                stok: isianStok(riwayat.data, stok), selesai }, { ulangAman: true });
            setUbah(false);
        } catch (e) {
            if (e instanceof GagalKirim && e.kode === "ITEM_SUPER_BELUM_LENGKAP" && await muatUlangSaran()) {
                throw new Error("Daftar item super berubah sejak halaman dibuka. Jawab item yang belum terisi, lalu coba lagi.");
            }
            if (ditolakBukanRute(e)) throw new Error(`${e.message} Kembali ke Rute hari ini.`);
            throw e instanceof Error ? e : new Error("Gagal menyimpan.");
        }
    }
    /** Mode AccAPI: order SUDAH terkirim ke antrean → dicatat ke kunjungan; gagal = strip + "Catat ke kunjungan ini" (tanpa kirim ulang). */
    function catatOrder(id: string) {
        setMencatat(true); setGalat("");
        simpan({ ref: refWebsales(id) })
            .then(() => { setTercatat((t) => (t.includes(id) ? t : [...t, id])); router.replace(kembaliKe); })
            .catch((e: unknown) => setGalat(`Order #${id.slice(0, 8)} sudah terkirim, tetapi belum tercatat di kunjungan ini. ${e instanceof Error ? e.message : ""} Tekan "Catat ke kunjungan ini" di daftar order toko ini; order tidak dikirim ulang.`))
            .finally(() => setMencatat(false));
    }

    const aksiDipesan = (api: ApiOrderKunjungan | null) => principal || !api?.pelanggan ? undefined : (s: SaranItem) => (
        <TambahItemSuper s={s} api={api} kunci={tanpaIzin} />
    );
    const tercatatSudah = d.dicatat;
    const ringkas = (
        <>
            {tanpaIzin && <MessageStrip tone="warn" title="Hanya lihat.">{tanpaIzin}</MessageStrip>}
            {tercatatSudah && (
                <MessageStrip tone="pos" title="Order kunjungan ini sudah tercatat.">
                    {principal ? "Anda sudah menandai order diinput di sistem principal." : `Order ${nomorDariRef(d.orderRef).join(", ")} tercatat.`}{" "}
                    {principal ? "Simpan lagi bila ada perubahan." : "Kirim order lagi hanya bila ada barang yang tertinggal."}{" "}
                    <Link className="fi-btn fi-btn--tertiary" href={kembaliKe}>Lanjut ke Merchandising</Link>
                </MessageStrip>
            )}
            {galat && <MessageStrip tone="neg" title="Belum tersimpan.">{galat}</MessageStrip>}
        </>
    );
    const bagian = (api: ApiOrderKunjungan | null): ReactNode => (
        <div className="grid gap-4" style={{ marginBottom: 16 }}>
            {ringkas}
            <StokToko riwayat={riwayat} muatUlang={muatUlangRiwayat} stok={stok} terkunci={Boolean(tanpaIzin)}
                ubahStok={(k, v) => { setUbah(true); setGalat(""); setStok((p) => ({ ...p, [k]: v })); }}
                alasanTanpa={pelanggan ? undefined : d.alasanPelanggan ?? undefined}
                order={!principal && api?.pelanggan ? { pelanggan: api.pelanggan, tanggal: api.tanggal, baris: api.baris, tambah: api.tambah, kunci } : undefined} />
            {saranIs
                ? <ItemSuperBlok info={saranIs} jawaban={jawaban} ubah={ubahJawaban} terkunci={Boolean(tanpaIzin)} isKurang={isKurang} aksiDipesan={aksiDipesan(api)}
                    pengantar={`Tawarkan dulu item super yang belum dibeli toko ini, sebelum ${principal ? "input order di sistem principal" : "input order"}. Bila tidak dipesan, pilih alasannya.`} />
                : (
                    <MessageStrip tone="neg" title="Saran item super belum termuat.">
                        {galatSaran} Order baru bisa dicatat sesudah saran termuat.{" "}
                        <Button variant="tertiary" busy={memuatSaran} onClick={() => void muatUlangSaran()}>Muat ulang saran</Button>
                    </MessageStrip>
                )}
        </div>
    );

    const flow = (
        <>
            <div className="fi-flow-lega"><Flow label="Langkah kunjungan" steps={LANGKAH.map((label, i) => ({ label, state: i < L.order ? "done" : i === L.order ? "current" : "todo" }))} /></div>
            <span className="fi-small fi-subtle">Langkah {L.order + 1} dari {LANGKAH.length} · Order · {principal ? `input di sistem ${d.store.principle}` : "input di AccAPI"}</span>
        </>
    );
    const kepala = (
        <ObjectPageHeader breadcrumbs={crumbs} title={d.store.custName} draft={ubah}
            status={tercatatSudah ? <StatusBadge tone="pos">Order tercatat</StatusBadge> : undefined}
            attributes={[
                { label: "Kode", value: <span className="fi-mono">{d.store.custCode}</span> },
                { label: "Principal", value: d.store.principle },
                ...(d.limit ? [{ label: "Limit kredit", value: <TeksLimit l={d.limit} /> }] : []),
            ]}
            flow={flow} />
    );

    if (!principal) {
        return (
            <OrderSales akunId={akunId} kunjungan={{
                customerNo: pelanggan?.customerNo ?? null, kunciDraf: `${custCode}|${principle}|${date}`, kepala, kunci,
                sebelumBarang: (api) => bagian(api),
                sebelumKirim: () => simpan(null),
                sesudahKirim: (id) => catatOrder(id),
                tercatat,
            }} />
        );
    }

    // Salesman input di sistem principal: tanpa isian order; "Sudah input order" mencatat langkah ini saja.
    return (
        <div>
            {kepala}
            <div className="fi-page" style={{ maxWidth: "48rem" }}>
                {bagian(null)}
                <section className="fi-panel grid gap-3" aria-labelledby="judul-order-principal">
                    <h2 className="fi-title-3" id="judul-order-principal">Order di sistem {d.store.principle}</h2>
                    <p className="fi-small">
                        Input order toko ini di aplikasi {d.store.principle}, sesuai permintaan toko dan saran Anda dari stok di atas. Halaman ini tidak mengirim
                        order ke Accurate. Sesudah selesai, tekan <b>Sudah input order</b> untuk lanjut ke Merchandising.
                    </p>
                    <FormField label={`Nomor order di sistem ${d.store.principle}`} help="Boleh kosong. Dipakai SPV mencocokkan order dengan faktur yang masuk sesudah laporan principal ditarik.">
                        {(a) => <input {...a} className="fi-input" value={nomor} maxLength={60} autoComplete="off" placeholder="Nomor dari aplikasi principal" disabled={Boolean(tanpaIzin)}
                            onChange={(e) => { setNomor(e.target.value); setUbah(true); }} />}
                    </FormField>
                </section>
            </div>
            <FooterToolbar message={kunci ?? (tercatatSudah && !ubah ? "Order sudah tercatat." : "Tekan sesudah order selesai diinput di sistem principal.")}>
                <Link className="fi-btn fi-btn--tertiary" href={kembaliKe}><ArrowLeft className="fi-icon" aria-hidden />Kunjungan</Link>
                <Button variant="primary" icon={<CheckCircle2 className="fi-icon" aria-hidden />} disabled={Boolean(kunci)} disabledReason={kunci} busy={mencatat}
                    onClick={() => setDialog(true)}>Sudah input order</Button>
            </FooterToolbar>
            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Order ${d.store.custName} sudah diinput di sistem ${d.store.principle}?`}
                description="Langkah Order kunjungan ini dicatat sebagai selesai, lalu Anda lanjut ke Merchandising. Tidak ada yang dikirim ke Accurate."
                facts={[
                    ["Stok toko", `${isianStok(riwayat.data, stok).length} barang dicatat`],
                    ["Item super", saranIs?.wajib.length ? ringkasItemSuper(jawaban) : "tidak ada saran wajib"],
                    ["Nomor order principal", nomor.trim() || "tidak diisi"],
                ]}
                confirmLabel="Sudah input order"
                onConfirm={async () => {
                    await simpan({ ref: REF_PRINCIPAL, nomorOrderPrincipal: nomor.trim() || null });
                    setDialog(false);
                    router.replace(kembaliKe);
                }} />
        </div>
    );
}

/** Item super yang dipesan → Tambah ke order (mode AccAPI): barang dibaca dari barang cabang pelanggan, satuan tunggal dipilih otomatis. */
function TambahItemSuper({ s, api, kunci }: { s: SaranItem; api: ApiOrderKunjungan; kunci?: string }) {
    const [st, setSt] = useState<{ jenis: "memuat" } | { jenis: "galat"; pesan: string } | null>(null);
    const sudah = useMemo(() => api.baris.some((b) => [s.kodeBarang, ...s.kodeLain].includes(b.code.trim())), [api.baris, s]);
    if (sudah) return <StatusBadge tone="neu">Sudah di order</StatusBadge>;
    async function tambah() {
        if (!api.pelanggan) return;
        setSt({ jenis: "memuat" });
        const h = await bacaBarangKode(s.kodeBarang, api.pelanggan, api.tanggal, new AbortController().signal, "sales");
        if (!h.ok) { setSt("batal" in h ? null : { jenis: "galat", pesan: kalimatGalat(h.galat) }); return; }
        if (!h.data) { setSt({ jenis: "galat", pesan: `${s.kodeBarang} tidak ada di barang cabang ${api.pelanggan.branchName}. Cari varian lain lewat pencarian barang.` }); return; }
        setSt(null);
        api.tambah(h.data, h.data.units.length === 1 ? h.data.units[0].unit : "", "1");
    }
    return (
        <div className="grid gap-1">
            <div><Button variant="secondary" icon={<Plus className="fi-icon" aria-hidden />} busy={st?.jenis === "memuat"} disabled={Boolean(kunci)} disabledReason={kunci}
                aria-label={`Tambah ${s.namaBarang} ke order`} onClick={() => void tambah()}>Tambah ke order</Button></div>
            {st?.jenis === "galat" && <p className="fi-small fi-msg" role="alert" style={{ margin: 0 }}>{st.pesan}</p>}
        </div>
    );
}
