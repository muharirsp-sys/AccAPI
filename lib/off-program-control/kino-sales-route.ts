import { createHash } from "node:crypto";
import { getReconciliationConfig, RECONCILIATION_CONFIG } from "./reconciliation-config";
import type {
  ReconciliationActor,
  ReconciliationInputFile,
  ReconciliationIssue,
} from "./reconciliation-store";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 30 * 1024 * 1024;
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
const TWO_FILE_FIELDS = ["accurateFile", "principalFile"] as const;
const THREE_FILE_FIELDS = [
  "accurateFile",
  "headerFile",
  "principalFile",
] as const;

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
  headerUpload?: UploadContract,
): [File, File] | [File, File, File] {
  const fields = headerUpload ? THREE_FILE_FIELDS : TWO_FILE_FIELDS;
  for (const key of form.keys())
    if (!(fields as readonly string[]).includes(key))
      throw new UploadError(`Field upload tidak dikenal: ${key}.`, 400);
  return fields.map((key) => {
    const values = form.getAll(key);
    if (values.length !== 1)
      throw new UploadError(`${key} wajib diunggah tepat satu kali.`, 400);
    return validateFile(
      values[0],
      key === "accurateFile"
        ? "File Accurate"
        : key === "headerFile"
          ? "File HEADER"
          : "File SALES_DETAIL",
      key === "accurateFile"
        ? { kind: "xlsx" }
        : key === "headerFile"
          ? headerUpload!
          : principalUpload,
    );
  }) as [File, File] | [File, File, File];
}

export function safeParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const kinoHeaders = [
      "NO_NOTA",
      "TANGGAL",
      "KODE PELANGGAN INDUK",
      "KODE_SALESMAN",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "SATUAN_KECIL",
      "NILAI JUAL",
      "POTONGAN",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
      "CUSTCODE1",
      "CUSTCODE2",
      "ORDER_NO",
      "INVOICE_NO",
      "INVOICE_DATE",
      "PRODUCT_CODE",
      "SALESMAN_ID",
      "FLAG_BONUS",
      "INVOICE_QTY",
      "INVOICE_GROSS",
      "INVOICE_TOTALLINEDISC",
      "INVOICE_PROMO",
      "INVOICE_CASHDISC",
      "INVOICE_TAX",
      "INVOICE_NET",
      "INVOICE_TYPE",
      "PRD_UOM1",
      "KODE PCPL",
      "KODE BARANG WIN",
      "KODE BARANG",
      "PCPL KODE 1",
      "PCPL KODE 2",
      "PCPL KODE 3",
      "PCPL KODE 4",
      "PCPL KODE 5",
      "IV_NO",
      "IV_DATE",
      "CS_NO",
      "PS_NO",
      "INV_NO",
      "IV_TOTPCS",
      "IV_PRICE",
      "IV_DISC1",
      "IV_FRA",
      "KODE ITEM",
      "KODE ALIAS",
      "SATUAN",
      "CODE KINO",
      "CODE INTERNAL",
      "SLSMAN_ID",
    ],
    shinzuiHeaders = [
      "KODE PCPL",
      "KODE BARANG WIN2",
      "SATUAN FIX WIN",
      "ISI/CTN",
      "INV NUM",
      "INV DATE",
      "ID PRODUK",
      "ID PELANGGAN",
      "ID PELANGGAN LAMA",
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
    ),
    returnMessage =
      /^(?:File XLSX rusak atau tidak valid\.|(?:KODE PELANGGAN INDUK|KODE BARANG|INV NUM|ID PRODUK|ID PELANGGAN LAMA) kosong pada baris \d+|(?:QTY SMALL|DPP INV|PPN INV|TOTAL INV) tidak valid pada baris \d+|REM harus memuat tepat satu nomor invoice pada baris \d+|Mapping KODE BARANG ambigu pada baris \d+|(?:KODE PELANGGAN INDUK|SALE RETURN NO\.|CUSTOMER) harus memuat tepat satu token pada baris \d+|(?:Quantity\(Units\)|Amount) (?:kosong|tidak valid) pada baris \d+|Mapping produk GODREJ konflik: [A-Z0-9._/-]+(?:, [A-Z0-9._/-]+)*|line_count harus bilangan bulat non-negatif pada baris \d+)$/;
  const headerMatch = /^Header wajib tidak ditemukan: (.+)$/.exec(error.message),
    knownHeaders = new Set([
      ...kinoHeaders,
      "SALE RETURN NO.",
      "CUSTOMER",
      "SKUNIT",
      "QUANTITY(UNITS)",
      "AMOUNT",
      "SALE RETURN STATE",
      "CREDIT_NOTE_NUMBER",
      "GOODS_RETURN_NOTE_NUMBER",
      "SALES_REPRESENTATIVE_CODE",
      "RETAILER_CODE",
      "RETAILER_NAME",
      "CREDIT_NOTE_DATE",
      "INVOICE_NUMBER",
      "REMARKS",
      "LINE_COUNT",
      "NET_VALUE",
      "STATUS",
      "LINE_NUMBER",
      "DISTRIBUTOR_STOCK_KEEPING_UNIT",
      "UNIT_QUANTITY",
      "UNIT",
      "EACHES_QUANTITY",
      "UNIT_PRICE",
      "GROSS_VALUE",
      "RETURN_CODE",
      "CREDIT NOTE NO",
      "CUSTOMER CODE",
      "ROUTE CODE",
      "PRODUCT CODE",
      "PRODUCT DESCRIPTION",
      "UOM CODE",
      "SELLING TYPE",
      "PRD QTY",
      "UOM LIST PRICE",
      "GROSS AMOUNT",
      "DISCOUNT AMOUNT",
      "TOTAL AMOUNT AFTER SKU",
      "CUSTOMER DISCOUNT AMOUNT",
      "TOTAL TAX AMOUNT",
      "TOTAL NET AMOUNT",
      "TAX CODE",
      "TAX PERCENTAGE 1",
    ]),
    safeHeaderMessage =
      headerMatch?.[1]
        .split(", ")
        .every((header) => knownHeaders.has(header)) === true;
  return /^(?:File (?:XLSX|mapping) kosong|Sheet (?:mapping )?[\w ]+ tidak ditemukan atau kosong|(?:[\w_]+ (?:kosong|negatif|tidak valid|terlalu besar)|[\w_]+ harus [\w/ ]+|[\w_]+ harus memuat tepat satu nomor order) pada baris \d+|Mapping_[\w]+ (?:tidak lengkap pada baris \d+|memiliki mapping konflik untuk [\w.-]+)|Pvt Map 1 tidak lengkap pada baris \d+|(?:IV_DISC|IV_PPN|IV_STAMP|IV_DISREG|IV_DISADD|IV_DISCASH|IV_TOTDISC|IV_DISC2|IV_DISVALUE) belum memiliki aturan pada baris \d+|Nilai GDI tidak valid pada baris \d+)$/.test(error.message) ||
    safeHeaderMessage ||
    shinzuiMessage.test(error.message) ||
    motasaMessage.test(error.message) ||
    cussonsMessage.test(error.message) ||
    returnMessage.test(error.message)
    ? error.message
    : null;
}

