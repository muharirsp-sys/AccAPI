/* Insiden 22 Nov 2026: access token Accurate mati, tetapi cron/webhook/stok/faktur hanya menjawab "HTTP 401" dan /sesi-accurate
   tetap "Database aktif". Badan 401 dari docs/prd/ACCURATE_API_REFERENCE.md §1; badan bisa menggemakan token (lib/accurate-redact). */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PESAN_TOKEN_MATI, SesiAccurateHabis, TokenAccurateMati, galat401, tokenMati } from "./accurate-401.ts";
import { fetchAccurate, type AccurateCredentials } from "./sync.ts";
import { ambil } from "./accurate-baca.ts";
import { bacaAccurate, jawaban401 } from "./accurate-forward.ts";
import { periksaToken } from "./accurate-session.ts";

const RAHASIA = "0d4c5a6e-1111-4222-8333-944455556666";
const TOKEN_MATI = JSON.stringify({ error: "invalid_token", error_description: `Invalid access token: ${RAHASIA}` });
const SESI_HABIS = JSON.stringify({ s: false, d: ["Data Session Key tidak tepat"] });
const OK = JSON.stringify({ s: true, d: { id: 7 } });

type Panggilan = { url: string; sesi: string | null };
/** fetch palsu: jawab berurutan dari `jawaban` (status, badan); catat url + X-Session-ID tiap panggilan. */
function palsukanFetch(t: TestContext, jawaban: Array<[number, string]>) {
    const panggilan: Panggilan[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
        panggilan.push({ url: String(url), sesi: new Headers(init?.headers).get("X-Session-ID") });
        const [status, badan] = jawaban[Math.min(panggilan.length - 1, jawaban.length - 1)];
        return new Response(badan, { status });
    });
    return panggilan;
}
const kredensial = (segarkanSesi?: AccurateCredentials["segarkanSesi"]): AccurateCredentials =>
    ({ sessionHost: "https://lama.accurate.id", sessionId: "sesi-lama", apiKey: RAHASIA, databaseId: "77", segarkanSesi });
const tanpaRahasia = (e: unknown) => assert.ok(!String((e as Error).message).includes(RAHASIA), "badan 401 (token) bocor ke pesan");

test("tokenMati: dua bentuk badan token mati dikenali; sesi habis bukan token mati", () => {
    assert.equal(tokenMati(TOKEN_MATI), true);
    assert.equal(tokenMati(`Invalid access token: ${RAHASIA}`), true);
    assert.equal(tokenMati(SESI_HABIS), false);
    assert.equal(tokenMati(""), false);
    assert.ok(galat401(TOKEN_MATI) instanceof TokenAccurateMati);
    assert.ok(galat401(SESI_HABIS) instanceof SesiAccurateHabis);
    assert.ok(galat401("<html>") instanceof SesiAccurateHabis, "401 tak dikenal = sesi (dibuka ulang sekali), bukan token");
    tanpaRahasia(galat401(TOKEN_MATI));
});

test("fetchAccurate: token mati -> TokenAccurateMati tanpa buka ulang sesi dan tanpa coba ulang", async (t) => {
    const panggilan = palsukanFetch(t, [[401, TOKEN_MATI]]);
    let dibuka = 0;
    const e = await fetchAccurate(kredensial(async () => { dibuka++; return null; }), "/item/detail.do?id=1").catch((x: unknown) => x);
    assert.ok(e instanceof TokenAccurateMati);
    assert.equal((e as Error).message, PESAN_TOKEN_MATI);
    tanpaRahasia(e);
    assert.equal(panggilan.length, 1);
    assert.equal(dibuka, 0);
});

