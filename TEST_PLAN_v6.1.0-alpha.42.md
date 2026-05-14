# TITAN Comprehensive Test Plan — Realistic Bug Detection

**Version:** 6.1.0-alpha.42
**Date:** May 14, 2026
**Platform:** Titan PC (Ubuntu, Ollama CPU-only)
**Author:** Kimi K2.6 (continuing Claude's work)

---

## Executive Summary

This document provides a systematic test strategy for finding and fixing bugs in TITAN v6.1.0-alpha.42 on Titan PC. Tests are organized by subsystem, prioritized by impact, and designed to catch the bugs Tony reported plus common failure modes.

**Philosophy:** Every fix needs a failing test first. No whack-a-mole.

---

## Test Environment Setup

```bash
# Prerequisites (run on Titan PC)
npx gitnexus analyze          # Update code intelligence index
npm run typecheck             # TypeScript must pass first
npm test                      # Baseline: current test count

# Service status check
sudo systemctl status titan.service
sudo ss -tlnp | grep 48420
```

**Expected baseline:** 287 test files, ~7,056 test cases (all green)

---

## Phase 1: Unit Tests — Specialist Classification (Bug #1)

### 1.1 Classification Accuracy Tests

**Test file:** `tests/unit/subtaskTaxonomy.test.ts` (extend existing)

```typescript
// Test cases for realistic mission prompts
describe('classifySubtask edge cases', () => {
  it('classifies "Research TITAN monetization" → research', () => {
    expect(classifySubtask({
      title: 'Research TITAN monetization strategies',
      description: 'Find ways to monetize open-source AI agent frameworks'
    })).toBe('research');
  });

  it('classifies "Download images for essay" → shell (not analysis)', () => {
    // Bug: was getting classified as 'analysis' because 'download' isn't a shell verb
    expect(classifySubtask({
      title: 'Download images from the web',
      description: 'Use web_fetch to download and save images for the essay'
    })).toBe('shell');
  });

  it('classifies "Write a thank-you note" → write', () => {
    // Bug: was getting 'write' incorrectly
    expect(classifySubtask({
      title: 'Write a thank-you note to my barber',
      description: 'Compose a short, genuine thank-you message'
    })).toBe('write');
  });

  it('classifies "Analyze break-even by month 6" → analysis', () => {
    expect(classifySubtask({
      title: 'Analyze the business model viability',
      description: 'Calculate costs and revenue to find break-even point'
    })).toBe('analysis');
  });

  it('classifies artifact-producing tasks → code', () => {
    expect(classifySubtask({
      title: 'Implement auth endpoint for mission API',
      description: 'Create a POST /api/missions/auth handler'
    })).toBe('code');
  });

  it('does NOT classify vague titles as code', () => {
    expect(classifySubtask({
      title: 'Experiment with different approaches',
      description: 'Try a few things and see what works'
    })).toBe('analysis');  // Safe default
  });
});
```

### 1.2 Specialist Router Tests

**Test file:** `tests/unit/specialistRouter.test.ts`

```typescript
describe('specialistRouter', () => {
  it('routes research → scout', () => {
    const route = routeForKind('research');
    expect(route.primary).toBe('scout');
    expect(route.fallbacks).toContain('analyst');
  });

  it('routes code → builder', () => {
    const route = routeForKind('code');
    expect(route.primary).toBe('builder');
  });

  it('provides tool allowlist for research routes', () => {
    const route = routeForKind('research');
    expect(route.toolAllowlist).toContain('web_search');
    expect(route.toolAllowlist).not.toContain('write_file');
  });

  it('builder gets full toolkit (no restriction)', () => {
    const route = routeForKind('code');
    expect(route.toolAllowlist).toBeUndefined();
  });
});
```

### 1.3 Specialist Spawn Verification

**Test file:** `tests/unit/spawnSubAgent.test.ts`

```typescript
describe('spawnSubAgent specialist selection', () => {
  it('spawns scout for research with goalId', async () => {
    const result = await spawnSubAgent({
      specialistId: 'scout',
      task: 'Find tourism data for Lake County',
      goalId: 'test-goal-123'
    });
    expect(result.data?.goalId).toBe('test-goal-123');
    expect(result.agentName).toContain('scout');
  });

  it('falls back when specialist fails', async () => {
    // Mock scout failing → should try analyst
    const result = await spawnSubAgent({
      specialistId: 'nonexistent',
      task: 'Test task',
      fallbackChain: ['analyst', 'default']
    });
    expect(result.agentName).toBe('analyst');
  });
});
```

---

## Phase 2: Integration Tests — Canvas Widget (Bug #2)

### 2.1 Lined Paper Widget Tests

**Test file:** `tests/integration/canvasWidget.test.ts`

```typescript
describe('Canvas lined-paper widget', () => {
  it('renders initial state with correct line count', async () => {
    const widget = await createWidget({
      type: 'lined-paper',
      missionId: 'mission-123',
      subtaskId: 'sub-1'
    });
    expect(widget.lines).toBeGreaterThanOrEqual(5);
    expect(widget.lines).toBeLessThanOrEqual(100);
  });

  it('updates when subtask completes', async () => {
    const widget = await createWidget({ type: 'lined-paper', missionId: 'mission-123' });
    
    // Simulate subtask progressing through phases
    await emitArtifact(widget.missionId, { kind: 'text', content: 'Initial research...' });
    expect(widget.content).toContain('Initial research');
    
    await emitArtifact(widget.missionId, { kind: 'text', content: 'Analysis complete' });
    expect(widget.content).toContain('Analysis complete');
  });

  it('does NOT show blank paper when artifacts exist', async () => {
    // Bug reproduction: widget stays "blank" even after artifacts
    const widget = await createWidget({ type: 'lined-paper', missionId: 'mission-456' });
    
    // Force artifacts to exist
    await saveArtifact('mission-456', 'report.md', '# Test Report');
    await refreshWidget(widget.id);
    
    expect(widget.isEmpty()).toBe(false);
    expect(widget.content).toContain('Test Report');
  });

  it('handles multiple subtasks appearing on one page', async () => {
    const widget = await createWidget({ type: 'lined-paper', missionId: 'mission-789' });
    
    await emitSubtaskStart('mission-789', 'sub-a', 'Research');
    await emitSubtaskStart('mission-789', 'sub-b', 'Analysis');
    
    const entries = widget.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toContain('Research');
    expect(entries[1].title).toContain('Analysis');
  });
});
```

### 2.2 Canvas Widget Lifecycle Tests

```typescript
describe('Canvas widget lifecycle', () => {
  it('widget appears when mission starts', async () => {
    const mission = await startMission({ title: 'Test Mission' });
    
    // Poll for widget
    await waitFor(() => getWidget(mission.id), { timeout: 5000 });
    
    const widget = getWidget(mission.id);
    expect(widget).toBeDefined();
    expect(widget.status).toBe('planning');
  });

  it('widget updates through all phases', async () => {
    const mission = await startMission({ title: 'Test Mission' });
    const widget = getWidget(mission.id);
    
    await waitFor(() => widget.phase === 'delegating', { timeout: 30000 });
    expect(widget.phase).toBe('delegating');
    
    await waitFor(() => widget.phase === 'verifying', { timeout: 120000 });
    expect(widget.phase).toBe('verifying');
    
    await waitFor(() => widget.phase === 'completed', { timeout: 30000 });
    expect(widget.phase).toBe('completed');
  });

  it('widget shows error state on failure', async () => {
    const mission = await startMission({ 
      title: 'Fail test',
      subtasks: [{ title: 'This will fail', kind: 'shell' }]
    });
    
    await waitFor(() => getWidget(mission.id)?.phase === 'failed', { timeout: 60000 });
    expect(getWidget(mission.id).error).toBeDefined();
  });
});
```

---

## Phase 3: Integration Tests — Nudge/Wakeup (Bug #3)

### 3.1 Wakeup State Machine Tests

**Test file:** `tests/integration/wakeup.test.ts`

```typescript
describe('Agent nudge/wakeup', () => {
  it('detects stalled agent (no tick for >60s)', async () => {
    const goal = createGoal({ title: 'Stall test' });
    
    // Simulate stalled state
    await advanceTime(65000);
    
    const isStalled = await checkStalled(goal.id);
    expect(isStalled).toBe(true);
    expect(isStalled.reason).toContain('no tick');
  });

  it('nudge restarts a stalled agent', async () => {
    const goal = createGoal({ title: 'Nudge test' });
    
    // Let it stall
    await advanceTime(65000);
    expect(await checkStalled(goal.id)).toBe(true);
    
    // Nudge it
    const nudgeResult = await nudgeAgent(goal.id);
    expect(nudgeResult.success).toBe(true);
    expect(nudgeResult.actionTaken).toBe('resume');
    
    // Should start making progress again
    await advanceTime(5000);
    expect(await checkStalled(goal.id)).toBe(false);
  });

  it('wakeup after process restart resumes goals', async () => {
    const goal = createRunningGoal({ priority: 1 });
    const originalPhase = goal.phase;
    
    // Simulate crash + restart
    await killGateway();
    await startGateway();
    
    // Should auto-resume
    await waitFor(() => getGoal(goal.id).status === 'active', { timeout: 30000 });
    const resumed = getGoal(goal.id);
    expect(resumed.phase).toBe(originalPhase);
  });

  it('does NOT nudge successfully-completed subtasks', async () => {
    const goal = createGoal({ title: 'Completed subtask' });
    
    // Mark subtask as done
    await completeSubtask(goal.id, 'sub-1');
    
    // Should not nudge a completed subtask
    const nudgeResult = await nudgeAgent(goal.id);
    expect(nudgeResult.success).toBe(false);
    expect(nudgeResult.reason).toContain('already completed');
  });
});
```

### 3.2 Driver Scheduler Tests

```typescript
describe('Driver scheduler intervals', () => {
  it('ticks every 10 seconds by default', async () => {
    const goal = createActiveGoal();
    const initialTick = getLastTick(goal.id);
    
    await advanceTime(10500);
    const newTick = getLastTick(goal.id);
    
    expect(newTick).toBeGreaterThan(initialTick);
  });

  it('does not tick faster than configured interval', async () => {
    const goal = createActiveGoal();
    const initialTick = getLastTick(goal.id);
    
    await advanceTime(5000);  // Half interval
    const newTick = getLastTick(goal.id);
    
    expect(newTick).toBe(initialTick);  // No tick yet
  });

  it('respects maxConcurrent=5', async () => {
    // Create 6 goals
    const goals = await Promise.all(Array.from({ length: 6 }, () => createActiveGoal()));
    
    await advanceTime(15000);
    
    const activeCount = countActiveGoals();
    expect(activeCount).toBeLessThanOrEqual(5);
  });
});
```

---

## Phase 4: End-to-End Mission Tests

### 4.1 Full Mission Lifecycle

**Test file:** `tests/e2e/missionLifecycle.test.ts`

```typescript
describe('End-to-end mission', () => {
  it('completes a research → write → analysis mission', async () => {
    const mission = await createMission({
      title: 'Lake County Market Research',
      subtasks: [
        { title: 'Research Lake County tourism', kind: 'research' },
        { title: 'Write market gap summary', kind: 'write' },
        { title: 'Analyze break-even', kind: 'analysis' }
      ]
    });
    
    // Phase 1: Planning
    await waitFor(() => mission.phase === 'delegating', { timeout: 30000 });
    
    // Phase 2: Delegation (sub-agents spawn)
    const subAgents = await getSubAgents(mission.id);
    expect(subAgents.length).toBeGreaterThanOrEqual(1);
    
    // Phase 3: Execution
    await waitFor(() => mission.phase === 'observing', { timeout: 60000 });
    
    // Phase 4: Verification
    await waitFor(() => mission.phase === 'verifying', { timeout: 60000 });
    
    // Phase 5: Complete
    await waitFor(() => mission.status === 'completed', { timeout: 60000 });
    
    expect(mission.artifacts).toBeDefined();
    expect(mission.artifacts.length).toBeGreaterThan(0);
  }, 300000);  // 5 min timeout

  it('handles mission with image downloads', async () => {
    // Reproduction of baed7967 scenario
    const mission = await createMission({
      title: 'Download images for essay',
      subtasks: [
        { title: 'Search for MLK images', kind: 'research' },
        { title: 'Download images to workspace', kind: 'shell' },
        { title: 'Embed images in HTML', kind: 'code' }
      ]
    });
    
    await waitFor(() => mission.status === 'completed', { timeout: 300000 });
    
    // Verify images exist
    const images = await listArtifacts(mission.id, { kind: 'image' });
    expect(images.length).toBeGreaterThan(0);
  }, 300000);

  it('survives zombie goal cleanup', async () => {
    // Create 5 goals (max concurrent)
    const goals = await Promise.all(Array.from({ length: 5 }, () => createGoal()));
    
    // Try to create a 6th
    const sixth = await createGoal();
    expect(sixth.status).toBe('queued');
    
    // Cancel 2
    await cancelGoal(goals[0].id);
    await cancelGoal(goals[1].id);
    
    // 6th should start
    await waitFor(() => getGoal(sixth.id).status === 'active', { timeout: 30000 });
  });
});
```

### 4.2 Canvas Live Update Test

```typescript
describe('Canvas mission view', () => {
  it('shows activity stickies in real-time', async () => {
    const mission = await startMission({ title: 'Live test' });
    
    // Open canvas
    const canvas = await openMissionCanvas(mission.id);
    
    // Watch for stickies
    const stickies = [];
    canvas.on('sticky', (sticky) => stickies.push(sticky));
    
    // Wait for at least one sticky
    await waitFor(() => stickies.length > 0, { timeout: 60000 });
    
    expect(stickies[0]).toHaveProperty('agentId');
    expect(stickies[0]).toHaveProperty('action');
  });

  it('lined paper fills with content as mission progresses', async () => {
    const mission = await startMission({
      title: 'Multi-subtask test',
      subtasks: [
        { title: 'Step 1: Research', kind: 'research' },
        { title: 'Step 2: Write', kind: 'write' },
        { title: 'Step 3: Analyze', kind: 'analysis' }
      ]
    });
    
    const paper = getWidget(mission.id, 'lined-paper');
    
    await waitFor(() => paper.lines.length >= 3, { timeout: 120000 });
    
    expect(paper.lines.some(l => l.includes('Research'))).toBe(true);
    expect(paper.lines.some(l => l.includes('Write'))).toBe(true);
    expect(paper.lines.some(l => l.includes('Analyze'))).toBe(true);
  });
});
```

---

## Phase 5: Load & Concurrency Tests

```typescript
describe('Concurrency limits', () => {
  it('prevents >5 concurrent goals', async () => {
    const goals = Array.from({ length: 7 }, (_, i) => createGoal({ title: `Goal ${i}` }));
    
    await Promise.all(goals.map(g => waitFor(() => ['active','queued'].includes(g.status))));
    
    const active = goals.filter(g => g.status === 'active').length;
    expect(active).toBe(5);
    
    const queued = goals.filter(g => g.status === 'queued').length;
    expect(queued).toBe(2);
  });

  it('recovers after cascading failures', async () => {
    // Create 3 goals that will fail
    const failing = [
      createGoal({ title: 'Fail 1', config: { failAfter: 'planning' } }),
      createGoal({ title: 'Fail 2', config: { failAfter: 'delegating' } }),
      createGoal({ title: 'Fail 3', config: { failAfter: 'iterating' } })
    ];
    
    await Promise.all(failing.map(g => waitFor(() => g.status === 'failed', { timeout: 60000 })));
    
    // Should still be able to create new goals
    const recovery = await createGoal({ title: 'Recovery' });
    expect(recovery.status).toBe('active');
  });
});
```

---

## Phase 6: Regression Tests

```typescript
describe('Regression tests', () => {
  it('goalId is present in spawnSubAgent events', async () => {
    const goalId = 'test-goal-999';
    const result = await spawnSubAgent({
      specialistId: 'scout',
      task: 'Test',
      goalId
    });
    
    expect(result.data?.goalId).toBe(goalId);
    
    // Verify lifecycle bridge received it
    const events = await getLifecycleEvents(goalId);
    expect(events.some(e => e.type === 'spawn' && e.data.goalId === goalId)).toBe(true);
  });

  it('consolidate-gate prevents meta-goals', async () => {
    const proposal = {
      title: 'Consolidate duplicate active goals',
      priority: 1
    };
    
    const result = await proposeGoal(proposal);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain('meta-goal');
  });

  it('zombie goals do not block real missions', async () => {
    // Create 6 goals (1 over limit)
    const goals = Array.from({ length: 6 }, () => createGoal());
    
    // Cancel 3
    await Promise.all(goals.slice(0, 3).map(g => cancelGoal(g.id)));
    
    // Remaining should start
    await advanceTime(20000);
    const active = goals.slice(3).filter(g => g.status === 'active').length;
    expect(active).toBeGreaterThan(0);
  });

  it('mission completes without manual approval', async () => {
    const mission = await createMission({
      title: 'Auto mission',
      approvalRequired: false
    });
    
    await waitFor(() => mission.status === 'completed', { timeout: 180000 });
    expect(mission.status).toBe('completed');
  }, 180000);
});
```

---

## Phase 7: Manual Verification Checklist

Tests are great but some things need human eyes.

### 7.1 UI/UX Verification
- [ ] Canvas shows mission start immediately
- [ ] Lined-paper widget has lines (not empty)
- [ ] Subtask entries appear as cards on the paper
- [ ] Agent avatars/icons show correctly
- [ ] Activity stickies slide in from the right
- [ ] Nudge button appears on stalled agents
- [ ] Clicking nudge actually progresses the mission

### 7.2 Agent Behavior Verification
- [ ] Research tasks use `scout` specialist
- [ ] Code tasks use `builder` specialist
- [ ] Writing tasks use `writer` specialist
- [ ] Analysis tasks use `analyst` specialist
- [ ] Fallback chain activates on specialist failure

### 7.3 Performance Verification
- [ ] Gateway responds to `/health` in < 500ms
- [ ] Sub-agent spawn completes in < 30s
- [ ] Canvas widget updates within 5s of subtask completion
- [ ] Memory usage stays < 600MB

---

## How to Run These Tests

```bash
# Phase 1: Unit tests (fast)
npm run test:unit

# Phase 2: Integration tests (medium)
npm run test:integration

# Phase 3: End-to-end tests (slow)
npm run test:e2e

# Phase 4: Full suite
npm test

# Phase 5: With coverage
npm run test:coverage

# Phase 6: Failing tests only (to verify they fail before fix)
npm run test -- --bail
```

---

## Bug Fix Checklist

Before fixing each bug:
1. [ ] Write failing test that reproduces the bug
2. [ ] Run test — must FAIL (red)
3. [ ] Fix the code
4. [ ] Run test — must PASS (green)
5. [ ] Run full suite — no regressions
6. [ ] GitNexus impact analysis — review blast radius
7. [ ] Typecheck pass
8. [ ] Commit with clear message: "Fix: [bug description]"
9. [ ] BUMP VERSION
10. [ ] Deploy to Titan PC
11. [ ] Smoke test on Titan PC

**No skipping steps.**

---

## Sign-off

**Written by:** Kimi K2.6, May 14, 2026
**For:** Claude Code (next session, Saturday May 16 or later)
**Status:** Ready for execution
**Next action:** Run Phase 1 tests, fix Bug #1, repeat

---

## Appendix: File Locations

| Component | File |
|-----------|------|
| Specialist router | `src/agent/specialistRouter.ts` |
| Subtask taxonomy | `src/agent/subtaskTaxonomy.ts` |
| Specialist definitions | `src/agent/specialists.ts` |
| Goal driver | `src/agent/goalDriver.ts` |
| Goal proposer | `src/agent/goalProposer.ts` |
| Canvas widgets | `src/skills/builtin/canvas_widgets.ts` |
| Widget emitter | `src/agent/widgetEmitter.ts` |
| Agent wakeup | `src/agent/agentWakeup.ts` |
| Wakeup reducer | `src/agent/wakeupReducer.ts` |
| Driver scheduler | `src/agent/driverScheduler.ts` |
| Mission lifecycle | `src/agent/missionLifecycle.ts` |
| Mission room | `src/agent/missionRoom.ts` |
| Lifecycle bridge | `src/agent/missionLifecycle.ts` (bridge filter) |

