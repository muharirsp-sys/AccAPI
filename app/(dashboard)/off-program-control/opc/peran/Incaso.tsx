/*
 * Tujuan: Modul peran Incaso OFF Program Control (tab `incaso`, ZONA UANG; owner 3 Nov 2026): item ber-cara bayar Potong Tagihan
 *   dicatat Incaso, bukan Keuangan, dengan mengisi nomor faktur yang dipotong. Satu item boleh dipotong dari beberapa faktur.
 *   Tiap nomor diperiksa langsung (pelanggan, sisa tagihan) lewat GET /api/off-program-control/faktur-potong; server memeriksa
 *   ulang semuanya saat menyimpan (route finance-payment, cara bayar Potong Tagihan).
 * Caller: OpcApp.tsx (MODUL.incaso).
 * Dependensi: opc/Bersama (KerjaPeran, tulisOpc), opc/ObjectPageBatch, components/fiori/*, lib/opc-ui, lib/off-program-control/{workflow,payments}.
 * Main Functions: Incaso (default), DetailIncaso, BarisFaktur.
 * Side Effects: POST /api/off-program-control/batches/[id]/finance-payment (FormData: paymentDate, note, itemIds JSON, alokasi JSON):
 *   MENCATAT ITEM LUNAS LEWAT POTONG TAGIHAN. Menandai draf halaman selama ada isian yang belum dicatat.
 */
"use client";

import { useEffect, useState } from "react";
import { Plus, Receipt, Trash2 } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { canProcessFinancePayment } from "@/lib/off-program-control/workflow";
import { normalizePaymentMethod } from "@/lib/off-program-control/payments";
import type { OffBatchRow } from "@/lib/off-program-control/types";
import { TAMPILAN, tanggalOpc, type ItemOpc, type PembayaranOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { KerjaPeran, TulisTidakPasti, pesanTidakPasti, tulisOpc, type DetailProps, type PeranProps } from "../Bersama";
import { ObjectPageBatch, type BagianTambahan } from "../ObjectPageBatch";

type ItemPotong = ItemOpc & { financePaymentId?: string | null };
type Cek = { status: "kosong" | "memuat" | "galat"; pesan?: string }
    | { status: "ada"; number: string; customerNo: string | null; customerName: string | null; sisa: number | null; cocok: boolean };
type Baris = { kunci: number; nomor: string; nominal: string; cek: Cek };

const enc = encodeURIComponent;
const PUTUS = pesanTidakPasti("potong tagihan ini", "Riwayat pembayaran");
const sudah = (i: ItemPotong) => i.financePaymentStatus === "paid" || Boolean(i.financePaymentId);
const potong = (i: ItemPotong) => normalizePaymentMethod(i.caraBayar) === "Potong Tagihan";
const angka = (v: string) => Number(String(v).replace(/[^\d]/g, "") || 0);
const sen = (n: number) => Math.round(n * 100);
const kunciNo = (no: string) => no.trim().toUpperCase();
let urut = 0;
const barisBaru = (nominal = 0): Baris => ({ kunci: ++urut, nomor: "", nominal: nominal ? String(nominal) : "", cek: { status: "kosong" } });

/** Cek satu nomor faktur untuk toko item (pratinjau; server memeriksa ulang). */
async function cekFaktur(no: string, toko: string): Promise<Cek> {
    try {
        const res = await fetch(`/api/off-program-control/faktur-potong?no=${enc(no)}&toko=${enc(toko)}`, { credentials: "include" });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) return { status: "galat", pesan: data?.error || "Gagal memeriksa faktur." };
        if (!data.ditemukan) return { status: "galat", pesan: "Tidak ditemukan di data faktur Accurate yang tersinkron." };
        if (data.ganda) return { status: "galat", pesan: "Nomor ini tercatat ganda di data tersinkron. Hubungi admin." };
        const f = data.faktur;
        return { status: "ada", number: f.number, customerNo: f.customerNo, customerName: f.customerName, sisa: f.sisa, cocok: Boolean(f.cocok) };
    } catch {
        return { status: "galat", pesan: "Koneksi terputus saat memeriksa faktur." };
    }
}

