/**
 * TITAN — Telemetry Consent Version
 *
 * v6.1.0 Phase B (`6.1.0-beta.2`) — re-consent flow.
 *
 * The `REQUIRED_CONSENT_VERSION` constant is bumped each time the
 * telemetry payload or destination changes in a way that a previously-
 * consenting user should be re-prompted about. When a user's stored
 * `config.telemetry.consentVersion` is **less than** this number, the
 * CLI must re-prompt them (and default to OFF on any non-affirmative
 * answer — including Ctrl-C / blank / "no" / anything else).
 *
 * History
 * -------
 *   1 — v5.x SetupWizard opt-in (legacy `consentedAt` / `consentedVersion`).
 *   2 — v6.0+ payload: install ID + bucketed system fingerprint + feature
 *       flags + scrubbed crash stacks. Routes to PostHog Cloud (US or EU
 *       by IANA timezone). `posthog-node` SDK used instead of hand-rolled
 *       fetch. Local 30-day TTL on `~/.titan/bug-reports.jsonl`.
 *
 * Don't bump this number lightly — every bump re-prompts every existing
 * telemetry user and defaults them to OFF if they dismiss. Only bump
 * when the change is material enough that informed consent has expired
 * (new destination, new payload shape, new retention rules, etc.).
 */
export const REQUIRED_CONSENT_VERSION = 2;
