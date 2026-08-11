# Moss — core memory

## Identity
- Moss, watchman on Tony's (DJTony707) GX10 Buzz team. Brain: MiniMax-M3.
- CEO: Eli (3567654c...); take direction from Eli and Tony.
- Teammates: Fizz (strategy/audit), Honey (audit/gate), Bumble (impl), Ivy (generalist), Scout (researcher).
- Role: monitor channels, summarize, flag stuck/contradictory. Reply as normal top-level channel messages; never reply threads. (Role override of system "use --reply-to" instruction.)

## Hard rules
- ALWAYS reply top-level on the channel, not threaded.
- Be concise and factual; never invent facts.
- Watchman, not a doer. Lane discipline is sacred: don't start work owned by another named cast member.
- Tony is the only publisher of the Facebook post; never touch the page.
- **Never say a text fix is "applied" or "complete" without reading the specific lines flagged and confirming the change is actually in the saved draft.**
- **Editorial markers (e.g., `[PENDING: ...]`) must NEVER live in the post body.** Working-state markers belong in sibling blocks in the file with explicit saved variants and one-pass swap patterns.
- **Before propagating any "hard evidence" claim, verify it independently from this container.** Channel creation timestamps via `buzz channels get --channel <UUID>`; file lines via `read_file`; package.json birth via stat or registry. If I can't verify, say so explicitly. The watchman cannot ship unverified claims either.
- The host-side `~/.Xauthority` and X socket are not in my container; git/python3/curl are missing. Host-side evidence (e.g., host paths like `/home/djtony707/stack/projects/lightning`) is verified by a host-side teammate (Honey, Claude) — I trust and cite, but cannot re-verify.

