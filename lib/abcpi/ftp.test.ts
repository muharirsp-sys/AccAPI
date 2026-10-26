/* Kunci: klien FTP minimal mengunggah isi utuh lewat PASV dan gagal keras bila login ditolak (server palsu lokal). */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { unggahFtp } from "./ftp.ts";

function serverPalsu(tolakPass = false, jawabSize = "") {
    const diterima: Record<string, Buffer> = {};
    const perintah: string[] = [];
    const srv = net.createServer((c) => {
        let data: net.Server | null = null, isi: Buffer[] = [], nama = "";
        c.write("220-Selamat datang\r\n220 siap\r\n");
        let sisa = "";
        c.on("data", (d) => {
            sisa += d.toString();
            for (let i = sisa.indexOf("\r\n"); i >= 0; i = sisa.indexOf("\r\n")) {
                const baris = sisa.slice(0, i); sisa = sisa.slice(i + 2);
                const [cmd, ...arg] = baris.split(" ");
                perintah.push(cmd);
                if (cmd === "USER") c.write("331 password\r\n");
                else if (cmd === "PASS") c.write(tolakPass ? "530 Login incorrect\r\n" : "230 ok\r\n");
                else if (cmd === "TYPE" || cmd === "CWD") c.write("200 ok\r\n");
                else if (cmd === "PASV") {
                    data = net.createServer((s) => { isi = []; s.on("data", (x) => isi.push(x)); s.on("end", () => { diterima[nama] = Buffer.concat(isi); c.write("226 selesai\r\n"); data?.close(); }); });
                    data.listen(0, "127.0.0.1", () => { const p = (data!.address() as net.AddressInfo).port; c.write(`227 Entering Passive Mode (10,0,0,9,${p >> 8},${p & 255})\r\n`); });
                } else if (cmd === "STOR") { nama = arg.join(" "); c.write("150 buka data\r\n"); }
                else if (cmd === "SIZE") c.write(jawabSize ? `${jawabSize}\r\n` : `213 ${diterima[arg.join(" ")]?.length ?? 0}\r\n`);
                else if (cmd === "QUIT") { c.write("221 bye\r\n"); c.end(); }
            }
        });
    });
    return new Promise<{ port: number; diterima: typeof diterima; perintah: string[]; tutup: () => void }>((ok) =>
        srv.listen(0, "127.0.0.1", () => ok({ port: (srv.address() as net.AddressInfo).port, diterima, perintah, tutup: () => srv.close() })));
}

test("unggah dua berkas: isi tiba utuh, IP PASV diabaikan, SIZE dicek", async () => {
    const s = await serverPalsu();
    const a = Buffer.from("DistID|NoOrder\r\nSP|INV/1\r\n"), b = Buffer.alloc(200_000, 7);
    const hasil = await unggahFtp({ host: "127.0.0.1", port: s.port, user: "u", password: "p", dir: "/abc/x/" }, [{ nama: "SP_1_SALES.csv", isi: a }, { nama: "SP_1_STOCK.csv", isi: b }], 5000);
    s.tutup();
    assert.deepEqual(hasil.map((h) => h.bytes), [a.length, b.length]);
    assert.ok(s.diterima["SP_1_SALES.csv"].equals(a));
    assert.ok(s.diterima["SP_1_STOCK.csv"].equals(b));
    assert.deepEqual(s.perintah.slice(0, 4), ["USER", "PASS", "TYPE", "CWD"]);
});

test("SIZE 550 sesudah STOR = galat (berkas tidak terbukti ada)", async () => {
    const s = await serverPalsu(false, "550 No such file");
    await assert.rejects(unggahFtp({ host: "127.0.0.1", port: s.port, user: "u", password: "p" }, [{ nama: "hilang", isi: Buffer.from("1") }], 5000), /tidak terbukti/);
    s.tutup();
});

test("login ditolak = galat, tidak diam", async () => {
    const s = await serverPalsu(true);
    await assert.rejects(unggahFtp({ host: "127.0.0.1", port: s.port, user: "u", password: "salah" }, [{ nama: "x", isi: Buffer.from("1") }], 5000), /530/);
    s.tutup();
});
