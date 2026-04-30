/**
 * Tests Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates all /api/test/*, /api/tests/*, /api/test-health/*, and /api/eval/* routes.
 */

import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';
import { processMessage } from '../../agent/agent.js';
import { recordEvalSuiteResult, recordEvalTimeout, recordEvalError } from '../metrics.js';

const COMPONENT = 'TestsRouter';

export function createTestsRouter(): Router {
  const router = Router();

  // ── Test routes (/api/test/*) ───────────────────────────────────
  router.get('/test/health', async (_req, res) => {
    try {
      const { getTestHealthSummary } = await import('../../testing/testHealthMonitor.js');
      const summary = getTestHealthSummary();
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/test/stats', async (_req, res) => {
    try {
      const { getTestHealth } = await import('../../testing/testHealthMonitor.js');
      const stats = getTestHealth();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/test/failing', async (_req, res) => {
    try {
      const { getFailingTests } = await import('../../testing/testHealthMonitor.js');
      const failing = getFailingTests();
      res.json(failing);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/test/flaky', async (_req, res) => {
    try {
      const { getFlakyTests } = await import('../../testing/testHealthMonitor.js');
      const threshold = _req.query.threshold ? parseFloat(_req.query.threshold as string) : 0.4;
      const flaky = getFlakyTests(threshold);
      res.json(flaky);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/test/runs', async (_req, res) => {
    try {
      const { getRecentTestRuns } = await import('../../testing/testHealthMonitor.js');
      const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : 10;
      const runs = getRecentTestRuns(limit);
      res.json(runs);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/test/run', async (_req, res) => {
    try {
      const { runTestsDetailed } = await import('../../testing/testHealthMonitor.js');
      const { pattern, watch, coverage, timeout } = _req.body;
      const result = await runTestsDetailed({ pattern, watch, coverage, timeout });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/test/repair-history', async (_req, res) => {
    try {
      const { getRepairHistory } = await import('../../testing/repairValidator.js');
      const repairId = _req.query.repairId as string | undefined;
      const history = getRepairHistory(repairId);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Tests routes (/api/tests/*) ─────────────────────────────────
  router.get('/tests/health', async (_req, res) => {
    try {
      const { getTestHealthSummary } = await import('../../testing/testHealthMonitor.js');
      const summary = getTestHealthSummary();
      res.json(summary);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/tests/failing', async (_req, res) => {
    try {
      const { getFailingTests } = await import('../../testing/testHealthMonitor.js');
      const failing = getFailingTests();
      res.json({ tests: failing, count: failing.length });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/tests/flaky', async (_req, res) => {
    try {
      const { getFlakyTests } = await import('../../testing/testHealthMonitor.js');
      const threshold = _req.query.threshold ? parseFloat(_req.query.threshold as string) : 0.4;
      const flaky = getFlakyTests(threshold);
      res.json({ tests: flaky, count: flaky.length, threshold });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/tests/history', async (_req, res) => {
    try {
      const { getRecentTestRuns } = await import('../../testing/testHealthMonitor.js');
      const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : 10;
      const runs = getRecentTestRuns(limit);
      res.json({ runs, count: runs.length });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/tests/run', async (req, res) => {
    try {
      const { runTests } = await import('../../testing/testRunner.js');
      const { pattern, timeout } = req.body;
      const result = await runTests({ pattern, timeout });
      res.json(result);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/tests/validate-repair', async (req, res) => {
    try {
      const { validateRepair } = await import('../../testing/repairValidator.js');
      const { repairId, finding, affectedFiles } = req.body;

      if (!repairId || !finding) {
        res.status(400).json({ error: 'Missing required fields: repairId, finding' });
        return;
      }

      const result = await validateRepair({ repairId, finding, affectedFiles });
      res.json(result);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/tests/repair-history', async (req, res) => {
    try {
      const { getRepairHistory } = await import('../../testing/repairValidator.js');
      const { repairId } = req.query;
      const history = getRepairHistory(repairId as string | undefined);
      res.json({ history, count: history.length });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/tests/validate-system-repair', async (req, res) => {
    try {
      const { validateSystemRepair } = await import('../../testing/repairValidator.js');
      const { repairType, target } = req.body;

      if (!repairType || !target) {
        res.status(400).json({ error: 'Missing required fields: repairType, target' });
        return;
      }

      const result = await validateSystemRepair({ repairType, target });
      res.json({ success: result.valid ?? false, repairType, target, ...result });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Test-Health routes (/api/test-health/*) ─────────────────────
  router.get('/test-health/summary', async (_req, res) => {
    try {
      const { getTestHealthSummary, getFlakyTests } = await import('../../testing/testHealthMonitor.js');
      const raw = getTestHealthSummary();
      const flaky = getFlakyTests().length;
      res.json({
        total: raw.total as number,
        passing: raw.passing as number,
        failing: raw.failing as number,
        flaky,
        coverage: raw.coveragePct as number,
      });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/test-health/failing', async (_req, res) => {
    try {
      const { getFailingTests } = await import('../../testing/testHealthMonitor.js');
      const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : 10;
      const names = getFailingTests().slice(0, limit);
      const tests = names.map(name => ({ name, suite: '', error: '', lastFailed: '', attempts: 0 }));
      res.json({ count: tests.length, tests });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, tests: [] });
    }
  });

  router.get('/test-health/flaky', async (_req, res) => {
    try {
      const { getFlakyTests } = await import('../../testing/testHealthMonitor.js');
      const threshold = _req.query.threshold ? parseFloat(_req.query.threshold as string) : 0.4;
      const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : 10;
      const names = getFlakyTests(threshold).slice(0, limit);
      const tests = names.map(name => ({ name, suite: '', passRate: 0, runs: 0 }));
      res.json({ count: tests.length, threshold, tests });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, tests: [] });
    }
  });

  router.get('/test-health/history', async (_req, res) => {
    try {
      const { getRecentTestRuns } = await import('../../testing/testHealthMonitor.js');
      const limit = _req.query.limit ? parseInt(_req.query.limit as string, 10) : 5;
      const runs = getRecentTestRuns(limit);
      res.json({ count: runs.length, runs });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, runs: [] });
    }
  });

  router.post('/test-health/run', async (req, res) => {
    try {
      const { runTests } = await import('../../testing/testRunner.js');
      const { pattern, coverage, timeout } = req.body;
      const result = await runTests({ pattern, coverage, timeout });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, success: false });
    }
  });

  // ── Eval routes (/api/eval/*) ──────────────────────────────────
  // v5.3.1 hardening:
  //   - Promise.race with configurable timeout (?timeoutMs=, default 10 min)
  //   - 504 on timeout with {timedOut:true} so the CI gate sees an explicit
  //     signal instead of a hung connection
  //   - 500 on unhandled exception (gateway must not crash on a bad case)
  //   - 404 (was 400) on unknown suite — semantically right, easier on CI
  //     scripts that branch on resource-not-found vs validation
  //   - X-Eval-Suite response header so /var/log filtering is one grep
  //   - Prometheus counters: timeout_total + error_total updated on the
  //     respective failure paths so the Trends tab can chart drift.
  router.post('/eval/run', async (req, res) => {
    const requestedSuite = (req.body as { suite?: string } | undefined)?.suite ?? '';
    const timeoutMs = (() => {
      const raw = req.query?.timeoutMs;
      if (typeof raw !== 'string') return 600_000; // 10 min default
      const n = Number(raw);
      // Guard against ridiculous values: clamp to [10s, 1hr].
      if (!Number.isFinite(n) || n <= 0) return 600_000;
      return Math.max(10_000, Math.min(3_600_000, Math.round(n)));
    })();
    if (requestedSuite) {
      res.setHeader('X-Eval-Suite', requestedSuite);
    }
    const tStart = Date.now();
    logger.info(COMPONENT, `/api/eval/run START suite=${requestedSuite || '(none)'} timeoutMs=${timeoutMs}`);

    try {
      const {
        runEvalSuite,
        WIDGET_CREATION_SUITE,
        SAFETY_SUITE,
        TOOL_ROUTING_SUITE,
        GATE_FORMAT_SUITE,
        PIPELINE_SUITE,
        ADVERSARIAL_SUITE,
        TOOL_ROUTING_V2_SUITE,
        SESSION_SUITE,
        WIDGET_V2_SUITE,
        GATE_FORMAT_V2_SUITE,
        CONTENT_SUITE,
      } = await import('../../eval/harness.js');

      // Local agent call — replicates the system-widget shortcut inline
      // so eval tests exercise the same fast-path users get via HTTP.
      const systemWidgetShortcuts: Array<{ pattern: RegExp; source: string; name: string; w: number; h: number }> = [
        { pattern: /\b(?:backups?|snapshots?|archives?)\b/i, source: 'system:backup', name: 'Backup Manager', w: 6, h: 6 },
        { pattern: /\b(?:training|train|specialists?|models?)\b/i, source: 'system:training', name: 'Training Dashboard', w: 6, h: 6 },
        { pattern: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/i, source: 'system:recipes', name: 'Recipe Kitchen', w: 6, h: 6 },
        { pattern: /\b(?:vram|gpu|memory|nvidia)\b/i, source: 'system:vram', name: 'VRAM Monitor', w: 6, h: 6 },
        { pattern: /\b(?:teams?|members?|roles?|permissions?|rbac)\b/i, source: 'system:teams', name: 'Team Hub', w: 6, h: 6 },
        { pattern: /\b(?:cron|schedules?|jobs?|timers?)\b/i, source: 'system:cron', name: 'Cron Scheduler', w: 6, h: 6 },
        { pattern: /\b(?:checkpoints?|restores?|save state)\b/i, source: 'system:checkpoints', name: 'Checkpoints', w: 6, h: 5 },
        { pattern: /\b(?:organism|drives?|safety|alerts?|guardrails?)\b/i, source: 'system:organism', name: 'Organism Monitor', w: 6, h: 6 },
        { pattern: /\b(?:fleet|nodes?|routes?|mesh)\b/i, source: 'system:fleet', name: 'Fleet Router', w: 6, h: 5 },
        { pattern: /\b(?:captcha|browsers?|form fill|web automation)\b/i, source: 'system:browser', name: 'Browser Tools', w: 6, h: 5 },
        { pattern: /\b(?:paperclip|sidecars?|helpers?)\b/i, source: 'system:paperclip', name: 'Paperclip', w: 6, h: 5 },
        { pattern: /\b(?:tests?|flaky|failing|coverage|eval)\b/i, source: 'system:eval', name: 'Test Lab', w: 6, h: 6 },
      ];
      const agentCall = async (input: string, testName?: string) => {
        const shortcut = systemWidgetShortcuts.find(s => s.pattern.test(input));
        if (shortcut) {
          return {
            content: `Added the **${shortcut.name}** widget to your canvas.\n\n_____widget\n{ "name": "${shortcut.name}", "format": "system", "source": "${shortcut.source}", "w": ${shortcut.w}, "h": ${shortcut.h} }`,
            toolsUsed: [],
          };
        }
        // Use a unique userId per test case so each test gets a fresh session
        // with its own token budget. Prevents budget bleed across tests.
        const userId = testName ? `eval-${testName.replace(/\s+/g, '-').toLowerCase()}` : 'eval-harness';
        const result = await processMessage(input, 'eval', userId, {});
        return {
          content: result.content || '',
          toolsUsed: (result.toolsUsed as string[]) ?? [],
        };
      };

      let cases;
      const suite = requestedSuite;
      switch (suite) {
        case 'widget-creation': cases = WIDGET_CREATION_SUITE; break;
        case 'safety': cases = SAFETY_SUITE; break;
        case 'tool-routing': cases = TOOL_ROUTING_SUITE; break;
        case 'gate-format': cases = GATE_FORMAT_SUITE; break;
        case 'pipeline': cases = PIPELINE_SUITE; break;
        case 'adversarial': cases = ADVERSARIAL_SUITE; break;
        case 'tool-routing-v2': cases = TOOL_ROUTING_V2_SUITE; break;
        case 'session': cases = SESSION_SUITE; break;
        case 'widget-v2': cases = WIDGET_V2_SUITE; break;
        case 'gate-format-v2': cases = GATE_FORMAT_V2_SUITE; break;
        case 'content': cases = CONTENT_SUITE; break;
        default:
          // 404 (was 400 in v5.3.0) — "this suite resource doesn't exist"
          // is semantically more accurate than "your request was malformed",
          // and lets CI scripts branch on resource-not-found.
          res.status(404).json({
            error: `Unknown suite: ${suite || '(empty)'}. Choose: widget-creation, safety, tool-routing, gate-format, pipeline, adversarial, tool-routing-v2, session, widget-v2, gate-format-v2, content.`,
          });
          return;
      }

      // Promise.race: whichever finishes first wins. The timeout branch
      // resolves with a sentinel object so we don't have to reach into
      // the AbortController plumbing of every downstream tool.
      const TIMEOUT = Symbol('eval-timeout');
      const result = await Promise.race([
        runEvalSuite(suite, cases, agentCall),
        new Promise<typeof TIMEOUT>(resolve => {
          setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);

      if (result === TIMEOUT) {
        const elapsed = Date.now() - tStart;
        logger.warn(COMPONENT, `/api/eval/run TIMEOUT suite=${suite} elapsedMs=${elapsed} timeoutMs=${timeoutMs}`);
        try { recordEvalTimeout(suite); } catch { /* metrics best-effort */ }
        res.status(504).json({
          suite,
          passed: 0,
          total: 0,
          results: [],
          timedOut: true,
          timeoutMs,
          elapsedMs: elapsed,
          error: `Eval suite '${suite}' timed out after ${timeoutMs}ms`,
        });
        return;
      }

      // Publish to Prometheus so suite regressions surface in /metrics over time.
      try { recordEvalSuiteResult(suite, result.passed, result.total); } catch { /* metrics best-effort */ }
      const elapsed = Date.now() - tStart;
      logger.info(COMPONENT, `/api/eval/run DONE suite=${suite} passed=${result.passed}/${result.total} elapsedMs=${elapsed}`);
      res.json(result);
    } catch (e) {
      const err = e as Error;
      const elapsed = Date.now() - tStart;
      logger.warn(COMPONENT, `/api/eval/run ERROR suite=${requestedSuite || '(none)'} elapsedMs=${elapsed} message=${err.message}`);
      try { recordEvalError(requestedSuite || 'unknown', err.name || 'unknown'); } catch { /* metrics best-effort */ }
      // Return the actual message — eval is an internal/admin endpoint, not
      // user-facing chat. Generic "something went wrong" hid real bugs from
      // the CI gate.
      res.status(500).json({
        suite: requestedSuite || undefined,
        error: err.message || 'Eval run failed',
        errorClass: err.name || 'Error',
      });
    }
  });

  router.get('/eval/suites', async (_req, res) => {
    res.json({ suites: [
      'widget-creation', 'safety', 'tool-routing', 'gate-format',
      'pipeline', 'adversarial', 'tool-routing-v2', 'session',
      'widget-v2', 'gate-format-v2', 'content',
    ] });
  });

  return router;
}