function DetailIncaso(props: DetailProps) {
    const { ctx, daftar, detail, muatUlang } = props;
    const setDraf = ctx.setDraf;
    const [rincian, setRincian] = useState<Record<string, Baris[]>>({}); // itemId → baris faktur; ada kunci = item dipilih
    const [tanggal, setTanggal] = useState("");
    const [catatan, setCatatan] = useState("");
    const [dialog, setDialog] = useState(false);
    const [hasil, setHasil] = useState<{ pesan: string; bukti: PembayaranOpc | null } | null>(null);

    const d = detail.data;
    const b = d?.batch;
    const aktif = Boolean(b && canProcessFinancePayment(b as unknown as OffBatchRow));
    const dirty = aktif && (Object.keys(rincian).length > 0 || tanggal !== "" || catatan !== "");
    useEffect(() => { setDraf(dirty); return () => setDraf(false); }, [dirty, setDraf]);

    const strip = hasil && (
        <MessageStrip tone="pos" title={hasil.pesan} onClose={() => setHasil(null)}>
            {hasil.bukti?.proofUrl && <a href={hasil.bukti.proofUrl} target="_blank" rel="noreferrer">Buka bukti potong tagihan (PDF)</a>}
        </MessageStrip>
    );
    if (!d || !b) return <ObjectPageBatch {...props} />;
    if (!aktif) return <ObjectPageBatch {...props} strip={strip} />;

    const items = d.items as ItemPotong[];
    const daftarPotong = items.filter(potong);
    const dipilih = daftarPotong.filter((i) => rincian[i.id] && !sudah(i));
    const total = dipilih.reduce((t, i) => t + Number(i.nominal || 0), 0);
    const izin = ctx.izin("potong_tagihan");
    const terkunci = d.uji ? "Batch data uji (mock) tidak bisa dicatat."
        : detail.status === "memuat" ? "Menunggu detail batch selesai dimuat ulang."
            : detail.status === "galat" ? "Detail batch gagal dimuat ulang; status di layar bisa usang. Muat ulang dulu."
                : undefined;

    const ubahBaris = (itemId: string, kunci: number, ubah: Partial<Baris>) =>
        setRincian((r) => ({ ...r, [itemId]: (r[itemId] ?? []).map((x) => (x.kunci === kunci ? { ...x, ...ubah } : x)) }));
    const periksa = async (item: ItemPotong, baris: Baris) => {
        if (!baris.nomor.trim()) { ubahBaris(item.id, baris.kunci, { cek: { status: "kosong" } }); return; }
        ubahBaris(item.id, baris.kunci, { cek: { status: "memuat" } });
        ubahBaris(item.id, baris.kunci, { cek: await cekFaktur(baris.nomor.trim(), item.toko || "") });
    };
    const pilihItem = (next: ReadonlySet<string>) => setRincian((r) => {
        const baru: Record<string, Baris[]> = {};
        for (const id of next) baru[id] = r[id] ?? [barisBaru(Number(items.find((i) => i.id === id)?.nominal || 0))];
        return baru;
    });

    // Pratinjau aturan server: tiap item ≥1 faktur, jumlah = nominal item, faktur ada & milik toko itu, Σ per faktur ≤ sisa.
    const perFaktur = new Map<string, { jumlah: number; sisa: number | null; number: string }>();
    let alasanIsi: string | undefined;
    for (const i of dipilih) {
        const baris = rincian[i.id] ?? [];
        const jumlah = baris.reduce((t, x) => t + sen(angka(x.nominal)), 0);
        for (const x of baris) {
            if (!alasanIsi && !x.nomor.trim()) alasanIsi = `Item ${i.itemNo}: isi nomor faktur.`;
            else if (!alasanIsi && x.cek.status !== "ada") alasanIsi = `Item ${i.itemNo}: ${x.cek.status === "galat" ? x.cek.pesan : "periksa nomor faktur dulu (keluar dari kolom nomor)."}`;
            else if (!alasanIsi && x.cek.status === "ada" && !x.cek.cocok) alasanIsi = `Item ${i.itemNo}: faktur ${x.cek.number} bukan milik toko item ini.`;
            if (x.cek.status === "ada") {
                const k = kunciNo(x.cek.number);
                const lama = perFaktur.get(k);
                perFaktur.set(k, { jumlah: (lama?.jumlah ?? 0) + sen(angka(x.nominal)), sisa: x.cek.sisa, number: x.cek.number });
            }
        }
        if (!alasanIsi && jumlah !== sen(Number(i.nominal || 0))) alasanIsi = `Item ${i.itemNo}: total potongan harus sama dengan nominal item (${rupiah(i.nominal)}).`;
    }
    for (const f of perFaktur.values()) {
        if (!alasanIsi && (f.sisa == null || f.jumlah > sen(f.sisa))) alasanIsi = `Faktur ${f.number}: potongan melebihi sisa yang bisa dipotong (${rupiah(f.sisa ?? 0)}).`;
    }
    const alasan = izin ?? terkunci ?? (dipilih.length === 0 ? "Pilih item Potong Tagihan dulu." : alasanIsi ?? (!tanggal ? "Isi tanggal potong dulu." : undefined));

    const kolom: Column<ItemPotong>[] = [
        { key: "surat", header: "No Surat · program", cell: (i) => <><span className="fi-mono">{i.noSurat || KOSONG}</span><span className="fi-sub">{i.namaProgram || KOSONG}</span></> },
        { key: "toko", header: "Toko", cell: (i) => i.toko || KOSONG },
        { key: "nominal", header: "Nominal", align: "end", cell: (i) => <span className="fi-tnum">{rupiah(i.nominal)}</span> },
        { key: "status", header: "Incaso", cell: (i) => (sudah(i) ? <StatusBadge tone="pos">Sudah dipotong</StatusBadge> : rincian[i.id] ? <StatusBadge tone="info">Akan dicatat</StatusBadge> : "Belum dicatat") },
    ];
    const bisaDipilih = (i: ItemPotong) => !izin && !terkunci && !sudah(i);
    const tabel = (
        <>
            <ResponsiveTable title="Item Potong Tagihan" columns={kolom} rows={daftarPotong} rowKey={(i) => i.id}
                selected={new Set(Object.keys(rincian))} onSelectedChange={pilihItem} selectableRow={bisaDipilih}
                rowLabel={(i) => `Pilih item ${i.itemNo} (${i.toko || "tanpa toko"}) untuk dicatat`}
                empty={{ title: "Batch ini tidak punya item Potong Tagihan" }}
                mobileItem={(i) => (
                    // Ponsel: kotak centang sendiri (label = target sentuh 44 px), sama dengan pola Keuangan.
                    <div className="fi-wl-row" style={{ gridTemplateColumns: "auto minmax(0, 1fr)", paddingLeft: 4 }}>
                        <label className="fi-check" style={{ minWidth: 44, justifyContent: "center" }}>
                            <input type="checkbox" aria-label={`Pilih item ${i.itemNo} (${i.toko || "tanpa toko"}) untuk dicatat`} checked={Boolean(rincian[i.id])} disabled={!bisaDipilih(i)}
                                onChange={() => { const next = new Set(Object.keys(rincian)); if (next.has(i.id)) next.delete(i.id); else next.add(i.id); pilihItem(next); }} />
                        </label>
                        <ListItem doc={i.noSurat || `Item ${i.itemNo}`} amount={rupiah(i.nominal)} title={i.toko || KOSONG} meta={i.namaProgram}
                            badge={sudah(i) ? <StatusBadge tone="pos">Sudah dipotong</StatusBadge> : rincian[i.id] ? <StatusBadge tone="info">Akan dicatat</StatusBadge> : undefined} />
                    </div>
                )} />
            {items.length > daftarPotong.length && (
                <div className="fi-sect-in"><MessageStrip tone="info" title={`${items.length - daftarPotong.length} item lain dibayar Keuangan (Transfer atau Tunai).`} /></div>
            )}
        </>
    );

    const bagian: BagianTambahan = {
        id: "opc-catat-potong",
        label: "Catat potong tagihan",
        isi: (
            <div className="fi-sect-in" style={{ display: "grid", gap: 16 }}>
                <p className="fi-small fi-subtle">
                    Centang item di atas, lalu tulis nomor faktur toko itu yang dipotong. Satu item boleh dipotong dari beberapa faktur:
                    tambah baris faktur sampai jumlahnya sama dengan nominal item. Faktur harus milik toko yang sama dan sisa tagihannya cukup.
                </p>
                {dipilih.length === 0 && <MessageStrip tone="info" title="Belum ada item yang dipilih." />}
                {dipilih.map((i) => {
                    const baris = rincian[i.id] ?? [];
                    const terbagi = baris.reduce((t, x) => t + angka(x.nominal), 0);
                    const pas = sen(terbagi) === sen(Number(i.nominal || 0));
                    return (
                        <fieldset key={i.id} className="fi-card" style={{ display: "grid", gap: 8, padding: 12 }}>
                            <legend className="fi-small"><b>Item {i.itemNo}</b> · {i.toko || KOSONG} · <span className="fi-tnum">{rupiah(i.nominal)}</span></legend>
                            {baris.map((x) => (
                                <BarisFaktur key={x.kunci} item={i} baris={x} bolehHapus={baris.length > 1} nonaktif={Boolean(izin || terkunci)}
                                    ubah={(u) => ubahBaris(i.id, x.kunci, u)} periksa={() => periksa(i, x)}
                                    hapus={() => setRincian((r) => ({ ...r, [i.id]: (r[i.id] ?? []).filter((y) => y.kunci !== x.kunci) }))} />
                            ))}
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                                <Button variant="tertiary" icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(izin || terkunci)}
                                    onClick={() => setRincian((r) => ({ ...r, [i.id]: [...(r[i.id] ?? []), barisBaru(Math.max(0, Number(i.nominal || 0) - terbagi))] }))}>
                                    Tambah faktur
                                </Button>
                                <span className={pas ? "fi-small" : "fi-small fi-why"}>Terbagi <span className="fi-tnum">{rupiah(terbagi)}</span> dari <span className="fi-tnum">{rupiah(i.nominal)}</span></span>
                            </div>
                        </fieldset>
                    );
                })}
                <div className="fi-formgrid">
                    <FormField label="Tanggal potong" required help="Tanggal tagihan toko dipotong.">
                        {(a) => <input {...a} className="fi-input" type="date" value={tanggal} disabled={Boolean(izin)} onChange={(e) => setTanggal(e.target.value)} />}
                    </FormField>
                    <FormField label="Catatan Incaso" help="Opsional, misalnya nomor penerimaan atau keterangan penagihan.">
                        {(a) => <textarea {...a} className="fi-input" rows={2} value={catatan} disabled={Boolean(izin)} onChange={(e) => setCatatan(e.target.value)} />}
                    </FormField>
                </div>
            </div>
        ),
    };

    async function catat() {
        const alokasi = dipilih.flatMap((i) => (rincian[i.id] ?? []).map((x) => ({ itemId: i.id, nomorFaktur: x.nomor.trim(), nominal: angka(x.nominal) })));
        const formData = new FormData();
        formData.append("paymentDate", tanggal);
        formData.append("note", catatan);
        formData.append("itemIds", JSON.stringify(dipilih.map((i) => i.id)));
        formData.append("alokasi", JSON.stringify(alokasi));
        let data: Record<string, unknown>;
        try {
            data = await tulisOpc(`/api/off-program-control/batches/${enc(b!.id)}/finance-payment`, { body: formData, gagal: "Gagal mencatat potong tagihan.", putus: PUTUS });
        } catch (e) {
            if (e instanceof TulisTidakPasti) { setDialog(false); props.laporTidakPasti(e.message); }
            else muatUlang();
            throw e;
        }
        const lunas = (data.paymentSummary as { isFullyPaid?: boolean } | undefined)?.isFullyPaid === true;
        const pesan = String(data.message || "Potong tagihan dicatat.");
        setHasil({ pesan, bukti: (data.payment as PembayaranOpc | undefined) ?? null });
        setRincian({});
        setTanggal("");
        setCatatan("");
        setDialog(false);
        if (lunas) props.selesai(pesan);
        else { daftar.muatUlang(); muatUlang(); }
    }

    const fakta: Array<[string, React.ReactNode]> = [
        ["Principal", b.principleName],
        ["Item dicatat", `${dipilih.length} item Potong Tagihan`],
        ["Total dipotong", <b key="t" className="fi-tnum">{rupiah(total)}</b>],
        ["Faktur", [...perFaktur.values()].map((f) => `${f.number} (${rupiah(f.jumlah / 100)})`).join(", ") || KOSONG],
        ["Tanggal potong", tanggalOpc(tanggal)],
        ["Bukti tersimpan", "PDF bukti potong tagihan dibuat otomatis, memuat nomor faktur"],
    ];
    return (
        <ObjectPageBatch
            {...props}
            draf={dirty}
            gantiItem={tabel}
            bagian={[bagian]}
            strip={strip}
            pesanFooter={dipilih.length > 0 ? <span className="fi-sum"><b>{dipilih.length} item</b> · {rupiah(total)}{alasan && <span className="fi-why"> · {alasan}</span>}</span> : alasan}
            aksi={
                <>
                    <Button variant="primary" icon={<Receipt className="fi-icon" aria-hidden />} disabled={Boolean(alasan)} disabledReason={alasan} onClick={() => setDialog(true)}>
                        Catat potong tagihan…
                    </Button>
                    <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Catat potong tagihan ${b.noPengajuan}?`} tag="Potong Tagihan"
                        confirmLabel={`Catat ${rupiah(total)}`} confirmDisabled={alasan} facts={fakta} onConfirm={catat} />
                </>
            }
        />
    );
}

/** Satu baris faktur: nomor (diperiksa saat keluar dari kolom), nominal, hasil pemeriksaan di bawahnya. */
function BarisFaktur({ item, baris, ubah, periksa, hapus, bolehHapus, nonaktif }: {
    item: ItemPotong; baris: Baris; ubah: (u: Partial<Baris>) => void; periksa: () => void; hapus: () => void; bolehHapus: boolean; nonaktif: boolean;
}) {
    const c = baris.cek;
    const info = c.status === "memuat" ? <span className="fi-sub">Memeriksa faktur…</span>
        : c.status === "galat" ? <span className="fi-why">{c.pesan}</span>
            : c.status === "ada" ? (
                <span className={c.cocok ? "fi-sub" : "fi-why"}>
                    {c.customerName || KOSONG} ({c.customerNo || KOSONG}) · sisa bisa dipotong <span className="fi-tnum">{c.sisa == null ? "belum diketahui" : rupiah(c.sisa)}</span>
                    {!c.cocok && ` · bukan toko ${item.toko || "item ini"}`}
                </span>
            ) : null;
    return (
        <div style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                <FormField label="No faktur" required>
                    {(a) => <input {...a} className="fi-input fi-mono" style={{ minWidth: 200 }} value={baris.nomor} disabled={nonaktif} placeholder="mis. INV/2026/0001"
                        onChange={(e) => ubah({ nomor: e.target.value, cek: { status: "kosong" } })} onBlur={periksa} />}
                </FormField>
                <FormField label="Nominal dipotong" required>
                    {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" style={{ width: 160 }} value={baris.nominal ? rupiah(angka(baris.nominal)) : ""} disabled={nonaktif}
                        onChange={(e) => ubah({ nominal: String(angka(e.target.value)) })} />}
                </FormField>
                {bolehHapus && <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={nonaktif} onClick={hapus}>Hapus</Button>}
            </div>
            <div aria-live="polite">{info}</div>
        </div>
    );
}

export default function Incaso(props: PeranProps) {
    return <KerjaPeran {...props} tampilan={TAMPILAN.incaso} Detail={DetailIncaso} />;
}


