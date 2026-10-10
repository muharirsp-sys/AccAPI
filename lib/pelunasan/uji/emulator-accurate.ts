/**
 * Tujuan: Accurate TIRUAN untuk uji karakterisasi Pelunasan (S6e-1) — TANPA jaringan, data generik.
 * Caller: lib/pelunasan/*.test.ts.
 * Main Functions: buatEmulator (accurateFetch tiruan + log panggilan + hitung serentak).
 * Side Effects: tidak ada; tiap jawaban adalah salinan dalam (kode pelunasan memutasi primeOwing seperti JSON
 *   segar dari Accurate sungguhan).
 * Semantik tiruan (sengaja sederhana, didokumentasikan supaya golden bisa dibaca):
 *   - filter.<field>.op EQUAL = sama persis (peka huruf); CONTAIN = substring tanpa peka huruf.
 *   - keyword = substring tanpa peka huruf di number/description/keywords/returnDocumentNumber/documentCode/
 *     customer.customerNo/customer.name; keyword BERGARIS MIRING tidak menemukan apa pun (perilaku yang dikeluhkan
 *     komentar kode lama "global keyword menyerah akibat slashes").
 *   - fields = proyeksi kunci tingkat atas; objek bertingkat (customer, branch) apa adanya dari data.
 *   - sp.pageSize bawaan 20; sp.page mulai 1.
 *   - payload yang memuat salah satu token `galat` -> melempar Error (jalur galat jaringan).
 */
type Rekaman = Record<string, unknown>;

export type DataAccurate = {
    salesInvoice: Rekaman[];
    salesReturn: Rekaman[];
    salesReceipt?: Rekaman[];
    galat?: string[];
};

export type Panggilan = { path: string; method: string; payload: unknown };

const salin = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const teks = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function cocokKeyword(r: Rekaman, kw: string): boolean {
    if (kw.includes("/")) return false;
    const k = kw.toUpperCase();
    const cust = (r.customer ?? {}) as Rekaman;
    return [r.number, r.description, r.keywords, r.returnDocumentNumber, r.documentCode, cust.customerNo, cust.name]
        .some((v) => teks(v).toUpperCase().includes(k));
}

function saring(data: Rekaman[], q: Rekaman): Rekaman[] {
    let hasil = data;
    for (const [kunci, nilai] of Object.entries(q)) {
        const m = /^filter\.([A-Za-z0-9]+)\.op$/.exec(kunci);
        if (!m) continue;
        const field = m[1];
        const val = teks(q[`filter.${field}.val`]);
        hasil = hasil.filter((r) => {
            const isi = field === "customerNo" ? teks((r.customer as Rekaman | undefined)?.customerNo) : teks(r[field]);
            return nilai === "EQUAL" ? isi === val : isi.toUpperCase().includes(val.toUpperCase());
        });
    }
    if (q["filter.customerNo"] !== undefined) {
        hasil = hasil.filter((r) => teks((r.customer as Rekaman | undefined)?.customerNo) === teks(q["filter.customerNo"]));
    }
    if (q.keyword !== undefined) hasil = hasil.filter((r) => cocokKeyword(r, teks(q.keyword)));
    return hasil;
}

/** `_detail` = isi tambahan yang HANYA dibawa detail.do (mis. primeOwing terbaru); tidak pernah tampak di list.do. */
const tanpaDetail = (r: Rekaman): Rekaman => { const { _detail, ...sisa } = r; void _detail; return sisa; };

function proyeksi(r: Rekaman, fields: unknown): Rekaman {
    if (typeof fields !== "string" || !fields) return salin(tanpaDetail(r));
    const out: Rekaman = {};
    for (const f of fields.split(",")) if (f in r) out[f] = salin(r[f]);
    return out;
}

function halaman(rows: Rekaman[], q: Rekaman) {
    const pageSize = Number(q["sp.pageSize"] ?? 20) || 20;
    const page = Number(q["sp.page"] ?? 1) || 1;
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    return { s: true, d: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => proyeksi(r, q.fields)), sp: { page, pageSize, pageCount, rowCount: rows.length } };
}

/** Tunda deterministik 0–3 ms (dari isi panggilan) agar urutan selesai berbeda dari urutan mulai. */
function tunda(kunci: string): Promise<void> {
    let h = 0;
    for (let i = 0; i < kunci.length; i++) h = (h * 31 + kunci.charCodeAt(i)) >>> 0;
    return new Promise((r) => setTimeout(r, h % 4));
}

export function buatEmulator(data: DataAccurate) {
    const panggilan: Panggilan[] = [];
    const serentak = new Map<string, { kini: number; maks: number }>();

    async function accurateFetch(path: string, method: string, payload?: unknown): Promise<unknown> {
        const q = (payload ?? {}) as Rekaman;
        panggilan.push({ path, method, payload: salin(payload ?? null) });
        const s = serentak.get(path) ?? { kini: 0, maks: 0 };
        serentak.set(path, s);
        s.kini++;
        s.maks = Math.max(s.maks, s.kini);
        try {
            await tunda(path + JSON.stringify(payload ?? null));
            const isi = JSON.stringify(payload ?? null);
            const galat = (data.galat ?? []).find((g) => isi.includes(g));
            if (galat) throw new Error(`emulator: galat buatan (${galat})`);
            const sumber = path.startsWith("/api/sales-invoice/") ? data.salesInvoice
                : path.startsWith("/api/sales-return/") ? data.salesReturn
                : path.startsWith("/api/sales-receipt/") ? (data.salesReceipt ?? [])
                : null;
            if (!sumber) throw new Error(`emulator: jalur tak dikenal ${path}`);
            if (path.endsWith("/list.do")) return halaman(saring(sumber, q), q);
            if (path.endsWith("/detail.do")) {
                const r = sumber.find((x) => (q.id !== undefined ? teks(x.id) === teks(q.id) : teks(x.number) === teks(q.number)));
                return r ? { s: true, d: salin({ ...tanpaDetail(r), ...((r._detail as Rekaman | undefined) ?? {}) }) } : { s: false, d: ["Data tidak ditemukan"] };
            }
            throw new Error(`emulator: jalur tak dikenal ${path}`);
        } finally {
            s.kini--;
        }
    }

    /** Multiset panggilan dalam bentuk kanonik terurut — tidak bergantung urutan konkurensi. */
    const panggilanKanonik = () => panggilan.map((p) => `${p.method} ${p.path} ${JSON.stringify(p.payload)}`).sort();
    const maksSerentak = (path: string) => serentak.get(path)?.maks ?? 0;

    return { accurateFetch, panggilan, panggilanKanonik, maksSerentak };
}