type ReconciliationOutput = {
  summary: Record<string, number>;
  results: ReconciliationIssue[];
};

interface CommonHandlerDependencies {
  reconciliationKey?: keyof typeof RECONCILIATION_CONFIG;
  authorize(request: Request): Promise<
    | Response
    | null
    | { response: Response | null; actor: ReconciliationActor | null }
  >;
  readMapping(): Promise<
    { id: string; workbook: Uint8Array } | Uint8Array | null
  >;
  startReconciliationRun?(input: {
    division: "sales" | "purchases" | "returns";
    principalCode: string;
    mappingVersionId: string;
    actor: ReconciliationActor;
    inputFiles: ReconciliationInputFile[];
  }): Promise<string>;
  completeReconciliationRun?(
    id: string,
    output: ReconciliationOutput,
    durationMs: number,
  ): Promise<void>;
  failReconciliationRun?(
    id: string,
    error: string,
    durationMs: number,
  ): Promise<void>;
  missingMappingMessage?: string;
  principalUpload?: UploadContract;
  safeParserMessage?: (error: unknown) => string | null;
}

interface TwoFileHandlerDependencies extends CommonHandlerDependencies {
  headerUpload?: undefined;
  reconcile(
    accurate: Uint8Array,
    principal: Uint8Array,
    mapping: Uint8Array,
    principalFilename: string,
  ): unknown;
}

interface ThreeFileHandlerDependencies extends CommonHandlerDependencies {
  headerUpload: UploadContract;
  reconcile(
    accurate: Uint8Array,
    header: Uint8Array,
    principal: Uint8Array,
    mapping: Uint8Array,
  ): unknown;
}

