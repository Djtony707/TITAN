/**
 * TITAN — Email Skill (Built-in)
 * Send and read email via SMTP (with native TLS upgrade) and Gmail API stubs.
 *
 * Supported tools:
 *   email_send   — Send email over SMTP (Gmail or custom server)
 *   email_search — Search Gmail messages (OAuth2 stub)
 *   email_read   — Read a Gmail message by ID (OAuth2 stub)
 *   email_list   — List recent emails in a folder (IMAP/OAuth2 stub)
 */
import { createConnection } from 'net';
import { connect as tlsConnect, type TLSSocket } from 'tls';
import { registerSkill } from '../registry.js';
import { isGoogleConnected, gmailFetch } from '../../auth/google.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'EmailSkill';

// ---------------------------------------------------------------------------
// Rate-limit state (in-memory, reset on process restart)
// ---------------------------------------------------------------------------
let emailsSentThisSession = 0;
let lastRateLimitWarnAt = 0;
const RATE_LIMIT_WARN_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a single email address with a permissive but sane regex */
function isValidEmail(addr: string): boolean {
    // RFC-5322 simplified — covers the vast majority of real addresses
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr.trim());
}

/** Parse and validate a comma-separated list of email addresses */
function parseAddressList(raw: string): { valid: string[]; invalid: string[] } {
    const parts = raw.split(/[,;]/).map(a => a.trim()).filter(Boolean);
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const addr of parts) {
        if (isValidEmail(addr)) valid.push(addr);
        else invalid.push(addr);
    }
    return { valid, invalid };
}

/** Base64-encode a string (Node.js built-in) */
function b64(s: string): string {
    return Buffer.from(s, 'utf-8').toString('base64');
}

/** Format a Date for email headers (RFC 2822) */
function rfc2822Date(d: Date = new Date()): string {
    return d.toUTCString().replace('GMT', '+0000');
}

/** Fold long header lines at 76 chars as per RFC 5321 */
function foldHeader(header: string): string {
    if (header.length <= 76) return header;
    // Simple fold: insert CRLF + whitespace before each subsequent word
    return header.replace(/(.{1,76})(\s|$)/g, '$1\r\n\t').trimEnd();
}