test("fetchAccurate: sesi habis -> buka ulang sekali, diulang dengan sesi + host baru, creds diperbarui", async (t) => {
    const panggilan = palsukanFetch(t, [[401, SESI_HABIS], [200, OK]]);
    let dibuka = 0;
    const creds = kredensial(async () => {
        dibuka++;
        return { sessionHost: "https://baru.accurate.id", sessionId: "sesi-baru", apiKey: RAHASIA, databaseId: "77" };
    });
    const res = await fetchAccurate(creds, "/item/detail.do?id=1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { s: true, d: { id: 7 } });
    assert.equal(dibuka, 1);
    assert.deepEqual(panggilan, [
        { url: "https://lama.accurate.id/accurate/api/item/detail.do?id=1", sesi: "sesi-lama" },
        { url: "https://baru.accurate.id/accurate/api/item/detail.do?id=1", sesi: "sesi-baru" },
    ]);
    assert.equal(creds.sessionId, "sesi-baru", "halaman/rincian berikutnya memakai sesi baru");
    assert.equal(creds.sessionHost, "https://baru.accurate.id");
});

test("fetchAccurate: sesi tetap ditolak sesudah dibuka ulang / tak bisa dibuka / tanpa pembuka -> SesiAccurateHabis", async (t) => {
    const baru = async () => ({ sessionHost: "https://lama.accurate.id", sessionId: "sesi-baru", apiKey: RAHASIA });
    let panggilan = palsukanFetch(t, [[401, SESI_HABIS]]);
    assert.ok(await fetchAccurate(kredensial(baru), "/x.do").catch((e: unknown) => e) instanceof SesiAccurateHabis);
    assert.equal(panggilan.length, 2, "diulang tepat sekali");

    t.mock.restoreAll();
    panggilan = palsukanFetch(t, [[401, SESI_HABIS]]);
    assert.ok(await fetchAccurate(kredensial(async () => null), "/x.do").catch((e: unknown) => e) instanceof SesiAccurateHabis);
    assert.equal(panggilan.length, 1);

    t.mock.restoreAll();
    panggilan = palsukanFetch(t, [[401, SESI_HABIS]]);
    assert.ok(await fetchAccurate(kredensial(), "/x.do").catch((e: unknown) => e) instanceof SesiAccurateHabis);
    assert.equal(panggilan.length, 1);

    t.mock.restoreAll();
    panggilan = palsukanFetch(t, [[401, SESI_HABIS], [401, TOKEN_MATI]]);
    assert.ok(await fetchAccurate(kredensial(baru), "/x.do").catch((e: unknown) => e) instanceof TokenAccurateMati,
        "sesudah dibuka ulang ternyata token mati");
});

test("fetchAccurate: jawaban selain 401 dikembalikan apa adanya (pemanggil yang menilai)", async (t) => {
    palsukanFetch(t, [[500, "galat"]]);
    const res = await fetchAccurate(kredensial(), "/x.do");
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "galat");
});

test("ambil (laporan principal, stok live): token mati langsung dilempar, tidak dicoba ulang 6 kali seperti galat jaringan", async (t) => {
    const panggilan = palsukanFetch(t, [[401, TOKEN_MATI]]);
    const e = await ambil(kredensial(), "/item/get-stock.do", { no: "A 1", warehouseName: "GD01" }).catch((x: unknown) => x);
    assert.ok(e instanceof TokenAccurateMati);
    tanpaRahasia(e);
    assert.equal(panggilan.length, 1);
    assert.equal(panggilan[0].url, "https://lama.accurate.id/accurate/api/item/get-stock.do?no=A+1&warehouseName=GD01");
});

test("ambil: sesi habis dibuka ulang lalu berhasil", async (t) => {
    palsukanFetch(t, [[401, SESI_HABIS], [200, OK]]);
    const body = await ambil(kredensial(async () => ({ sessionHost: "https://lama.accurate.id", sessionId: "s2", apiKey: RAHASIA })), "/item/detail.do", { id: "1" });
    assert.deepEqual(body.d, { id: 7 });
});

test("bacaAccurate (sesi user: riwayat pelunasan, pelanggan Hendra): 401 dibedakan, badan tidak dibawa", async (t) => {
    const baca = bacaAccurate({ sessionHost: "https://lama.accurate.id", sessionId: "s", accessToken: RAHASIA });
    palsukanFetch(t, [[401, TOKEN_MATI]]);
    const e = await baca("/api/sales-receipt/list.do", "GET", {}).catch((x: unknown) => x);
    assert.ok(e instanceof TokenAccurateMati);
    tanpaRahasia(e);
    t.mock.restoreAll();
    palsukanFetch(t, [[401, SESI_HABIS]]);
    assert.ok(await baca("/api/sales-receipt/list.do", "GET", {}).catch((x: unknown) => x) instanceof SesiAccurateHabis);
});

test("jawaban401 (proxy): amplop ditolak berkode, tanpa badan Accurate", () => {
    const mati = jawaban401(TOKEN_MATI);
    assert.deepEqual(mati, { s: false, d: [PESAN_TOKEN_MATI], error: PESAN_TOKEN_MATI, code: "ACCURATE_TOKEN_MATI" });
    assert.ok(!JSON.stringify(mati).includes(RAHASIA));
    assert.equal(jawaban401(SESI_HABIS).code, "ACCURATE_SESI_HABIS");
    assert.ok(!JSON.stringify(jawaban401(`plain ${RAHASIA}`)).includes(RAHASIA));
});

test("periksaToken (/sesi-accurate, beranda admin): 401 = mati, s:true = hidup, galat lain = tak terperiksa (bukan mati)", async (t) => {
    const coba = async (status: number, badan: string) => {
        t.mock.restoreAll();
        const panggilan = palsukanFetch(t, [[status, badan]]);
        const hasil = await periksaToken(RAHASIA);
        assert.equal(panggilan[0].url, "https://account.accurate.id/api/db-list.do");
        assert.equal(panggilan[0].sesi, null, "lapis akun: tanpa X-Session-ID");
        return hasil;
    };
    assert.equal(await coba(401, TOKEN_MATI), false);
    assert.equal(await coba(200, JSON.stringify({ s: true, d: [] })), true);
    assert.equal(await coba(503, "sibuk"), null);
    assert.equal(await coba(200, "bukan json"), null);
    t.mock.restoreAll();
    t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
    assert.equal(await periksaToken(RAHASIA), null);
});
