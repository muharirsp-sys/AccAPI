// Tujuan: Halaman dashboard untuk membuat dan memantau video BytePlus ModelArk Seedance 2.0.
// Caller: Route Next.js `/seedance` dari SidebarLayout/dashboard.
// Dependensi: FastAPI `/api/seedance/tasks`, browser FileReader, `sonner`, dan ikon `lucide-react`.
// Main Functions: `SeedancePage`, `handleSubmit`, `handlePoll`, `addReference`, `handleReferenceUpload`, `formatApiError`.
// Side Effects: Membaca file upload di browser sebagai data URL dan HTTP call ke backend FastAPI lokal; tidak melakukan DB/file I/O.
"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    AudioLines,
    Clipboard,
    ExternalLink,
    FileVideo,
    ImagePlus,
    Loader2,
    RefreshCcw,
    Sparkles,
    Trash2,
    Upload,
    Video,
} from "lucide-react";
import { toast } from "sonner";

type ReferenceType = "image_url" | "video_url" | "audio_url";
type ReferenceRole = "reference_image" | "first_frame" | "last_frame" | "reference_video" | "reference_audio";

interface ReferenceInput {
    type: ReferenceType;
    role: ReferenceRole;
    url: string;
    fileName?: string;
    fileSize?: number;
}

interface TaskState {
    id?: string;
    status?: string;
    video_url?: string;
    last_frame_url?: string;
    error?: unknown;
    raw?: unknown;
}

interface ApiErrorResponse {
    error?: string;
    detail?: unknown;
    status_code?: number;
}

const BACKEND_BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
const MAX_REFERENCE_UPLOAD_BYTES = 25 * 1024 * 1024;
const AUTO_POLL_INTERVAL_MS = 15000;

const ROLE_OPTIONS: Record<ReferenceType, { value: ReferenceRole; label: string }[]> = {
    image_url: [
        { value: "reference_image", label: "Reference Image" },
        { value: "first_frame", label: "First Frame" },
        { value: "last_frame", label: "Last Frame" },
    ],
    video_url: [{ value: "reference_video", label: "Reference Video" }],
    audio_url: [{ value: "reference_audio", label: "Reference Audio" }],
};

const getErrorMessage = (err: unknown, fallback: string) => {
    return err instanceof Error ? err.message : fallback;
};

const readFileAsDataUrl = (file: File) => {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === "string") resolve(reader.result);
            else reject(new Error("File upload tidak bisa dibaca sebagai data URL."));
        };
        reader.onerror = () => reject(new Error("Gagal membaca file upload."));
        reader.readAsDataURL(file);
    });
};

const acceptForReferenceType = (type: ReferenceType) => {
    if (type === "image_url") return "image/*";
    if (type === "video_url") return "video/*";
    return "audio/*";
};