/** Escape a period at the start of a line (SMTP transparency, RFC 5321 §4.5.2) */
function smtpEscape(text: string): string {
    return text.split('\r\n').map(line => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
}

// ---------------------------------------------------------------------------
// Low-level SMTP client using Node.js net + tls (no third-party deps)
// ---------------------------------------------------------------------------

interface SmtpConfig {
    host: string;
    port: number;
    user: string;
    pass: string;
}

/**
 * Minimal SMTP client that supports STARTTLS + AUTH LOGIN.
 *
 * Flow:
 *   TCP connect → read greeting → EHLO → STARTTLS → TLS handshake
 *   → EHLO again → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → body → QUIT
 */
async function sendViaSMTP(
    cfg: SmtpConfig,
    from: string,
    to: string[],
    raw: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = 30_000;
        let upgrading = false;

        // ------------------------------------------------------------------
        // Step machine — each step sends a command and waits for the reply
        // ------------------------------------------------------------------
        type Step =
            | 'greeting'
            | 'ehlo1'
            | 'starttls'
            | 'ehlo2'
            | 'auth_login'
            | 'auth_user'
            | 'auth_pass'
            | 'mail_from'
            | 'rcpt_to'
            | 'data'
            | 'body'
            | 'quit'
            | 'done';

        let step: Step = 'greeting';
        let rcptIndex = 0;

        // We start on a plain TCP socket, then upgrade it in-place
        let socket: ReturnType<typeof createConnection> | TLSSocket =
            createConnection({ host: cfg.host, port: cfg.port });

        socket.setTimeout(timeout);

        function die(msg: string): void {
            socket.destroy();
            reject(new Error(msg));
        }

        function send(cmd: string): void {
            logger.debug(COMPONENT, `SMTP >> ${cmd}`);
            (socket as NodeJS.WritableStream).write(cmd + '\r\n');
        }

        let buffer = '';

        function onData(chunk: Buffer | string): void {
            buffer += chunk.toString('utf-8');

            // SMTP responses end with a complete line: "ddd text\r\n"
            // Multi-line responses use "ddd-text\r\n" until "ddd text\r\n"
            const lines = buffer.split('\r\n');
            // Keep the last (possibly incomplete) piece in the buffer
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line) continue;
                logger.debug(COMPONENT, `SMTP << ${line}`);

                const code = parseInt(line.slice(0, 3), 10);
                const isContinuation = line[3] === '-';
                if (isContinuation) continue; // Multi-line — wait for final line

                handleResponse(code, line);
            }
        }

        function handleResponse(code: number, line: string): void {
            // Any 4xx/5xx (except after DATA where 3xx is used) is a hard error
            const ok2xx = code >= 200 && code < 300;

            switch (step) {
                case 'greeting':
                    if (code !== 220) return die(`Server rejected connection: ${line}`);
                    step = 'ehlo1';
                    send(`EHLO ${cfg.host}`);
                    break;

                case 'ehlo1':
                    if (!ok2xx) return die(`EHLO failed: ${line}`);
                    step = 'starttls';
                    send('STARTTLS');
                    break;

                case 'starttls': {
                    if (code !== 220) return die(`STARTTLS failed: ${line}`);
                    // Upgrade the socket to TLS
                    upgrading = true;
                    socket.removeAllListeners('data');
                    socket.removeAllListeners('error');
                    socket.removeAllListeners('timeout');
                    socket.removeAllListeners('close');

                    const tlsSocket = tlsConnect({
                        socket: socket as ReturnType<typeof createConnection>,
                        host: cfg.host,
                        servername: cfg.host,
                        rejectUnauthorized: true,
                    });

                    tlsSocket.setTimeout(timeout);
                    tlsSocket.on('data', onData);
                    tlsSocket.on('error', (err) => die(`TLS error: ${err.message}`));
                    tlsSocket.on('timeout', () => die('SMTP connection timed out'));
                    tlsSocket.on('close', () => {
                        if (step !== 'done') die('Connection closed unexpectedly');
                    });

                    socket = tlsSocket;
                    upgrading = false;
                    step = 'ehlo2';
                    send(`EHLO ${cfg.host}`);
                    break;
                }

                case 'ehlo2':
                    if (!ok2xx) return die(`EHLO (post-TLS) failed: ${line}`);
                    step = 'auth_login';
                    send('AUTH LOGIN');
                    break;

                case 'auth_login':
                    // Server should reply 334 (challenge)
                    if (code !== 334) return die(`AUTH LOGIN rejected: ${line}`);
                    step = 'auth_user';
                    send(b64(cfg.user));
                    break;

                case 'auth_user':
                    if (code !== 334) return die(`AUTH username rejected: ${line}`);
                    step = 'auth_pass';
                    send(b64(cfg.pass));
                    break;

                case 'auth_pass':
                    if (code !== 235) return die(`AUTH password rejected (check credentials): ${code}`);
                    step = 'mail_from';
                    send(`MAIL FROM:<${from}>`);
                    break;

                case 'mail_from':
                    if (!ok2xx) return die(`MAIL FROM rejected: ${line}`);
                    rcptIndex = 0;
                    step = 'rcpt_to';
                    send(`RCPT TO:<${to[rcptIndex]}>`);
                    break;

                case 'rcpt_to':
                    if (!ok2xx) return die(`RCPT TO <${to[rcptIndex]}> rejected: ${line}`);
                    rcptIndex++;
                    if (rcptIndex < to.length) {
                        // More recipients to add
                        send(`RCPT TO:<${to[rcptIndex]}>`);
                    } else {
                        step = 'data';
                        send('DATA');
                    }
                    break;

                case 'data':
                    // Server should reply 354 (start input)
                    if (code !== 354) return die(`DATA command rejected: ${line}`);
                    step = 'body';
                    // Send the raw message body followed by <CRLF>.<CRLF>
                    (socket as NodeJS.WritableStream).write(smtpEscape(raw) + '\r\n.\r\n');
                    break;

                case 'body':
                    if (!ok2xx) return die(`Message rejected by server: ${line}`);
                    step = 'quit';
                    send('QUIT');
                    break;

                case 'quit':
                    // 221 is the expected goodbye — some servers send 2xx variants
                    step = 'done';
                    socket.destroy();
                    resolve();
                    break;

                default:
                    break;
            }
        }

        socket.on('data', onData);
        socket.on('error', (err: Error) => {
            if (!upgrading) die(`Socket error: ${err.message}`);
        });
        socket.on('timeout', () => die('SMTP connection timed out'));
        socket.on('close', () => {
            if (step !== 'done') die('Connection closed before message was sent');
        });
    });
}

