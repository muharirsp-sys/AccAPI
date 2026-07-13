import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { authorizeThenProcess, safeParserMessage, UploadError, validateUploadForm } from "@/lib/off-program-control/kino-sales-route";
import { reconcileKinoSales } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

async function processUpload(request: Request): Promise<Response> {
  try {
    const [accurateFile, principalFile] = validateUploadForm(await request.formData());
    const [accurate, principal, mapping] = await Promise.all([
      accurateFile.arrayBuffer().then((value) => Buffer.from(value)),
      principalFile.arrayBuffer().then((value) => Buffer.from(value)),
      readFile(path.join(process.cwd(), "data", "reconciliation", "Kino.xlsx")),
    ]);
    if (!isZip(accurate) || !isZip(principal)) throw new UploadError("File upload bukan workbook XLSX yang valid.", 422);
    return NextResponse.json(reconcileKinoSales(accurate, principal, mapping, { valueTolerance: 1 }));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({ error: "Master mapping KINO tidak tersedia." }, { status: 500 });
    }
    const parserMessage = safeParserMessage(error);
    return NextResponse.json(
      { error: error instanceof UploadError ? error.message : parserMessage ?? "Rekonsiliasi gagal diproses." },
      { status: error instanceof UploadError ? error.status : parserMessage ? 422 : 500 },
    );
  }
}

export async function POST(request: Request) {
  return authorizeThenProcess(request, async (candidate) => (await requirePermission(candidate, "reconciliation.run")).response, processUpload);
}