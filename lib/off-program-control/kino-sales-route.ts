const MAX_FILE_BYTES = 10 * 1024 * 1024;
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "",
]);
export const CSV_MIME_TYPES = [
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
  "application/octet-stream",
  "",
] as const;
const FIELDS = ["accurateFile", "principalFile"] as const;

type UploadContract =
  | { kind: "xlsx" }
  | {
      kind: "csv";
      extensions?: readonly string[];
      mimeTypes?: readonly string[];
    };

export class UploadError extends Error {
  readonly status: 400 | 413 | 422;
  constructor(message: string, status: 400 | 413 | 422) {
    super(message);
    this.status = status;
  }
}

function validateFile(
  value: FormDataEntryValue,
  field: string,
  contract: UploadContract,
): File {
  if (!(value instanceof File))
    throw new UploadError(`${field} wajib berupa file.`, 400);
  const extensions =
      contract.kind === "csv" ? (contract.extensions ?? [".csv"]) : [".xlsx"],
    mimeTypes =
      contract.kind === "csv"
        ? new Set(contract.mimeTypes ?? CSV_MIME_TYPES)
        : XLSX_MIMES;
  if (!extensions.some((extension) => value.name.toLowerCase().endsWith(extension)))
    throw new UploadError(`${field} harus berupa ${extensions.join(" atau ")}.`, 400);
  if (!mimeTypes.has(value.type))
    throw new UploadError(
      `${field} memiliki tipe file yang tidak didukung.`,
      400,
    );
  if (!value.size && contract.kind === "xlsx")
    throw new UploadError(`${field} kosong.`, 400);
  if (value.size > MAX_FILE_BYTES)
    throw new UploadError(`${field} melebihi batas 10 MB.`, 413);
  return value;
}

export function validateUploadForm(
  form: FormData,
  principalUpload: UploadContract = { kind: "xlsx" },
): [File, File] {
  for (const key of form.keys())
    if (!(FIELDS as readonly string[]).includes(key))
      throw new UploadError(`Field upload tidak dikenal: ${key}.`, 400);
  return FIELDS.map((key) => {
    const values = form.getAll(key);
    if (values.length !== 1)
      throw new UploadError(`${key} wajib diunggah tepat satu kali.`, 400);
    return validateFile(
      values[0],
      key === "accurateFile" ? "File Accurate" : "File SALES_DETAIL",
      key === "accurateFile" ? { kind: "xlsx" } : principalUpload,
    );
  }) as [File, File];
}

