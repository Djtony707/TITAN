export const RECEIPT_KINDS = [
    'tool_call',
    'mission_start',
    'mission_end',
    'agent_spawn',
    'file_write',
    'approval_request',
    'approval_decision',
    'cost_charge',
    'error',
] as const;

export type ReceiptKind = typeof RECEIPT_KINDS[number];

export function isReceiptKind(value: unknown): value is ReceiptKind {
    return typeof value === 'string' && (RECEIPT_KINDS as readonly string[]).includes(value);
}

export interface Receipt {
    action_id: string;
    ts: string;
    kind: ReceiptKind;
    summary: string;
    status: 'ok' | 'fail' | 'pending';
    parent_action_id?: string;
    agent?: string;
    mission?: string;
    channel?: string;
    duration_ms?: number;
    cost_usd?: number;
    meta?: Record<string, unknown>;
}

export interface ReceiptQuery {
    since?: string;
    kind?: ReceiptKind | ReceiptKind[];
    mission?: string;
    agent?: string;
    limit?: number;
}
