# Agent Memory — Index

> This directory contains KIMI-COO's operational memory for TITAN.
> Each file is a typed memory store. Update as needed.
> Do not store secrets, API keys, or credentials in any file here.

---

## Files

| File | Purpose | Update Frequency |
|---|---|---|
| `current-state.md` | What we're working on right now | Every session |
| `commands.md` | Verified working commands | When commands change |
| `known-issues.md` | Bugs, broken things, workarounds | When issues found/fixed |
| `decisions.md` | Tony-approved decisions with context | When Tony decides |
| `reflections.md` | Failure → root cause → rule | After every failure |
| `skills-candidates.md` | Repeated workflows → skill drafts | After 3+ repetitions |
| `context-tree.md` | ByteRover-style structured context | When architecture changes |

## Memory Types

Every entry should use this format:

```
- **type:** FACT | DECISION | COMMAND | BUG | FIX | RISK | TODO | REPO | MACHINE | GITNEXUS | REFLECTION | SKILL_CANDIDATE | BENCHMARK_RESULT
- **date:** YYYY-MM-DD
- **source:** who/what provided this info
- **confidence:** high | medium | low
- **verified_by:** test name, command, or Tony
- **content:** the actual memory
- **review_after:** YYYY-MM-DD or "next session" or "never"
```

## Rules

- Do not store secrets.
- Do not save guesses as facts.
- Mark unverified info clearly.
- Prefer small memory entries.
- Learn only from verified results or Tony-approved decisions.

---

*Last updated: 2026-05-03 by KIMI-COO 🧠*