const formatBytes = (bytes?: number) => {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isTerminalStatus = (status?: string) => {
    return ["succeeded", "failed", "expired", "cancelled"].includes(String(status || "").toLowerCase());
};

const getTaskErrorText = (task: TaskState | null) => {
    if (!task?.error) return "";
    if (typeof task.error === "string") return task.error;
    if (typeof task.error === "object" && "message" in task.error) {
        return String((task.error as { message?: unknown }).message || "");
    }
    return JSON.stringify(task.error);
};

const formatApiError = (res: ApiErrorResponse, fallback: string) => {
    const parts = [];
    if (res.status_code) parts.push(`HTTP ${res.status_code}`);
    if (res.error) parts.push(res.error);
    if (!parts.length && res.detail) parts.push(JSON.stringify(res.detail));
    return parts.join(" - ") || fallback;
};

export default function SeedancePage() {
    const [prompt, setPrompt] = useState(
        "Cinematic product video for a chilled fruit tea bottle on a clean retail table, slow push-in camera, condensation detail, bright natural light, smooth motion, premium commercial style."
    );
    const [model, setModel] = useState("dreamina-seedance-2-0-fast-260128");
    const [ratio, setRatio] = useState("16:9");
    const [duration, setDuration] = useState(5);
    const [resolution, setResolution] = useState("720p");
    const [generateAudio, setGenerateAudio] = useState(true);
    const [watermark, setWatermark] = useState(false);
    const [returnLastFrame, setReturnLastFrame] = useState(false);
    const [draft, setDraft] = useState(false);
    const [references, setReferences] = useState<ReferenceInput[]>([]);
    const [task, setTask] = useState<TaskState | null>(null);
    const [taskIdInput, setTaskIdInput] = useState("");
    const [createError, setCreateError] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [isPolling, setIsPolling] = useState(false);

    const selectedModelSupports1080 = model === "dreamina-seedance-2-0-260128";
    const canSubmit = useMemo(() => prompt.trim().length > 0 && !isCreating, [prompt, isCreating]);

    const addReference = (type: ReferenceType) => {
        const role = ROLE_OPTIONS[type][0].value;
        setReferences([...references, { type, role, url: "" }]);
    };

    const updateReference = (index: number, patch: Partial<ReferenceInput>) => {
        const next = [...references];
        const merged = { ...next[index], ...patch };
        if (patch.type) {
            merged.role = ROLE_OPTIONS[patch.type][0].value;
            merged.url = "";
            merged.fileName = undefined;
            merged.fileSize = undefined;
        }
        next[index] = merged;
        setReferences(next);
    };

    const handleReferenceUpload = async (index: number, file: File | null) => {
        if (!file) return;

        const reference = references[index];
        const expectedPrefix = reference.type.replace("_url", "");
        if (!file.type.startsWith(`${expectedPrefix}/`)) {
            toast.error(`File harus bertipe ${expectedPrefix}.`);
            return;
        }
        if (file.size > MAX_REFERENCE_UPLOAD_BYTES) {
            toast.error(`Ukuran file maksimal ${formatBytes(MAX_REFERENCE_UPLOAD_BYTES)}.`);
            return;
        }

        try {
            const dataUrl = await readFileAsDataUrl(file);
            updateReference(index, { url: dataUrl, fileName: file.name, fileSize: file.size });
            toast.success(`Reference ${file.name} siap dikirim.`);
        } catch (err: unknown) {
            toast.error(getErrorMessage(err, "Gagal membaca file reference."));
        }
    };

    const removeReference = (index: number) => {
        setReferences(references.filter((_, i) => i !== index));
    };

    const handlePoll = useCallback(async (idOverride?: string, quiet = false) => {
        const id = (idOverride || task?.id || taskIdInput).trim();
        if (!id) {
            if (!quiet) toast.error("Task ID belum diisi.");
            return;
        }

        setIsPolling(true);
        try {
            const req = await fetch(`${BACKEND_BASE_URL}/api/seedance/tasks/${encodeURIComponent(id)}`);
            const res = await req.json();
            if (!req.ok || !res.ok) {
                throw new Error(formatApiError(res, "Gagal membaca status task."));
            }
            setCreateError("");
            setTask(res);
            setTaskIdInput(res.id || id);
            if (res.status === "succeeded") {
                toast.success("Video Seedance selesai.");
            } else if (["failed", "expired", "cancelled"].includes(String(res.status || "").toLowerCase())) {
                toast.error(`Task ${res.status}. Cek detail di panel Result.`);
            } else {
                if (!quiet) toast.info(`Status task: ${res.status || "unknown"}`);
            }
        } catch (err: unknown) {
            if (!quiet) toast.error(getErrorMessage(err, "Gagal membaca status task."));
        } finally {
            setIsPolling(false);
        }
    }, [task?.id, taskIdInput]);

    useEffect(() => {
        if (!task?.id || isTerminalStatus(task.status)) return;
        const timer = window.setInterval(() => {
            void handlePoll(task.id, true);
        }, AUTO_POLL_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [handlePoll, task?.id, task?.status]);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setIsCreating(true);
        setTask(null);
        setCreateError("");

        try {
            const payload = {
                prompt,
                model,
                ratio,
                duration,
                resolution,
                generate_audio: generateAudio,
                watermark,
                return_last_frame: returnLastFrame,
                draft,
                references: references.filter((reference) => reference.url.trim()),
            };

            const req = await fetch(`${BACKEND_BASE_URL}/api/seedance/tasks`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const res = await req.json();
            if (!req.ok || !res.ok) {
                throw new Error(formatApiError(res, "Gagal membuat task Seedance."));
            }
            setTask({ id: res.id, raw: res.raw });
            setTaskIdInput(res.id || "");
            toast.success("Task Seedance dibuat.");
            if (res.id) {
                window.setTimeout(() => void handlePoll(res.id, true), 2500);
            }
        } catch (err: unknown) {
            const message = getErrorMessage(err, "Gagal membuat task Seedance.");
            setCreateError(message);
            toast.error(message);
        } finally {
            setIsCreating(false);
        }
    };

    const copyTaskId = async () => {
        if (!task?.id) return;
        await navigator.clipboard.writeText(task.id);
        toast.success("Task ID disalin.");
    };

    return (
        <div className="max-w-7xl mx-auto pb-12">
            <div className="mb-7 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                        <FileVideo className="text-amber-400" />
                        Seedance 2.0 Video Studio
                    </h1>
                    <p className="text-slate-400 mt-2 text-sm">
                        BytePlus ModelArk video task creator dengan polling hasil dari backend lokal.
                    </p>
                </div>
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs font-semibold text-amber-200">
                    ModelArk AP Southeast
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)] gap-5">
                <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-white/10 bg-[#1a1c23]/70 p-5 shadow-xl">
                    {createError && (
                        <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="mt-0.5 shrink-0 text-red-300" size={18} />
                                <div>
                                    <div className="font-bold">Create task gagal</div>
                                    <div className="mt-1 break-words text-red-100/80">{createError}</div>
                                </div>
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Prompt</label>
                        <textarea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            rows={8}
                            className="w-full resize-y rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-sm leading-6 text-white outline-none transition-colors focus:border-amber-400/50"
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="md:col-span-2">
                            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Model</label>
                            <select
                                value={model}
                                onChange={(event) => {
                                    setModel(event.target.value);
                                    if (event.target.value.includes("fast") && resolution === "1080p") setResolution("720p");
                                }}
                                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm text-slate-200 outline-none focus:border-amber-400/50"
                            >
                                <option value="dreamina-seedance-2-0-fast-260128">Seedance 2.0 Fast</option>
                                <option value="dreamina-seedance-2-0-260128">Seedance 2.0</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Ratio</label>
                            <select value={ratio} onChange={(event) => setRatio(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm text-slate-200 outline-none focus:border-amber-400/50">
                                {["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].map((item) => <option key={item} value={item}>{item}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Duration</label>
                            <input type="number" min={1} max={30} value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm text-white outline-none focus:border-amber-400/50" />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Resolution</label>
                            <select value={resolution} onChange={(event) => setResolution(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm text-slate-200 outline-none focus:border-amber-400/50">
                                <option value="480p">480p</option>
                                <option value="720p">720p</option>
                                {selectedModelSupports1080 && <option value="1080p">1080p</option>}
                            </select>
                        </div>
                        {[
                            ["Audio", generateAudio, setGenerateAudio],
                            ["Watermark", watermark, setWatermark],
                            ["Last Frame", returnLastFrame, setReturnLastFrame],
                            ["Draft", draft, setDraft],
                        ].map(([label, value, setter]) => (
                            <label key={String(label)} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-sm font-semibold text-slate-300">
                                <span>{String(label)}</span>
                                <input type="checkbox" checked={Boolean(value)} onChange={(event) => (setter as (next: boolean) => void)(event.target.checked)} className="h-4 w-4 accent-amber-500" />
                            </label>
                        ))}
                    </div>

                    <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">References</h2>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" onClick={() => addReference("image_url")} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:border-amber-400/40">
                                    <ImagePlus size={14} /> Image
                                </button>
                                <button type="button" onClick={() => addReference("video_url")} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:border-amber-400/40">
                                    <Video size={14} /> Video
                                </button>
                                <button type="button" onClick={() => addReference("audio_url")} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:border-amber-400/40">
                                    <AudioLines size={14} /> Audio
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3">
                            {references.length === 0 && (
                                <div className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm text-slate-500">
                                    Tidak ada reference asset.
                                </div>
                            )}
                            {references.map((reference, index) => (
                                <div key={index} className="grid grid-cols-1 lg:grid-cols-[130px_160px_minmax(0,1fr)_110px_40px] gap-2">
                                    <select value={reference.type} onChange={(event) => updateReference(index, { type: event.target.value as ReferenceType })} className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none">
                                        <option value="image_url">Image</option>
                                        <option value="video_url">Video</option>
                                        <option value="audio_url">Audio</option>
                                    </select>
                                    <select value={reference.role} onChange={(event) => updateReference(index, { role: event.target.value as ReferenceRole })} className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none">
                                        {ROLE_OPTIONS[reference.type].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                    </select>
                                    <input
                                        value={reference.fileName ? `Uploaded: ${reference.fileName} (${formatBytes(reference.fileSize)})` : reference.url}
                                        readOnly={Boolean(reference.fileName)}
                                        onChange={(event) => updateReference(index, { url: event.target.value, fileName: undefined, fileSize: undefined })}
                                        placeholder="https://... atau upload file"
                                        className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400/50 read-only:text-amber-100"
                                    />
                                    <label className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 text-xs font-bold text-amber-200 hover:bg-amber-400/15">
                                        <Upload size={14} />
                                        Upload
                                        <input
                                            type="file"
                                            accept={acceptForReferenceType(reference.type)}
                                            className="hidden"
                                            onChange={(event) => {
                                                void handleReferenceUpload(index, event.target.files?.[0] || null);
                                                event.target.value = "";
                                            }}
                                        />
                                    </label>
                                    <button type="button" onClick={() => removeReference(index)} className="flex h-10 items-center justify-center rounded-lg border border-white/10 text-slate-500 hover:border-red-400/40 hover:text-red-300">
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={!canSubmit}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold text-black shadow-lg shadow-amber-500/10 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isCreating ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                        Create Video Task
                    </button>
                </form>

                <section className="space-y-5">
                    <div className="rounded-lg border border-white/10 bg-[#1a1c23]/70 p-5 shadow-xl">
                        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 mb-4">Task Monitor</h2>
                        <div className="flex gap-2">
                            <input value={taskIdInput} onChange={(event) => setTaskIdInput(event.target.value)} placeholder="cgt-..." className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm text-white outline-none focus:border-amber-400/50" />
                            <button type="button" onClick={() => handlePoll()} disabled={isPolling} className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm font-bold text-amber-200 hover:bg-amber-400/15 disabled:opacity-60">
                                {isPolling ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
                                Poll
                            </button>
                        </div>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-[#1a1c23]/70 p-5 shadow-xl">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">Result</h2>
                            {task?.id && (
                                <button type="button" onClick={copyTaskId} className="rounded-md p-2 text-slate-400 hover:bg-white/10 hover:text-white" title="Copy task ID">
                                    <Clipboard size={16} />
                                </button>
                            )}
                        </div>

                        {!task && <div className="rounded-lg border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">Belum ada task.</div>}

                        {task && (
                            <div className="space-y-4">
                                {["failed", "expired", "cancelled"].includes(String(task.status || "").toLowerCase()) && (
                                    <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">
                                        <div className="flex items-start gap-3">
                                            <AlertTriangle className="mt-0.5 shrink-0 text-red-300" size={18} />
                                            <div>
                                                <div className="font-bold">Task {task.status}</div>
                                                <div className="mt-1 text-red-100/80">
                                                    {getTaskErrorText(task) || "BytePlus mengembalikan status gagal tanpa pesan detail. Buka Raw Response untuk payload lengkap."}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {!isTerminalStatus(task.status) && task.id && (
                                    <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs font-semibold text-amber-100">
                                        Auto-poll aktif tiap 15 detik. Status terakhir tetap bisa dicek manual lewat tombol Poll.
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-3 text-sm">
                                    <div className="rounded-lg bg-black/30 p-3">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Task ID</div>
                                        <div className="mt-1 break-all font-mono text-slate-200">{task.id || "-"}</div>
                                    </div>
                                    <div className="rounded-lg bg-black/30 p-3">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Status</div>
                                        <div className="mt-1 font-semibold text-amber-200">{task.status || "created"}</div>
                                    </div>
                                </div>

                                {task.video_url && (
                                    <div className="overflow-hidden rounded-lg border border-white/10 bg-black">
                                        <video src={task.video_url} controls className="w-full" />
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2">
                                    {task.video_url && (
                                        <a href={task.video_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-400/15">
                                            <ExternalLink size={14} /> Open Video
                                        </a>
                                    )}
                                    {task.last_frame_url && (
                                        <a href={task.last_frame_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs font-bold text-sky-200 hover:bg-sky-400/15">
                                            <ExternalLink size={14} /> Last Frame
                                        </a>
                                    )}
                                </div>

                                <details className="rounded-lg border border-white/10 bg-black/30 p-3">
                                    <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-slate-400">Raw Response</summary>
                                    <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify(task.raw || task, null, 2)}</pre>
                                </details>
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
