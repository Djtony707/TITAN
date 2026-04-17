/**
 * ConfirmDialog — standardized confirmation for destructive actions.
 *
 * Replaces scattered window.confirm() and ad-hoc inline confirmations.
 * Wraps Modal with a yes/no pattern. Danger variant by default since
 * almost all use cases are destructive (delete agent, remove budget,
 * uninstall skill, etc.).
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <ConfirmDialog
 *     open={open}
 *     title="Remove agent?"
 *     message="This can't be undone. The agent's run history stays."
 *     confirmLabel="Remove"
 *     onConfirm={async () => { await deleteAgent(id); setOpen(false); refresh(); }}
 *     onCancel={() => setOpen(false)}
 *   />
 */
import { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    /** Body copy — can be a plain string or JSX. */
    message: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Non-destructive variant (e.g. "Save changes?" with primary button). */
    variant?: 'danger' | 'primary';
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
}

export function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'danger',
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const [busy, setBusy] = useState(false);

    const handleConfirm = async () => {
        setBusy(true);
        try {
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={() => !busy && onCancel()}
            title={title}
            size="sm"
            footer={
                <>
                    <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                        {cancelLabel}
                    </Button>
                    <Button
                        variant={variant === 'danger' ? 'danger' : 'primary'}
                        size="sm"
                        onClick={handleConfirm}
                        loading={busy}
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            <div className="text-sm text-text-secondary leading-relaxed">{message}</div>
        </Modal>
    );
}