export function safeParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const shinzuiHeaders = [
      "KODE PCPL",
      "KODE BARANG WIN2",
      "SATUAN FIX WIN",
      "ISI/CTN",
      "INV NUM",
      "INV DATE",
      "ID PRODUK",
      "ID PELANGGAN",
      "ID SALES",
      "TIPE PENJUALAN",
      "QTY TRX-INV",
      "QTY SMALL",
      "HARGA",
      "VALUE EXCL DISC",
      "DISC 1 INV",
      "DISC 2A INV",
      "DISC 2B (PROMO DIST.) INV",
      "DISC 2B (MANUAL) INV",
      "DISC 3 INV",
      "DISC 4 (PROMO DIST.) INV",
      "DISC 4 (MANUAL) INV",
      "DISC 5 INV",
      "TOTAL DISC INV",
      "DPP INV",
      "PPN INV",
      "TOTAL INV",
    ]
      .map((header) => header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    shinzuiMessage = new RegExp(
      `^(?:Header wajib tidak ditemukan: (?:${shinzuiHeaders})(?:, (?:${shinzuiHeaders}))*|(?:${shinzuiHeaders}) (?:kosong|negatif|tidak valid|terlalu besar) pada baris \\d+|INV NUM harus memuat tepat satu nomor invoice pada baris \\d+|ISI/CTN (?:tidak valid|harus positif) pada baris \\d+|TIPE PENJUALAN tidak valid pada baris \\d+|Tanda transaksi (?:JUAL|PROMO|RETUR) tidak valid pada baris \\d+|(?:Value Excl Disc|Total Disc Inv|DPP Inv|PPN Inv|Total Inv) tidak konsisten pada baris \\d+)$`,
    );
  const motasaHeaders = [
      "TIPE", "NO.INV", "TGL.INV", "CODE CUST", "CODE SALES",
      "KODE PRODUK", "PRD_QTY", "SATUAN", "HARGA", "DISC. 1",
      "DISC. 2", "DISC. 3", "DISC. 4", "DISC. 5", "FIX DISC. VALUE",
      "KODE BARANG WIN2", "ISI/CTN", "SATUAN FIX WIN",
    ]
      .map((header) => header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    motasaMessage = new RegExp(
      `^(?:Header wajib tidak ditemukan: (?:${motasaHeaders})(?:, (?:${motasaHeaders}))*|No\\.INV harus memuat tepat satu nomor order pada baris \\d+|Tipe harus SD pada baris \\d+|(?:DISC\\. [1-5]) (?:tidak valid|terlalu besar|harus antara 0 dan 100) pada baris \\d+|(?:PRD_QTY|Harga|FIX DISC\\. VALUE|Gross MOTASA|DPP MOTASA) (?:negatif|tidak valid|terlalu besar) pada baris \\d+|(?:PRD_QTY|HARGA|NO\\.INV|CODE CUST|CODE SALES|KODE PRODUK|SATUAN) kosong pada baris \\d+|TGL\\.INV tidak valid pada baris \\d+|DPP MOTASA negatif pada baris \\d+|KODE BARANG WIN2 kosong pada baris \\d+)$`,
    );
  const cussonsHeaders = [
      "INVOICE NO", "CUSTOMER CODE", "ROUTE CODE", "PRODUCT CODE",
      "PRODUCT DESCRIPTION", "UOM CODE", "SELLING TYPE", "PRODUCT QUANTITY",
      "UOM LIST PRICE", "GROSS AMOUNT", "DISCOUNT AMOUNT",
      "AMOUNT AFTER SKU DISC", "CUSTOMER DISCOUNT", "TOTAL TAX AMOUNT",
      "TOTAL NET AMOUNT", "TAX CODE", "TAX PERCENTAGE 1", "KODE PCPL",
      "ISI/CTN", "SATUAN FIX WIN", "KODE BARANG WIN2",
    ]
      .map((header) => header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    cussonsMessage = new RegExp(
      `^(?:File CSV kosong|Header wajib tidak ditemukan: (?:${cussonsHeaders})(?:, (?:${cussonsHeaders}))*|(?:${cussonsHeaders}) (?:kosong|negatif|tidak valid|terlalu besar) pada baris \\d+|Invoice No baris \\d+ harus memiliki tepat satu nomor faktur TI)$`,
      "i",
    );
  return /^(?:File (?:XLSX|mapping) kosong|Sheet (?:mapping )?[\w ]+ tidak ditemukan atau kosong|Header wajib tidak ditemukan: [\w, ]+|(?:[\w_]+ (?:kosong|negatif|tidak valid|terlalu besar)|[\w_]+ harus [\w/ ]+|[\w_]+ harus memuat tepat satu nomor order) pada baris \d+|Mapping_[\w]+ (?:tidak lengkap pada baris \d+|memiliki mapping konflik untuk [\w.-]+)|Pvt Map 1 tidak lengkap pada baris \d+|(?:IV_DISC|IV_PPN|IV_STAMP|IV_DISREG|IV_DISADD|IV_DISCASH|IV_TOTDISC|IV_DISC2|IV_DISVALUE) belum memiliki aturan pada baris \d+|Nilai GDI tidak valid pada baris \d+)$/.test(error.message) ||
    shinzuiMessage.test(error.message) ||
    motasaMessage.test(error.message) ||
    cussonsMessage.test(error.message)
    ? error.message
    : null;
}

interface HandlerDependencies {
  authorize(request: Request): Promise<Response | null>;
  readMapping(): Promise<Uint8Array>;
  reconcile(
    accurate: Uint8Array,
    principal: Uint8Array,
    mapping: Uint8Array,
  ): unknown;
  missingMappingMessage?: string;
  principalUpload?: UploadContract;
}

function isZip(value: Uint8Array): boolean {
  return value.length >= 4 && value[0] === 0x50 && value[1] === 0x4b;
}

export function createKinoSalesPostHandler(deps: HandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    const denied = await deps.authorize(request);
    if (denied) return denied;
    try {
      const [accurateFile, principalFile] = validateUploadForm(
        await request.formData().catch(() => {
          throw new UploadError("Form upload tidak valid.", 400);
        }),
        deps.principalUpload,
      );
      const [accurate, principal] = await Promise.all([
        accurateFile.arrayBuffer(),
        principalFile.arrayBuffer(),
      ]).then((values) => values.map((value) => new Uint8Array(value)));
      if (
        !isZip(accurate) ||
        (deps.principalUpload?.kind !== "csv" && !isZip(principal))
      )
        throw new UploadError(
          "File upload bukan workbook XLSX yang valid.",
          422,
        );
      if (deps.principalUpload?.kind === "csv") {
        if (!principal.length) throw new UploadError("File CSV kosong", 422);
        if (principal.includes(0))
          throw new UploadError("File CSV mengandung karakter NUL.", 422);
      }
      const mapping = await deps.readMapping();
      return Response.json(deps.reconcile(accurate, principal, mapping));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return Response.json(
          {
            error:
              deps.missingMappingMessage ??
              "Master mapping KINO tidak tersedia.",
          },
          { status: 500 },
        );
      const parserMessage = safeParserMessage(error);
      return Response.json(
        {
          error:
            error instanceof UploadError
              ? error.message
              : (parserMessage ?? "Rekonsiliasi gagal diproses."),
        },
        {
          status:
            error instanceof UploadError
              ? error.status
              : parserMessage
                ? 422
                : 500,
        },
      );
    }
  };
}
