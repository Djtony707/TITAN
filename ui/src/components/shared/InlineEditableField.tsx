/**
 * InlineEditableField — click-to-edit text cell.
 *
 * Reusable pattern for Command Post tables + anywhere a field is currently
 * read-only but the backend PATCH endpoint exists. Click the value, get a
 * text input, press Enter or click the check → `onSave(newValue)` fires.
 * Escape or click-outside cancels.
 *
 * Supports both single-line (default) and multiline modes.
 *
 * Intentionally unopinionated about what happens on save — caller decides
 * (toast, refetch, optimistic update). The field only reports the intent.
 */
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Check, X, Pencil } from 'lucide-react';
import clsx from 'clsx';

interface InlineEditableFieldProps {
    value: string;
    onSave: (newValue: string) => void | Promise<void>;
    placeholder?: string;
    /** true → render as a textarea; false → single-line input. */
    multiline?: boolean;
    /** Optional per-instance class for the read-only display span. */
    className?: string;
    /** When set, the value shown to users differs from the editable string.
     *  E.g. display "TITAN Primary" but edit the raw name. Rare. */
    displayValue?: string;
    /** Empty values render as this placeholder in read mode. Default: em dash. */
    emptyLabel?: string;
    /** Disable the pencil icon on hover — purely cosmetic. */
    hidePencil?: boolean;
    /** Maximum edit length. */
    maxLength?: number;
    /** Title / tooltip for the read-mode span. */
    title?: string;
}

export function InlineEditableField({
    value,
    onSave,
    placeholder,
    multiline = false,
    className,
    displayValue,
    emptyLabel = '—',
    hidePencil = false,
    maxLength,
    title,
}: InlineEditableFieldProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.focus();
            if ('select' in inputRef.current) inputRef.current.select();
        }
    }, [editing]);

    useEffect(() => {
        if (!editing) setDraft(value);
    }, [value, editing]);

    const commit = async () => {
        if (draft === value) { setEditing(false); return; }
        setSaving(true);
        try {
            await onSave(draft);
            setEditing(false);
        } catch {
            /* caller handles error messaging; we just stop spinning */
        } finally {
            setSaving(false);
        }
    };

    const cancel = () => {
        setDraft(value);
        setEditing(false);
    };

    const handleKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); commit(); }
        else if (e.key === 'Enter' && multiline && e.metaKey) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };

    if (editing) {
        const inputClass = clsx(
            'bg-bg-tertiary border border-accent/60 rounded px-2 py-1 text-sm text-text',
            'focus:outline-none focus:border-accent',
            'w-full',
            multiline && 'resize-none min-h-[60px]',
        );
        return (
            <span className="inline-flex items-start gap-1 w-full">
                {multiline ? (
                    <textarea
                        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={handleKey}
                        placeholder={placeholder}
                        maxLength={maxLength}
                        className={inputClass}
                        disabled={saving}
                    />
                ) : (
                    <input
                        ref={inputRef as React.RefObject<HTMLInputElement>}
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={handleKey}
                        placeholder={placeholder}
                        maxLength={maxLength}
                        className={inputClass}
                        disabled={saving}
                    />
                )}
                <button
                    onClick={commit}
                    disabled={saving}
                    className="text-success hover:bg-success/10 rounded p-1 shrink-0"
                    title={multiline ? 'Save (Cmd+Enter)' : 'Save (Enter)'}
                    type="button"
                >
                    <Check size={14} />
                </button>
                <button
                    onClick={cancel}
                    disabled={saving}
                    className="text-text-muted hover:bg-bg-tertiary rounded p-1 shrink-0"
                    title="Cancel (Esc)"
                    type="button"
                >
                    <X size={14} />
                </button>
            </span>
        );
    }

    const display = displayValue ?? (value && value.length > 0 ? value : emptyLabel);
    return (
        <span
            className={clsx(
                'inline-flex items-center gap-1 cursor-pointer group',
                'hover:bg-white/[0.04] rounded px-1 -mx-1',
                className,
            )}
            onClick={() => setEditing(true)}
            title={title ?? 'Click to edit'}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
        >
            <span>{display}</span>
            {!hidePencil && (
                <Pencil
                    size={10}
                    className="text-text-muted opacity-0 group-hover:opacity-60 transition-opacity shrink-0"
                />
            )}
        </span>
    );
}