// ---------------------------------------------------------------------------
// Build a raw RFC 5322 email message
// ---------------------------------------------------------------------------

interface MessageOptions {
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    html: boolean;
}

function buildRawMessage(opts: MessageOptions): string {
    const boundary = `titan_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const lines: string[] = [];

    lines.push(`Date: ${rfc2822Date()}`);
    lines.push(`From: ${opts.from}`);
    lines.push(`To: ${opts.to.join(', ')}`);
    if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(', ')}`);
    // BCC is intentionally omitted from headers (included in RCPT TO only)
    lines.push(foldHeader(`Subject: ${opts.subject}`));
    lines.push('MIME-Version: 1.0');

    if (opts.html) {
        // Multipart/alternative with plain-text fallback
        lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        lines.push('');
        lines.push(`--${boundary}`);
        lines.push('Content-Type: text/plain; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: quoted-printable');
        lines.push('');
        // Simple HTML → plain fallback: strip tags
        const plain = opts.body
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
        lines.push(plain);
        lines.push('');
        lines.push(`--${boundary}`);
        lines.push('Content-Type: text/html; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: quoted-printable');
        lines.push('');
        lines.push(opts.body);
        lines.push('');
        lines.push(`--${boundary}--`);
    } else {
        lines.push('Content-Type: text/plain; charset=UTF-8');
        lines.push('Content-Transfer-Encoding: 7bit');
        lines.push('');
        lines.push(opts.body);
    }

    return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Resolve SMTP config from env vars
// ---------------------------------------------------------------------------

interface SmtpResolved {
    cfg: SmtpConfig;
    from: string;
}

