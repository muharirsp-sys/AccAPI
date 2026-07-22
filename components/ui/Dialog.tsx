/*
 * Tujuan: Primitive modal native yang memberi focus trap, Escape, backdrop, dan focus restoration konsisten.
 * Caller: Overlay dashboard seperti CameraCapture, Payments, API Wrapper, dan workflow operasional lain.
 * Dependensi: React hooks dan elemen HTML `<dialog>` native.
 * Main Functions: `Dialog`.
 * Side Effects: Memanggil `showModal()`/`close()` pada DOM dan meneruskan permintaan tutup ke caller.
 */

"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

type DialogProps = {
    open: boolean;
    onClose: () => void;
    labelledBy: string;
    describedBy?: string;
    children: ReactNode;
    className?: string;
    closeOnBackdrop?: boolean;
};

export default function Dialog({
    open,
    onClose,
    labelledBy,
    describedBy,
    children,
    className = "",
    closeOnBackdrop = false,
}: DialogProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();

        return () => {
            if (dialog.open) dialog.close();
        };
    }, [open]);

    const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
    };

    return (
        <dialog
            ref={dialogRef}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            onClick={handleBackdropClick}
            className={`m-auto max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] p-0 text-left backdrop:bg-black/75 backdrop:backdrop-blur-sm ${className}`}
        >
            {children}
        </dialog>
    );
}