type HandlerDependencies =
  | TwoFileHandlerDependencies
  | ThreeFileHandlerDependencies;

function isZip(value: Uint8Array): boolean {
  return value.length >= 4 && value[0] === 0x50 && value[1] === 0x4b;
}

export function createKinoSalesPostHandler(deps: HandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    let authorization: {
      response: Response | null;
      actor: ReconciliationActor | null;
    };
    try {
      const result = await deps.authorize(request);
      authorization = result instanceof Response || result === null
        ? { response: result, actor: null }
        : result;
    } catch {
      return Response.json(
        { error: "Rekonsiliasi gagal diproses." },
        { status: 500 },
      );
    }
    if (authorization.response) return authorization.response;
    const audited = Boolean(
      deps.reconciliationKey &&
      deps.startReconciliationRun &&
      deps.completeReconciliationRun &&
      deps.failReconciliationRun,
    );
    if (audited && !authorization.actor)
      return Response.json(
        { error: "Rekonsiliasi gagal diproses." },
        { status: 500 },
      );
    const config = getReconciliationConfig(
      ...((deps.reconciliationKey ?? "sales:KINO").split(":") as [
        "sales" | "purchases" | "returns",
        string,
      ]),
    );
    const startedAt = Date.now();
    let runId: string | null = null;
    try {
      const files = validateUploadForm(
        await request.formData().catch(() => {
          throw new UploadError("Form upload tidak valid.", 400);
        }),
        deps.principalUpload,
        deps.headerUpload,
      );
      if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_FILE_BYTES)
        throw new UploadError("Total file upload melebihi batas 30 MB.", 413);
      const buffers = await Promise.all(
        files.map((file) => file.arrayBuffer()),
      ).then((values) => values.map((value) => new Uint8Array(value)));
      const [accurate] = buffers;
      if (
        !isZip(accurate) ||
        (!deps.headerUpload &&
          deps.principalUpload?.kind !== "csv" &&
          !isZip(buffers[1]))
      )
        throw new UploadError(
          "File upload bukan workbook XLSX yang valid.",
          422,
        );
      const csvBuffers = deps.headerUpload
        ? buffers.slice(1)
        : deps.principalUpload?.kind === "csv"
          ? buffers.slice(1)
          : [];
      for (const csv of csvBuffers) {
        if (!csv.length) throw new UploadError("File CSV kosong", 422);
        if (csv.includes(0))
          throw new UploadError("File CSV mengandung karakter NUL.", 422);
      }
      const mappingResult = await deps.readMapping();
      const mapping = mappingResult instanceof Uint8Array
        ? { id: "legacy", workbook: mappingResult }
        : mappingResult;
      if (!mapping)
        throw new UploadError(
          deps.missingMappingMessage ??
            `Master mapping ${config.principal} untuk divisi ${config.division} tidak tersedia.`,
          422,
        );
      const inputFiles = files.map((file, index) => ({
        role: (deps.headerUpload ? THREE_FILE_FIELDS : TWO_FILE_FIELDS)[index],
        name: file.name,
        mimeType: file.type,
        byteSize: file.size,
        sha256: createHash("sha256").update(buffers[index]).digest("hex"),
      }));
      if (audited)
        runId = await deps.startReconciliationRun!({
          division: config.division,
          principalCode: config.principal,
          mappingVersionId: mapping.id,
          actor: authorization.actor!,
          inputFiles,
        });
      const output = (
        deps.headerUpload
          ? deps.reconcile(
              accurate,
              buffers[1],
              buffers[2],
              mapping.workbook,
            )
          : deps.reconcile(
              accurate,
              buffers[1],
              mapping.workbook,
              files[1].name,
            )
      ) as ReconciliationOutput;
      if (runId)
        await deps.completeReconciliationRun!(runId, output, Date.now() - startedAt);
      return Response.json(output);
    } catch (error) {
      if (runId)
        try {
          await deps.failReconciliationRun!(
            runId,
            error instanceof Error ? error.message : "Rekonsiliasi gagal diproses.",
            Date.now() - startedAt,
          );
        } catch {
          return Response.json(
            { error: "Rekonsiliasi gagal diproses." },
            { status: 500 },
          );
        }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return Response.json(
          { error: deps.missingMappingMessage ?? "Master mapping KINO tidak tersedia." },
          { status: 500 },
        );
      const parserMessage =
        safeParserMessage(error) ?? deps.safeParserMessage?.(error) ?? null;
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