function resolveSmtpConfig(): SmtpResolved | null {
    // Gmail takes priority
    const gmailAddr = process.env.GMAIL_ADDRESS?.trim();
    const gmailPass = process.env.GMAIL_APP_PASSWORD?.trim();
    if (gmailAddr && gmailPass) {
        return {
            cfg: { host: 'smtp.gmail.com', port: 587, user: gmailAddr, pass: gmailPass },
            from: gmailAddr,
        };
    }

    // Custom SMTP
    const smtpHost = process.env.SMTP_HOST?.trim();
    const smtpUser = process.env.SMTP_USER?.trim();
    const smtpPass = process.env.SMTP_PASS?.trim();
    const smtpPort = parseInt(process.env.SMTP_PORT ?? '587', 10);
    if (smtpHost && smtpUser && smtpPass) {
        return {
            cfg: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
            from: smtpUser,
        };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Gmail API helpers (native fetch, zero deps)
// ---------------------------------------------------------------------------

/** Decode base64url-encoded content */
function decodeBase64Url(data: string): string {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Walk MIME parts to extract the email body */
function extractBody(payload: { mimeType?: string; body?: { data?: string; size?: number }; parts?: unknown[] }): string {
    // Direct body content
    if (payload.body?.data) {
        return decodeBase64Url(payload.body.data);
    }

    // Walk parts recursively, preferring text/plain over text/html
    if (payload.parts && Array.isArray(payload.parts)) {
        let plainText = '';
        let htmlText = '';

        for (const part of payload.parts as Array<typeof payload>) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                plainText = decodeBase64Url(part.body.data);
            } else if (part.mimeType === 'text/html' && part.body?.data) {
                htmlText = decodeBase64Url(part.body.data);
            } else if (part.parts) {
                const nested = extractBody(part);
                if (nested) plainText = plainText || nested;
            }
        }

        if (plainText) return plainText;
        if (htmlText) {
            // Strip HTML tags for readability
            return htmlText
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .trim();
        }
    }

    return '';
}

/** Get a header value from Gmail message headers */
function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
    return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

/** Encode raw RFC5322 message as base64url for Gmail send API */
function toBase64Url(str: string): string {
    return Buffer.from(str, 'utf-8').toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Skill registrations
// ---------------------------------------------------------------------------

export function registerEmailSkill(): void {
    // -------------------------------------------------------------------------
    // Tool 1: email_send
    // -------------------------------------------------------------------------
    registerSkill(
        {
            name: 'email_send',
            description: 'Send email via SMTP or Gmail API. USE THIS WHEN Tony says: "send an email", "email X about Y", "send a message to Z". WORKFLOW: Confirm recipient address, subject, and body before sending. RULES: Always confirm the recipient and subject with Tony before sending. Supports plain text and HTML.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'email_send',
            description:
                'Sends an email to one or more recipients via Gmail API (if connected) or SMTP fallback. ' +
                'USE THIS WHEN Tony says: "send an email", "email X about Y", "send a message to Z", "draft and send an email to ...". ' +
                'WORKFLOW: 1) Confirm recipient(s), subject, and body with Tony. 2) Call email_send with to, subject, body. ' +
                'RULES: Always confirm the recipient and content before sending. Never send without explicit approval.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address(es), comma-separated',
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line',
                    },
                    body: {
                        type: 'string',
                        description: 'Email body — plain text by default, or HTML if html=true',
                    },
                    cc: {
                        type: 'string',
                        description: 'CC recipient(s), comma-separated (optional)',
                    },
                    bcc: {
                        type: 'string',
                        description: 'BCC recipient(s), comma-separated (optional)',
                    },
                    html: {
                        type: 'boolean',
                        description: 'Set to true to send body as HTML (default: false)',
                    },
                },
                required: ['to', 'subject', 'body'],
            },
            execute: async (args) => {
                const toRaw = (args.to as string) || '';
                const subject = (args.subject as string) || '';
                const body = (args.body as string) || '';
                const ccRaw = (args.cc as string) || '';
                const bccRaw = (args.bcc as string) || '';
                const isHtml = Boolean(args.html);

                // ----------------------------------------------------------
                // Validate inputs
                // ----------------------------------------------------------
                if (!toRaw.trim()) return 'Error: "to" is required.';
                if (!subject.trim()) return 'Error: "subject" is required.';
                if (!body.trim()) return 'Error: "body" is required.';

                const toResult = parseAddressList(toRaw);
                if (toResult.invalid.length > 0) {
                    return `Error: Invalid "to" address(es): ${toResult.invalid.join(', ')}`;
                }
                if (toResult.valid.length === 0) {
                    return 'Error: No valid "to" addresses provided.';
                }

                const ccResult = ccRaw ? parseAddressList(ccRaw) : { valid: [], invalid: [] };
                if (ccResult.invalid.length > 0) {
                    return `Error: Invalid "cc" address(es): ${ccResult.invalid.join(', ')}`;
                }

                const bccResult = bccRaw ? parseAddressList(bccRaw) : { valid: [], invalid: [] };
                if (bccResult.invalid.length > 0) {
                    return `Error: Invalid "bcc" address(es): ${bccResult.invalid.join(', ')}`;
                }

                // ----------------------------------------------------------
                // Rate-limit warning
                // ----------------------------------------------------------
                emailsSentThisSession++;
                if (
                    emailsSentThisSession > RATE_LIMIT_WARN_THRESHOLD &&
                    Date.now() - lastRateLimitWarnAt > 60_000
                ) {
                    lastRateLimitWarnAt = Date.now();
                    logger.warn(
                        COMPONENT,
                        `High email volume: ${emailsSentThisSession} emails sent this session`,
                    );
                }

                // ----------------------------------------------------------
                // Try Gmail API first (if connected), then fall back to SMTP
                // ----------------------------------------------------------
                if (isGoogleConnected()) {
                    try {
                        const raw = buildRawMessage({
                            from: 'me',
                            to: toResult.valid,
                            cc: ccResult.valid.length > 0 ? ccResult.valid : undefined,
                            bcc: bccResult.valid.length > 0 ? bccResult.valid : undefined,
                            subject,
                            body,
                            html: isHtml,
                        });

                        const encodedRaw = toBase64Url(raw);
                        const gmailRes = await gmailFetch('/gmail/v1/users/me/messages/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ raw: encodedRaw }),
                        });

                        if (gmailRes.ok) {
                            const result = await gmailRes.json() as { id: string };
                            const recipientSummary = `To: ${toResult.valid.join(', ')}`;
                            logger.info(COMPONENT, `Email sent via Gmail API — id=${result.id}`);
                            return `Email sent successfully via Gmail API.\nSubject: ${subject}\n${recipientSummary}\nMessage ID: ${result.id}`;
                        }
                        // Gmail API failed, try SMTP fallback
                        logger.warn(COMPONENT, `Gmail API send failed (${gmailRes.status}), trying SMTP fallback`);
                    } catch (err) {
                        logger.warn(COMPONENT, `Gmail API error: ${(err as Error).message}, trying SMTP fallback`);
                    }
                }

                // ----------------------------------------------------------
                // SMTP fallback
                // ----------------------------------------------------------
                const resolved = resolveSmtpConfig();
                if (!resolved) {
                    return (
                        'Error: No email configuration found. ' +
                        'Connect your Google account in Dashboard Settings, or ' +
                        'set GMAIL_ADDRESS and GMAIL_APP_PASSWORD environment variables for Gmail, ' +
                        'or SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT) for a custom SMTP server.'
                    );
                }

                const allRecipients = [
                    ...toResult.valid,
                    ...ccResult.valid,
                    ...bccResult.valid,
                ];

                const raw = buildRawMessage({
                    from: resolved.from,
                    to: toResult.valid,
                    cc: ccResult.valid.length > 0 ? ccResult.valid : undefined,
                    bcc: bccResult.valid.length > 0 ? bccResult.valid : undefined,
                    subject,
                    body,
                    html: isHtml,
                });

                logger.info(
                    COMPONENT,
                    `Sending email to ${toResult.valid.join(', ')} via ${resolved.cfg.host}:${resolved.cfg.port}`,
                );

                try {
                    await sendViaSMTP(resolved.cfg, resolved.from, allRecipients, raw);

                    const recipientSummary = [
                        `To: ${toResult.valid.join(', ')}`,
                        ccResult.valid.length > 0 ? `CC: ${ccResult.valid.join(', ')}` : '',
                        bccResult.valid.length > 0 ? `BCC: ${bccResult.valid.length} recipient(s)` : '',
                    ]
                        .filter(Boolean)
                        .join(' | ');

                    logger.info(COMPONENT, `Email sent successfully — ${recipientSummary}`);
                    return (
                        `Email sent successfully.\n` +
                        `Subject: ${subject}\n` +
                        `${recipientSummary}\n` +
                        `Server: ${resolved.cfg.host}:${resolved.cfg.port}`
                    );
                } catch (err) {
                    const msg = (err as Error).message;
                    logger.error(COMPONENT, `SMTP send failed: ${msg}`);
                    return `Error sending email: ${msg}`;
                }
            },
        },
    );

    // -------------------------------------------------------------------------
    // Tool 2: email_search
    // -------------------------------------------------------------------------
    registerSkill(
        {
            name: 'email_search',
            description: 'Search Gmail messages using query syntax. USE THIS WHEN Tony says: "find emails from X", "search my email for Y", "show unread emails", "did I get an email about Z". RULES: Requires Gmail OAuth2 — prompt Tony to connect Google account if not connected.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'email_search',
            description:
                'Searches Gmail messages using Gmail query syntax (e.g. "from:boss@company.com subject:report is:unread"). ' +
                'USE THIS WHEN Tony says: "find emails from X", "search my email for Y", "show unread emails", "did I get an email about Z", "check my inbox for ...". ' +
                'RULES: Requires Gmail OAuth2 connection — if not connected, tell Tony to connect Google account in Dashboard Settings.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Gmail search query (e.g. "from:alice@example.com is:unread")',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Maximum number of results to return (default: 10)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = (args.query as string) || '';
                const maxResults = (args.maxResults as number) || 10;

                logger.info(COMPONENT, `email_search called — query="${query}" maxResults=${maxResults}`);

                if (!isGoogleConnected()) {
                    return 'Gmail not connected. Connect your Google account in Dashboard → Settings → Providers to enable email search.';
                }

                try {
                    const searchRes = await gmailFetch(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
                    if (!searchRes.ok) return `Gmail API error: ${searchRes.status}`;

                    const data = await searchRes.json() as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };
                    if (!data.messages || data.messages.length === 0) return `No emails found for query: "${query}"`;

                    // Fetch metadata for each message
                    const results: string[] = [`Found ${data.resultSizeEstimate || data.messages.length} result(s) for "${query}":\n`];

                    for (const msg of data.messages.slice(0, maxResults)) {
                        const metaRes = await gmailFetch(`/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
                        if (!metaRes.ok) continue;
                        const meta = await metaRes.json() as { id: string; snippet: string; payload?: { headers: Array<{ name: string; value: string }> } };
                        const headers = meta.payload?.headers || [];
                        const subject = getHeader(headers, 'Subject') || '(no subject)';
                        const from = getHeader(headers, 'From') || 'unknown';
                        const date = getHeader(headers, 'Date') || '';
                        results.push(`[${msg.id}] ${subject}\n  From: ${from} | ${date}\n  ${meta.snippet || ''}\n`);
                    }

                    return results.join('\n');
                } catch (err) {
                    return `Error searching Gmail: ${(err as Error).message}`;
                }
            },
        },
    );

    // -------------------------------------------------------------------------
    // Tool 3: email_read
    // -------------------------------------------------------------------------
    registerSkill(
        {
            name: 'email_read',
            description: 'Read the full content of a specific email by message ID. USE THIS WHEN Tony says: "read that email", "open email ID X", "show me the full email". RULES: Use email_search first to find the message ID, then call email_read.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'email_read',
            description:
                'Retrieves the full content of a specific Gmail message by its message ID. ' +
                'USE THIS WHEN Tony says: "read that email", "open email ID X", "show me the full email", "what does that message say". ' +
                'WORKFLOW: Use email_search first to find the message ID, then call email_read with the messageId. ' +
                'RULES: Requires Gmail OAuth2 connection.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Gmail message ID to retrieve',
                    },
                },
                required: ['messageId'],
            },
            execute: async (args) => {
                const messageId = (args.messageId as string) || '';

                logger.info(COMPONENT, `email_read called — messageId="${messageId}"`);

                if (!messageId) return 'Error: messageId is required.';

                if (!isGoogleConnected()) {
                    return 'Gmail not connected. Connect your Google account in Dashboard → Settings → Providers to read emails.';
                }

                try {
                    const res = await gmailFetch(`/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
                    if (!res.ok) return `Gmail API error: ${res.status}`;

                    const msg = await res.json() as {
                        id: string;
                        snippet: string;
                        payload: {
                            mimeType?: string;
                            headers: Array<{ name: string; value: string }>;
                            body?: { data?: string };
                            parts?: unknown[];
                        };
                        labelIds?: string[];
                    };

                    const headers = msg.payload?.headers || [];
                    const subject = getHeader(headers, 'Subject') || '(no subject)';
                    const from = getHeader(headers, 'From') || 'unknown';
                    const to = getHeader(headers, 'To') || '';
                    const date = getHeader(headers, 'Date') || '';
                    const body = extractBody(msg.payload);

                    return [
                        `**Subject:** ${subject}`,
                        `**From:** ${from}`,
                        `**To:** ${to}`,
                        `**Date:** ${date}`,
                        `**Labels:** ${(msg.labelIds || []).join(', ')}`,
                        '',
                        body || msg.snippet || '(empty body)',
                    ].join('\n');
                } catch (err) {
                    return `Error reading email: ${(err as Error).message}`;
                }
            },
        },
    );

    // -------------------------------------------------------------------------
    // Tool 4: email_list
    // -------------------------------------------------------------------------
    registerSkill(
        {
            name: 'email_list',
            description: 'List recent emails in a mailbox folder. USE THIS WHEN Tony says: "show my inbox", "list recent emails", "what\'s in my sent folder", "check my spam". RULES: Requires Gmail OAuth2 connection.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'email_list',
            description:
                'Lists recent emails from a mailbox folder (inbox, sent, spam, etc.). ' +
                'USE THIS WHEN Tony says: "show my inbox", "list recent emails", "what\'s in my sent folder", "check my spam", "show me emails from today". ' +
                'RULES: Requires Gmail OAuth2 connection — tell Tony to connect Google account in Dashboard Settings if not connected.',
            parameters: {
                type: 'object',
                properties: {
                    folder: {
                        type: 'string',
                        description: 'Mailbox folder to list (e.g. "inbox", "sent", "spam"). Default: inbox',
                    },
                    count: {
                        type: 'number',
                        description: 'Number of emails to retrieve (default: 10)',
                    },
                },
            },
            execute: async (args) => {
                const folder = (args.folder as string) || 'inbox';
                const count = (args.count as number) || 10;

                logger.info(COMPONENT, `email_list called — folder="${folder}" count=${count}`);

                if (!isGoogleConnected()) {
                    return 'Gmail not connected. Connect your Google account in Dashboard → Settings → Providers to list emails.';
                }

                try {
                    const labelId = folder.toUpperCase();
                    const res = await gmailFetch(`/gmail/v1/users/me/messages?labelIds=${encodeURIComponent(labelId)}&maxResults=${count}`);
                    if (!res.ok) return `Gmail API error: ${res.status}`;

                    const data = await res.json() as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };
                    if (!data.messages || data.messages.length === 0) return `No emails found in "${folder}".`;

                    const results: string[] = [`${data.messages.length} email(s) in "${folder}":\n`];

                    for (const msg of data.messages) {
                        const metaRes = await gmailFetch(`/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
                        if (!metaRes.ok) continue;
                        const meta = await metaRes.json() as { id: string; snippet: string; payload?: { headers: Array<{ name: string; value: string }> } };
                        const headers = meta.payload?.headers || [];
                        const subject = getHeader(headers, 'Subject') || '(no subject)';
                        const from = getHeader(headers, 'From') || 'unknown';
                        const date = getHeader(headers, 'Date') || '';
                        results.push(`[${msg.id}] ${subject}\n  From: ${from} | ${date}\n`);
                    }

                    return results.join('\n');
                } catch (err) {
                    return `Error listing emails: ${(err as Error).message}`;
                }
            },
        },
    );
}