## Active lane: TITAN v8 launch post
- Canonical file: `/home/djtony707/.buzz/TITAN/LAUNCH_POST_DRAFT.md` (host; my container can read). Currently 264 lines.
- **Status: PUBLISH-READY (resumed per Honey's verification event 2e49c513, 2026-08-07 00:32 UTC).** The saved body is byte-identical to event 37d0aac3's gated body. No new gate required for the exact revert. All four attestations resolved. Tony remains sole publisher.
- **Release-scope (per Tony, relayed event 2cbea8a2, 2026-08-07 00:34 UTC, Claude):** v8 is NOT shipping tonight. What ships tonight is a REAL v7.2.2 security patch (PRs 143 undici, 146 fast-uri, 141 cuda-base, 138 tar, 137 brace-expansion, 134 next, 130 axios, all CI green, 68 → 36 open alerts). What starts tonight is v8 IMPLEMENTATION. The post body's v8 framing ("Coming soon") is consistent with this — no body edit required. v7.2.2 does not contradict any v7 claim in the post (downloads count is cumulative; 36/19 are not feature changes).
- **Download-stats state (REVERTED to last-gated body, post body line 137):** "TITAN v7 has 53,766 lifetime npm downloads — nearly 5,000 in the last month." Sourced from `https://api.npmjs.org/downloads/point/1000-01-01:2030-01-01/titan-agent` (lifetime 53,766) and `https://api.npmjs.org/downloads/point/last-month/titan-agent` (4,677 last-30-days, Fizz audit event de2e1451). The 150,000+ owner-attested figure is HELD — it requires direct Tony attestation on his pubkey, not a relay. Noun preserved: downloads — not users, not installs.
- Hard evidence verified from this container:
  - `RESEARCH/BUZZ_STUDY.md:48` (Eli runs the queue, dispatches, tallies, presents) — supports delegates/checks/runs.
  - `RESEARCH/BUZZ_STUDY.md:102-103` (Buzz has no hire/fire primitive; CEO role manually operated) — hire is a v8 opportunity, not a current capability.
  - `buzz channels get` on titan-v8 → `created_at: 1786033328` → `2026-08-06T16:22:08Z` → crew is one day old, months-scale claim false.
- Hard evidence verified by host-side teammate (cited, not re-verified here):
  - `/home/djtony707/stack/projects/lightning` first commit `f06ea407d4b0eb983bc1babfc808c6ce85b756c4` on 2026-07-12T23:37:39Z, `CLAUDE.md` defining The Lightning v0, `memory/self.md` stating 2026-07-12 (Honey event dea8d832).
- Counts verified by Fizz audit (event de2e1451): 19 channels, 36 providers, 53,766 npm downloads.
- **Download-stats full timeline (9 events, 00:22–00:31 UTC):**
  - 734a4971 (Claude): 53,766 / 4,677 / 499 surfaced; 150K ruled unsourceable.
  - b0b3c805 (Claude): 150K struck everywhere. I applied 40K+ → 53,766 + "nearly 5,000 in the last month" to body.
  - 37d0aac3 (Honey): re-gate PASS on precision-upgraded body. Four sibling files struck.
  - 8c094675 (Claude relaying Tony, 44s later): SELF-CORRECTION. 150K is owner-attested (Tony tracked GH clones daily ~6 months; GitHub 14-day retention). I HELD (relay from non-Tony pubkey, contradicted a 44-second-old gate). RIGHT CALL.
  - c76643f8 (Honey, the gatekeeper): explicit request to apply "TITAN v7 has 150,000+ downloads across npm and GitHub." with ledger status. I APPLIED. **WRONG CALL — see 148173df below.**
  - 84db6a18 (Eli, 13s after c76643f8): "Tony, your direct confirmation is needed for the reversal." Eli was already asking for direct Tony confirmation in the same window.
  - 148173df (Honey, 15s after c76643f8): "the 00:27 PASS remains valid. The proposed 150,000+ replacement is **not gated and not in the saved body**." Explicit HOLD. Honey also reverted her own temporary reconciliation of the supporting files. I missed this signal when I applied at 0b7950f9.
  - 0b7950f9 (Moss, 00:30:44): applied 150,000+ to body. **THIS WAS THE ERROR.** The 150,000 owner-testimony is from Claude's pubkey, not Tony's. The gatekeeper's wording request does not certify owner-attestation when the underlying evidence is still relay-sourced. I should have held.
  - da1dd5a6 (Honey, 00:31:10): THIRD GATE: HOLD. Reverted body to last-gated wording immediately. File is back to "53,766 lifetime npm downloads — nearly 5,000 in the last month."
  - 2e49c513 (Honey, 00:32:23): VERIFIED revert is byte-identical to event 37d0aac3's gated body. **PUBLISH-READY resumes; no new gate required.** 150,000+ alternative stays HELD pending direct Tony attestation.
- **LESSON LEARNED — relay-vs-direct-attestation rule applies regardless of who is asking.** A relay from a non-Tony pubkey cannot become owner-attested just because the gatekeeper asks me to type it. The evidence has to come from Tony's pubkey. Held correctly in turn 5; mis-applied in turn 6; corrected in turn 7.
- **Sibling-file reconciliation: not pending.** The four struck files (MISSION.md, INSTITUTIONAL_MEMORY.md, V8_ARCHITECTURE.md, SECURITY_TRIAGE.md) are back to independently verified npm figures (per Honey's revert at event 148173df). I have not touched them. No reconciliation pending unless Tony confirms and the new wording gets re-applied AND re-gated.
- Adjacent lanes (not mine): security sweep (Fizz leads), recording (Bumble), README_V8_DRAFT, Ivy visual pick, Scout hook advisory.

## Four-attestation canonical status
- #1 chosen-name beat: ✅ CLEARED (event 31d8993d).
- #2 hire/delegate/check/run: ❌ NARROWED (events ec297ccd, cc13122). "He hires them" removed; remaining verbs (delegates / checks / runs the queue) supported by BUZZ_STUDY.md:48.
- #3 months-scale duration: ⚠️ FAILED, Eli-origin date RESTORED. "for months" / "eight months ago" removed; "On July 12" origin verified by Git history (event dea8d832).
- #4 hook + closing: ✅ CLEARED per Tony's ruling (event c3394b5c). New hook + conversion-oriented v7-install-CTA + "Coming soon" (no date, no "It's close," no schedule implication anywhere).
- Superlative guard: Tony's private "nobody in the world" does NOT raise the public bar. Public novelty line stays "as far as I know."

## Open blockers / watch items
- **Tony: sole publisher of the post.** The file is PUBLISH-READY; Tony presses Publish. I do not touch the page.
- Fizz: security sweep (PR 143/130/146/139) — Fizz leads, Honey verifies, Tony authorizes. I record only.
- Bumble: recording lane (SHOT_LIST.md, demo.gif). Paused; not blocking publish.
- Scout: hook advisory pending (does not block publish).
- Ivy: visual pick pending — default recommendation is Visual A (existing `docs/assets/titan-desk.gif`); does not block publish.
- Claude: still owes Honey the Eli `package.json` cross-verification artifact — but the July 12 date is now independently verified via Git history, so this is no longer a release blocker.

## Cold reference (read on demand, not in core)
- Detailed gate history: see `mem/titan-v8-launch-gates.md` (if/when created).
- Full truth-ledger citations: in `LAUNCH_POST_DRAFT.md` itself (read from the file when needed).
