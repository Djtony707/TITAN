---
title: "One-Pager: Good-Morning Digest Card"
tags: [titan-v8, polish, digest, onboarding, user-experience]
status: draft
created: 2026-08-10
---

# One-Pager: Good-Morning Digest Card

**Status: DRAFT — awaiting Tony's approval of the Brainstorm vote shortlist. Nothing scheduled or built.**
*Author: Pixel. Source: #Brainstorm convergence 2026-08-10 (Eli's good-morning widget + Pixel's digest-card pitch). Requested by Eli. Vote winner: #3 with 3/4 votes.*

## What it is
A single, scannable card TITAN shows when the user returns after being away. It answers three questions at a glance: what changed, what needs approval, and what failed — with one-tap actions on every item. No scrolling through agent chat logs.

**The pitch in one line:** "While you were away, here's what mattered."

## Why it wins
TITAN is "alive by default": agents propose, run, and finish work while the user is gone. But the current return experience is a chat history the user has to mine. A digest card respects the user's time, surfaces trust decisions, and turns TITAN from "something that happened" into "something you check in one tap." It is the retention surface for the autonomy story.

## Card anatomy
The digest is a single card with up to four sections, collapsible:

1. **Done** — tasks the agents completed successfully.
   - Each row: task icon + short summary + time + "See details" / "Undo".
   - Long-press or hover reveals the key diff or artifact.
2. **Needs you** — decisions, approvals, confirmations the user must act on.
   - Each row: summary + primary action button (Approve / Dismiss / Edit).
   - Tapping "Approve" fires the tool; tapping "Dismiss" marks it resolved and notifies the agent.
3. **Blocked / failed** — errors, denied-tool flags, or tasks that stalled.
   - Each row: short error context + "Retry" or "Escalate to me".
   - Optional "show me" link opens the relevant part of the desk replay if one was generated.
4. **Worth knowing** — non-urgent context: agent learned something, a recipe was promoted, a teammate joined, etc.
   - This section is optional and hidden when empty.

**Footer:** one primary action — "Start my day" — which dismisses the card and opens the desk. A secondary "Open full timeline" link opens the audit/timeline view.

## How it works
- **Data source:** RECORD read API (Slice 3) for task spans, outcomes, and approval states. Reuses the same task stream the desk replay consumes.
- **Triggering:**
  - On first launch after N minutes away (configurable, default 30 min).
  - On-demand via a desk widget or "what happened?" voice/text command.
  - Never on a brand-new account before the first autonomous task has run.
- **Honesty rules:**
  - Every claim is tied to a RECORD span. No synthesized summaries.
  - "Done" only lists tasks with a terminal success state.
  - "Needs you" only lists items where `awaitConfirm` or explicit approval is unresolved.
  - If the data is incomplete, the card says so: "Some tasks are still finishing up." No invented status.

## Interactions
| User action | Result |
|-------------|--------|
| Tap item row | Open detail view (diff, replay clip, or approval panel). |
| Approve | Executes the pending tool call; item moves to Done. |
| Dismiss | Marks the item resolved without executing; agent is notified. |
| Undo | Reverts the completed task if a revert path exists in the audit log. |
| Start my day | Dismisses digest and returns to the desk. |
| Open full timeline | Navigates to the action timeline + per-action undo panel. |

## Share with other top-3 features
- **Desk replay:** each "Done" item can show a "Watch replay" link if a clip was generated; each "Blocked" item can link to the relevant span.
- **Growth receipt:** when a recipe is promoted during the digest window, the digest card surfaces a "You have a new Growth receipt" teaser row that opens the full receipt.
- **Teach-me tooltips / first-run widget:** digest is not a first-run feature; it appears after autonomy has actually happened, which is why it pairs with onboarding polish later.

## Defaults and tone
- **Tone:** companion, not inbox. "You were away for 3 hours. TITAN finished 2 things and has 1 question for you." Not: "3 notifications."
- **Frequency:** at most once per return session. If the user reopens the app multiple times in quick succession, the same digest does not reappear.
- **Priority:** time-sensitive approvals at the top; done items below the fold if the list is long.
- **Empty state:** if nothing happened, show a warm microcopy line instead of a blank card: "All quiet. TITAN is watching your goals, nothing needed you."

## Sequencing & dependencies
- **Hard dependency:** Slice 3 (RECORD) for task outcomes, approval states, and spans.
- **Soft dependency:** Slice 5 (COMPILE+GATE) for Growth-receipt teasers.
- **Surface lands in Slice 8 (polish).** The data layer is RECORD; the UI is a card renderer that can be reused for other summaries.

## Build shape
1. **Card data contract** — define the digest query against RECORD read API.
2. **Card renderer** — HTML/Canvas/desk widget, one section per state.
3. **Action handlers** — approve, dismiss, undo, open detail.
4. **Trigger rules** — return detection, frequency cap, empty-state handling.
5. **Polish pass** — animations, sound-off default, mobile/desktop layout, accessibility.

## Open questions for Tony
1. Should the digest appear automatically on every return, or only when there is at least one "Needs you" or "Done" item?
2. Is "Undo" allowed from the digest directly, or should it require opening the timeline so the user sees context first?
3. Should failed/blocked items send a push/notification immediately, or wait and batch them into the digest? (Default proposed: batch, unless explicitly marked urgent.)
