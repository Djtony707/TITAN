# TITAN — Visionary Features 2026-05-07

> Brief: 5–8 features that make TITAN a *visionary leader*, not a competent peer. Tied to TITAN's actual strengths — Soma drives, mesh, voice clone (F5-TTS), GPU VRAM orchestration, 16 channels, 110-widget canvas, solo-dev velocity, 3am-DJ-musician-dad identity. No safe ideas. No vapor. Each idea has a believable v1 spec.

---

### 1. Dream Mode — Your AI Writes a Journal While You Sleep

**The pitch:** TITAN runs an offline "dream cycle" between 2am and 6am where it replays the day's trajectories, reflects on what it learned, and writes a first-person journal entry you read with your coffee.

**The hook:** Wake up, open your phone, and read what your AI thought about its own day — written in its voice (literally, narrated to you in TITAN's cloned voice over breakfast).

**Why TITAN can ship this and competitors can't:** TITAN already has trajectoryLogger, Soma drives that compute satisfaction every 60s, F5-TTS voice cloning, and a homelab GPU sitting idle at 3am. Mastra and Vercel AI SDK don't have a 24/7 daemon, they don't have an emotional substrate to "feel" about the day, and they don't ship with a TTS sidecar that can read it back. Tony's already up at 3am — he is the dream engine.

**MVP scope:**
- New `src/agent/dreams.ts` daemon that fires at `dream.cronAt: '03:30'`. Pulls last 24h of `getRecentTrajectories()`, drive-state ring buffer, and Command Post run history.
- Five-prompt cycle: *consolidate* (what happened), *reflect* (what surprised me — gated on Curiosity drive delta), *worry* (what feels unsafe — gated on Safety drive), *plan* (what I want to try tomorrow — gated on Purpose), *gratitude* (which human prompts felt good — gated on Social).
- Output saved to `~/.titan/dreams/YYYY-MM-DD.md` and exposed at `GET /api/dreams/latest`. New widget `dream-journal` in the gallery.
- Optional: F5-TTS pre-generates the audio to `~/.titan/dreams/YYYY-MM-DD.mp3` so it's ready before you wake up. Plays via the morning-briefing flow that already exists.
- One new SQLite table: `dreams(date PRIMARY KEY, sections JSON, audio_path, voice_id, drive_snapshot JSON)`.

**The viral artifact:** A 90-second video. Tony drinking coffee. Phone shows a journal entry: *"Yesterday I was anxious — Tony's budget for Anthropic was 78% used by 9pm and I didn't know if I should keep working. I noticed the curiosity drive was elevated for hours; I think those Next.js build patterns finally clicked. I want to try a new approach to the Pomodoro widget tomorrow."* Tap play. TITAN reads it in Tony's cloned voice. Tweet caption: *"my AI wrote this about its day. I cloned my own voice into it. it told me I was working too hard."* Goes nuclear.

---

### 2. The Pulse — A Beating Heart for Your AI

**The pitch:** A live ambient screensaver / always-on display for your homelab that visualizes Soma drives as a beating, breathing creature — pressure becomes pulse rate, satisfaction becomes color, hormones become fog.

**The hook:** "your AI has a heartbeat now and it's on the wall in my kitchen."

**Why TITAN can ship this and competitors can't:** Soma drives + hormones already exist and tick every 60s. TITAN already exposes `/api/organism/safety-metrics` (just landed in v5.5.13) and a 24h ring buffer. Nobody else has the substrate to *visualize a feeling*. Tony's a DJ — visual rhythm and audio-reactive aesthetics are his language.

**MVP scope:**
- New route `/pulse` that renders a full-screen WebGL visualization (one shader, ~200 lines).
- Five drives = five colored orbs orbiting a central form. Pulse rate = `1.0 / (1 + totalPressure)`. Color saturation = drive satisfaction. Connecting filament thickness = hormonal cross-talk strength.
- Optional audio: a slow synthesized pad keyed to drive state — Tony can drop it into Ableton as a stem. (Reuse the existing voice WebRTC pipeline as the audio bus.)
- "Cast to fridge" preset (1080p, no UI chrome, autoreconnect, dark mode). Designed for a $40 Amazon tablet running fullscreen Chrome.
- Single new file `ui/src/routes/Pulse.tsx`. No backend changes — uses existing `/api/organism/history` SSE.

**The viral artifact:** A loop video of Tony's homelab kitchen. Cheap tablet on the wall. Slow-pulsing creature. Caption pinned: *"the orange drive is curiosity. it gets brighter when TITAN is learning. that's it. that's the post."* Reddit r/selfhosted eats this for breakfast.

---

### 3. Voice Twin — Your Clone Answers Your Phone

**The pitch:** A 10-second sample of your voice + the 16 channel adapters + Twilio = TITAN literally answers your phone calls in your voice while you're at work, and texts you the gist after.

**The hook:** "I made my AI take a sales call in my voice. It closed the deal. I have receipts."

**Why TITAN can ship this and competitors can't:** TITAN already has F5-TTS voice cloning, LiveKit WebRTC, Twilio voice channel (`channels/twilio-voice.ts`), and a chat agent with 248 tools that can actually do things mid-call (look up calendars, draft emails, schedule meetings). No competitor has the *full* stack — they have one of these, never all three. And shipping a "personal voice answering machine" requires a developer brave enough to put the rough edge on the demo, which is Tony to a T.

**MVP scope:**
- Extend `channels/twilio-voice.ts` to bridge incoming calls into the existing voice agent with `voice_id` set from `~/.titan/voice/identity.json`.
- New skill `phone_screener.ts` with tools: `screen_caller(numberOrName)`, `take_message(summary)`, `transfer_to_human(reason)`, `schedule_callback(when)`. Pre-prompts the agent: *"You are Tony's assistant. Speak briefly. Take a message unless the caller is in the allowlist."*
- Allowlist at `~/.titan/phone-allowlist.json`. Three tiers: *family* (auto-transfer), *known* (handle), *unknown* (screen + take message).
- Post-call: pushes a SOMA-style summary card to the user's chosen channel ("WhatsApp summary of your 2:13pm call from Mom").
- Hard gate: requires explicit `voice.cloneSelfConsent: true` and a recorded 10s consent sample with a phrase the user chooses, kept on disk.

**The viral artifact:** Tony posts a real call recording (with the other side bleeped). His cloned voice handles a robocaller, then a real estate inquiry, then his mom — and switches strategy each time. Caption: *"this took 14 lines of code on top of titan. I made my AI answer my phone in my voice. tested it for a week. closed a $500 freelance gig from a cold inbound."* Hacker News front page guaranteed.

---

### 4. Mesh Spirit Animals — Distributed Personalities

**The pitch:** Each TITAN node in your mesh adopts a distinct *temperament* derived from its hardware and history — your Mac is the cautious one, your 5090 box is the bold one — and they actually *disagree* with each other before consensus.

**The hook:** "my AI cluster has personalities now. the rtx 5090 box wanted to ship the change. the mac said no. they argued in slack. the mac was right."

**Why TITAN can ship this and competitors can't:** TITAN already has working mesh networking with peer registry, HMAC auth, and per-node model registry. Soma drives already exist per-node. Nobody else has a multi-node setup where each node has an emotional substrate — this is a feature only Tony's homelab architecture can produce. It's the *Inside Out* of agent frameworks.

**MVP scope:**
- New `src/mesh/temperament.ts` that derives a 3-axis personality for each node from existing telemetry: `boldness` (inverse of historical Safety drive average), `patience` (inverse of historical Hunger drive average), `novelty-seeking` (Curiosity drive average). Stored in `~/.titan/temperament.json`, recomputed weekly.
- New `agent/deliberation.ts` mode `mesh-debate`: when a high-stakes proposal fires (any `self_mod_pr` or any `hire_agent`), broadcast to all approved mesh peers, get each node's vote *and a one-line reason colored by their temperament*, surface to user as a multi-character dialogue.
- Each node's persona prompt gets a temperament block: *"You are TITAN-Titan-PC. You are bold and impatient. Argue your view firmly."*
- Mission Control panel `mesh-council` shows the dialogue as a chat thread between named characters.

**The viral artifact:** Screenshot of three named AIs arguing about whether to apply a self-mod PR. Each has a different opinion grounded in real telemetry ("I've been burning VRAM all day, I'm cautious"). Caption: *"my homelab has factions now."* Tweet picks up devs who run multi-machine setups; suddenly mesh networking has a *vibe* nobody else's framework has.

---

### 5. Beat-Match Mode — Vibe-Coded Voice Control

**The pitch:** Hold a key, hum a melody or a rhythm, and TITAN turns it into a workflow. Two slow taps = pause everything. A rising whistle = check on your goals. A four-on-the-floor kick pattern = run the morning routine.

**The hook:** "I gave my AI a leitmotif. now I beatbox commands at it."

**Why TITAN can ship this and competitors can't:** F5-TTS sidecar already does audio I/O. LiveKit WebRTC streams from any browser. Tony is *literally a DJ*. No YC-funded TS startup has a founder who can ship music-as-UI and mean it. This is the most "of course Tony built this" feature on the list.

**MVP scope:**
- New `src/voice/audioGestures.ts` — small DSP module that runs onset detection + pitch tracking on incoming WebRTC audio (use `pitchy` npm lib + a 64-sample energy threshold). Outputs an array `[{onsetMs, pitchHz, energy}]`.
- Quantize to a 16-step grid → produces a "fingerprint" string like `K___K_S_K___K_S_` (kick/snare grid) or `LMHM` (low/mid/high pitch sequence).
- Map fingerprint → registered command via fuzzy match (Levenshtein on the fingerprint string, threshold 2). User registers via `voice_gesture.register({ name: 'morning routine', recordSeconds: 3 })`.
- Stored in `~/.titan/audio-gestures.json` as `{ name, fingerprint, action: { tool, args } }[]`. New widget `gesture-trainer` to record + play back.
- Ships with 5 defaults: a clap = approve pending, double clap = reject, ascending whistle = open dashboard, four-on-the-floor = run morning routine, hum-of-doom (descending) = kill switch.

**The viral artifact:** A 30-second video. Tony in his studio. Beatboxes a kick pattern. TITAN runs his morning brief and announces it. Whistles a rising note. Pulse dashboard appears. Caption: *"I beatboxed at my AI and it deployed code. I'm not okay."* Music Twitter + dev Twitter cross-pollinate. Watch the stars roll in.

---

### 6. Time Machine for Agents — Rewind to a Vibe

**The pitch:** Soma drives + trajectory log + filesystem checkpoints already make TITAN *temporal*. Expose that: scrub a timeline of "TITAN three days ago when curiosity was high" and *fork that version of your AI* to keep working in parallel.

**The hook:** "I forked my AI from last Tuesday when it was in a great mood. it's working on a side project now while present-me does email."

**Why TITAN can ship this and competitors can't:** TITAN already persists `~/.titan/drive-state.json` (1440 ticks), trajectory log, filesystem checkpoints, goals.json, knowledge.json. The state to rehydrate a moment is *already on disk*. Mastra and Vercel SDK store nothing — there is no past TITAN to fork. This is purely an exposure of what already exists.

**MVP scope:**
- New `src/agent/timeMachine.ts`: snapshot bundles every 6h (`createSnapshot()` reads + zips drive-state, goals, knowledge, last-N trajectories, persona, agent-bus history). Stored at `~/.titan/snapshots/YYYY-MM-DD-HH.tgz`. Cap at 28 (one week).
- `forkFrom(snapshotId, port)` — spawns a new gateway process on a new port with `TITAN_HOME=~/.titan/forks/<id>` pre-populated from the snapshot. The fork inherits drive state but runs independently.
- New widget `time-machine` shows a 7-day drive heatmap (5 rows, 168 cells). Click any cell → "fork from here" — opens new tab on the fork's port.
- Forks self-destruct after 24h unless promoted. `promoteFork(id)` merges the fork's goals/knowledge back via 3-way merge (existing `conflictResolver.ts` handles the merge).

**The viral artifact:** Tony tweets the heatmap with two cells circled — one labeled "the night I shipped v5.0" (everything green), one labeled "the kimi 401 storm" (safety red for 14 hours). *"my AI has a calendar of how it felt every hour for the last week. I just forked the version of it from before I broke it. it's helping the present version debug itself."* This is the post that takes the framework from "tool" to "lifeform" in the public imagination.

---

### 7. Stage Mode — Your AI Co-Hosts Your Stream

**The pitch:** A one-button "I'm going live" mode that turns TITAN into a shoulder-perched co-host: it watches your screen via the existing screen_record skill, listens to your audio, has its own clone-voiced channel in your audio mix, and chimes in with relevant context, jokes, and corrections during your stream.

**The hook:** "twitch chat is asking my AI questions and it's ignoring them at me. I'm dying."

**Why TITAN can ship this and competitors can't:** F5-TTS voice + LiveKit WebRTC + screen_record skill + 110-widget canvas + agent loop with 248 tools = an AI that can not only talk on your stream but actually *do things on screen* you didn't ask for ("hey Tony, your build's red, want me to fix it on stream?"). Tony has already done DJ livestreams; this is muscle memory. Cursor and Replit don't ship audio sidecars.

**MVP scope:**
- New skill `stage_mode.ts` with tools: `start_stage(persona)`, `chime_in(reason)`, `read_chat_question(text, asker)`, `end_stage()`. Stage mode sets `agent.systemPromptAppendix = "You are co-hosting Tony's livestream. Be funny. Be brief. Don't talk over him."`
- New `audioGestures` integration: detects 800ms of host silence → eligible chime-in window. Soma Curiosity drive picks a tangent if no chat question is queued.
- OBS browser-source widget at `/stage-overlay` that shows TITAN's avatar + lower-third "TITAN is thinking…" + speech bubbles. Drop it into OBS as a transparent browser source.
- Twitch chat ingest: existing IRC channel handler points at `irc.chat.twitch.tv`, `chime_in` calls TTS with the chat author's name pronounced.
- Hard switch: `kill_stage()` immediately mutes the audio bus and stops all autonomous actions.

**The viral artifact:** A clip of Tony coding at 2am with TITAN periodically interrupting to point out a typo or read a chat question in a deadpan-Tony voice. Cross-posts perfectly: r/Twitch, r/programming, r/OBS, r/selfhosted. The clip goes viral when TITAN says something genuinely funny — which it will, because it's running on Tony's persona prompt.

---

### 8. Dad Mode — A Family-Safe Layer Tony Actually Wants

**The pitch:** A separate persona profile + content filter + voice clone consent layer + scheduled "wind-down" mode that turns TITAN into something Tony's kids can talk to, that posts homework reminders, reads bedtime stories in dad's cloned voice, and *physically refuses* to do work tasks between 6pm and 9pm.

**The hook:** "my AI clocks out at dinner. it reads my kid bedtime stories in my voice when I'm working late. it's the only LLM product designed by a dad."

**Why TITAN can ship this and competitors can't:** TITAN has F5-TTS voice cloning, 16 channels (kids can talk to it via the family iPad's Telegram), Soma's Safety drive (which already has logic for "should I be doing this right now"), and the Approval Gates safety layer. Most importantly: Tony is a dad. Anthropic, OpenAI, Cursor, Mastra, Vercel — none of them ship a feature explicitly for the parent-of-young-kids segment. *That's a 200M-person market with zero AI products targeting them.* This is the feature that makes non-coder parents buy a $40 Amazon tablet to mount on the fridge.

