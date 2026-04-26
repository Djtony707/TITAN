/**
 * TITAN v5.0 — Lightweight OTEL-compatible Diagnostics Export
 *
 * Writes JSONL spans to ~/.titan/diagnostics/spans.jsonl
 * No external OTEL SDK dependency — pure file-based export.
 */

import { mkdirSync, appendFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';
import type { DiagnosticSpan, SpanContext } from './types.js';

const COMPONENT = 'OTEL';
const DIAGNOSTICS_DIR = `${homedir()}/.titan/diagnostics`;
const SPANS_PATH = `${DIAGNOSTICS_DIR}/spans.jsonl`;

let globalEnabled = false;
let globalCaptureContent = false;
let globalEndpoint: string | undefined;

/** Initialize OTEL exporter from config */
export function initOtel(): void {
    const config = loadConfig();
    globalEnabled = config.diagnostics?.otel?.enabled ?? false;
    globalCaptureContent = config.diagnostics?.otel?.captureContent ?? false;
    globalEndpoint = config.diagnostics?.otel?.endpoint;
    if (globalEnabled) {
        mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
        logger.info(COMPONENT, `OTEL diagnostics enabled. Spans: ${SPANS_PATH}`);
    }
}

function ensureDir(): void {
    if (!existsSync(DIAGNOSTICS_DIR)) {
        mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
    }
}

/** Generate a new trace context */
export function newTraceContext(parent?: SpanContext): SpanContext {
    return {
        traceId: parent?.traceId ?? randomUUID().replace(/-/g, ''),
        spanId: randomUUID().replace(/-/g, '').slice(0, 16),
        parentSpanId: parent?.spanId,
    };
}

/** Emit a span to the JSONL file (and optional HTTP endpoint) */
export async function emitSpan(span: DiagnosticSpan): Promise<void> {
    if (!globalEnabled) return;
    ensureDir();

    try {
        appendFileSync(SPANS_PATH, JSON.stringify(span) + '\n', 'utf-8');
    } catch (err) {
        logger.debug(COMPONENT, `Failed to write span: ${(err as Error).message}`);
    }

    if (globalEndpoint) {
        try {
            await fetch(globalEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(span),
            });
        } catch {
            // Endpoint unavailable — non-critical
        }
    }
}

/** Convenience: emit a span with timing */
export async function timedSpan<T>(
    ctx: SpanContext,
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
): Promise<T> {
    if (!globalEnabled) return fn();

    const start = Date.now();
    const startTime = new Date().toISOString();
    let error: { type: string; message: string } | undefined;

    try {
        return await fn();
    } catch (err) {
        error = {
            type: (err as Error).constructor.name,
            message: (err as Error).message.slice(0, 200),
        };
        throw err;
    } finally {
        const durationMs = Date.now() - start;
        const span: DiagnosticSpan = {
            traceId: ctx.traceId,
            spanId: randomUUID().replace(/-/g, '').slice(0, 16),
            parentSpanId: ctx.spanId,
            name,
            startTime,
            endTime: new Date().toISOString(),
            durationMs,
            attributes: globalCaptureContent
                ? attributes
                : { ...attributes, _contentRedacted: true },
            error,
        };
        await emitSpan(span);
    }
}

/** Simple fire-and-forget span emission */
export function fireSpan(
    ctx: SpanContext,
    name: string,
    durationMs: number,
    attributes: Record<string, string | number | boolean>,
    error?: { type: string; message: string },
): void {
    if (!globalEnabled) return;
    const span: DiagnosticSpan = {
        traceId: ctx.traceId,
        spanId: randomUUID().replace(/-/g, '').slice(0, 16),
        parentSpanId: ctx.spanId,
        name,
        startTime: new Date(Date.now() - durationMs).toISOString(),
        endTime: new Date().toISOString(),
        durationMs,
        attributes: globalCaptureContent
            ? attributes
            : { ...attributes, _contentRedacted: true },
        error,
    };
    emitSpan(span).catch(() => {});
}