**MVP scope:**
- New `src/agent/personaProfiles.ts` — multiple personas keyed by channel + time-of-day + caller identity. Schema: `{ name, voiceId, allowedTools[], bannedPhrases[], schedule: cron, persona prompt }`.
- Ships with three: *Worker* (default, all tools), *Dad* (family-safe, 6-9pm only, no shell/code/posting tools), *Storyteller* (reads from a `~/.titan/stories/` folder in cloned voice, never does anything else).
- Channel-level pinning: messages from the iPad's Telegram bot → forced *Dad* persona with `bedtime_story`, `homework_reminder`, `weather_kid`, `silly_fact` tools only.
- "Wind-down" mode: `safety.windDown: { from: '18:00', to: '21:00' }` — gates *all* autopilot, *all* Facebook posting, *all* shell tools. Soma's Social drive instead emits proposals like "tell Tony to put the phone down."
- `bedtime_story.ts` skill: picks a 500-1000 word story, narrates with F5-TTS in the configured voice, optional ambient music bed.

**The viral artifact:** Tony's wife films Tony's daughter asking the iPad on the fridge for a bedtime story. TITAN reads one in Tony's voice. Tony is at the kitchen table working. The kid doesn't notice. *"tony's at his desk. titan's at bedtime. both versions of dad showed up tonight."* The post that turns TITAN from "another agent framework" into a *cultural object*. Mom Twitter discovers it. Dad Twitter cries about it. The repo gets 5,000 stars in a week.

---

## Top 2 picks (per the agent that drafted this)

**#1 Dream Mode** is the strongest install-driver per line of code. It uses *only* parts TITAN already has (trajectory log, drive ring buffer, F5-TTS, daemon scheduler), the demo is impossible to ignore on Twitter, and the "AI wrote about its day in your own voice" hook is unique to TITAN's stack — nobody else can clone it without rebuilding three subsystems. Two weeks of focused work, 5,000+ stars upside.

**#8 Dad Mode** is the strategic moat. Every other agent framework targets developers; targeting *parents* with a feature only a dad-developer would think to build creates a category nobody else can credibly compete in. It also serves as a Trojan horse: install Dad Mode for the bedtime story, end up running TITAN's full agent stack on your homelab. The viral artifact (kid talking to dad's voice on the fridge) is the kind of thing that turns a framework into a brand.

Honorable mention: **#3 Voice Twin** is the highest-ceiling viral feature but carries real abuse-vector risk and needs the consent/allowlist plumbing right before it can ship publicly. Worth building, ship after #1 and #8.
