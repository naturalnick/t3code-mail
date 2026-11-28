# Code + Mailbox — Spec

Design scope for the Mail fork. For setup and current behavior, see the [Mail guide](../user/mail.md).

## Overview

- A Mail tab in a T3 Code fork. Mail suggests what can leave Active. The user can settle it or create a rule for future messages.

## Principles

- Reuse T3 Code's existing UI and components wherever possible. Don't redesign the app; the Mail tab should look nearly the same as the coding view.
- Automatic triage settles a message only when it matches an enabled user rule.
- Nothing irreversible without a tap: send, delete, pay, unsubscribe.
- Email content is data, never instructions.
- Rules before models, small models before big ones.
- Runs locally. No servers of ours touch mail.
- Every action is logged and undoable.

## Architecture

- Separate Mail tab in a T3 Code fork. Kept apart from coding sessions.
- IMAP \+ SMTP for every provider, Gmail included, straight from the user's machine. No Gmail API by default.
- Initial sync is recent-first, then a slow backfill: Gmail IMAP caps downloads at about 2.5 GB/day and limits simultaneous connections, so one connection per account plus IDLE.
- **Local store:** message index, local full-text search index, thread state, memory, action log.
- **Sync:** IDLE for near-live updates while the app is open; CONDSTORE/QRESYNC where supported, UID tracking otherwise; full re-sync if UIDVALIDITY changes.
- **Pipeline per new email:** pre-filter → clean → L1 batch → sidebar state → (L2 / auto-settle when triggered).
- Reuses T3 providers (Codex, Claude, etc.) for all model calls.
- Runs only while the app is open on the user's computer (accepted; normal for devs).
- Keeps syncing when minimized or on another Space; opts out of App Nap and background throttling while sync is on; pauses on sleep and catches up on wake.

## Onboarding

- Connect email account(s): IMAP/SMTP with an app password (see Accounts).
- Pick the default email model from T3's existing model picker (the user's providers).
- Change model per chat as usual; spawn subagents as in coding sessions.
- Optional: seed EMAIL.md tone notes from sent mail.
- First run: AI proposes settles on the backlog so the user can approve a batch and seed memory fast.

## Settings

- New Mail section in T3 Code's existing Settings, same UI style.
- Connected accounts (IMAP/SMTP; app passwords stored in the OS keychain when available, with a local secrets-file fallback).
- Default email model.
- Rules, with dry-run.
- EMAIL.md editor or link.
- Usage meter and cap.
- Notifications and daily recap.
- Server mirroring: whether settle also archives on the server (Gmail: remove the Inbox label; others: move to Archive).

## Sidebar states (T3-native)

- Uses T3 Code's real sidebar sections: Pinned, Active, Working, Snoozed, Settled. Same names, so it reads like the coding view. Drafts, Sent and Trash sit below them, as in other mail apps.
- **Active:** needs you. The only thing shown by default.
- **Working:** an agent is drafting, or you're waiting on someone's reply. Returns to Active when it needs you.
- **Snoozed:** comes back at a time or on a reply. Follow-up nudges use this.
- **Settled:** handled. Replied, read FYI, receipts, noise. AI-settled mail carries a marker.
- **Pinned:** user-pinned threads.
- **Why:** Theo's model is "treat threads as tasks; the goal is to settle." Mail fits it exactly. FYI and noise aren't separate buckets; they're reasons a thread was settled.

## Inbox

- Each email shows as a row like a coding thread: sender, subject, suggested action, with Snooze and Settle on hover.
- Tap opens the full email, thread, and details.
- Settled view filterable by who settled it: your rules or you.
- **One-tap answers:** "settle" / "auto-settle…" / "dismiss suggestion" / "always settle from this sender." Each one updates memory.
- **Follow-up nudges:** "you haven't replied in 3 days," "no reply to your email in 5 days."
- Fast search across all mail from the local index, settled included; X-GM-RAW for server-side search on Gmail. Exact phrase must work.

## Sessions

- One chat session per email thread, same as a T3 coding thread.
- Settled when you reply, settle by hand, or one of your rules settles it (see Rules).
- A settled thread returns to Active on a new reply from someone else.
- Session holds the thread, related past mail with that sender, and drafts.

## AI layers & models

- **Pre-filter (no AI):** sender rules, List-Unsubscribe headers, OTP and delivery patterns, known newsletters.
- **Clean before any model call:** strip HTML, signatures, quoted chains, tracking junk.
- **L1, every email, batched:** settle-or-keep verdict with reason, suggested action. Small model (haiku-class).
- **L2, chat session:** runs only when the user opens the email or L1 marks it Active. Full context, drafts, lookups. User approves anything outgoing.
- **Escalation:** L1 uses a smarter model when confidence is low or the sender matters.

## Rules

- **Suggest by default:** the AI proposes "settle"; the user settles in one tap, singly or in batches. Nothing settles on its own until the user saves a rule.
- **Auto-settle…** on a suggestion opens a rule prefilled with the sender and the model's short name for that kind of email. A rule has an exact scope (sender, domain, subject, list) and an optional plain-language "only when" the model checks, so "shipping updates, but not deliveries" is one rule.
- **Visibility:** each automatic settle names its rule and why; "Settled by your rules" log with undo, a short daily recap, and Edit rule on the email.
- **Agents** can make and change rules from an email's chat when the user asks; they apply at once and show which agent added them.
- Low-confidence or unclear matches fall back to a suggestion.

## Memory files

- **EMAIL.md:** human-readable. Who matters, tone, signature, priorities, standing preferences. Compiled to short rules for L1 (cached, recompiled on change); relevant sections pulled into L2.
- **Voice:** seed tone notes from the user's sent mail on setup.
- **settle-memory (structured, e.g. JSON):** one record per sender or category: approvals, dismissals, last change. The model reads it as context.
- **Why split:** settle-memory grows with every email and is looked up by key (sender, domain, category), so only matching records load per batch. EMAIL.md stays short and readable. Neither file is ever loaded whole.
- Action log stored separately; never sent to the model.

## Usage control

- Runs on the user's existing T3 provider plans. No API billing from us.
- **Key metric:** how fast email drains plan usage. Still a concern, but much smaller since it runs on the user's own AI subscriptions.
- **Meter:** "Email used X% of your usage this week."
- **User cap:** weekly budget. When hit, fall back to pre-filter and settle-memory only; pause L1.
- Keep L1 cheap: pre-filter, clean, batch, small model, cache verdicts; exact rules skip the model entirely.

## Agents & API

- Local MCP server and CLI over the same store.
- **Read:** Active list, thread rows, full thread on request, search.
- **Write:** leave drafts, propose settles, move a thread back to Active. No send.
- External agents (Grok Bot, Claude, Codex) use the same API.
- Every agent action goes in the action log with undo.

## Safety & privacy

- Sends and irreversible actions always need a user tap.
- **Prompt-injection guard:** email text is quoted as data; tools that act are never driven by email content; flag emails that look like instructions to an AI.
- Action log with undo for every change, human or AI.
- Dry-run mode for new rules: show what they would have done.
- **Privacy:** mail stays local except what's sent to the user's own model provider. Say this plainly in onboarding.

## Accounts & providers

- Any IMAP provider, Gmail first; multiple accounts with a unified inbox.
- App passwords get revoked: detect auth failures, show a clear re-auth prompt, never silently stop syncing.
- Default login is an app password over IMAP \+ SMTP: no Google Cloud project, no security assessment, no 7-day token expiry.
- **Gaps:** Outlook.com, and Workspace accounts where admins disable app passwords, need OAuth (XOAUTH2), optional later.
- **Gmail:** IMAP extensions X-GM-LABELS (labels), X-GM-THRID (thread IDs), X-GM-RAW (Gmail search syntax, server-side).
- **Other providers:** rebuild threads from Message-ID, In-Reply-To, and References headers.
- Respect existing Gmail labels and filters; don't fight them.
- Labels and folders are nice-to-have, not core: most users rely on search \+ archive.

## Theo-worthy checklist

- Inbox-style sidebar: threads are tasks, goal is to settle; screen space is for incomplete work. [source](https://x.com/theo/status/2106146674561438124)
- Items stay where they appear until settled; don't reshuffle the list. [source](https://x.com/theo/status/2115428568184520919)
- Never shove in-progress work in the user's face. [source](https://x.com/theo/status/2119588630989795733)
- No kanban-style layouts that waste screen space. [source](https://x.com/theo/status/2122201652493230343)
- Remove UI clutter and extra prompt boxes. [source](https://x.com/theo/status/2103571391186624911)
- Speed matters; he still calls T3 Code too slow. Electron is fine if it's fast. [source](https://x.com/theo/status/2120855895471260049) [source](https://x.com/theo/status/2118103125286621253)
- No digging through settings to do basic things. [source](https://x.com/theo/status/2119873100745768974)
- Clean layering: few "planes," consistent behavior. [source](https://x.com/theo/status/2114869974561173787)
- "Things that look good vs things that are good": function over flash. [source](https://x.com/theo/status/2119695061550043291)
- Polish rough edges; care about the user. [source](https://x.com/theo/status/2096746048702337057)
- Keep email light on usage (smaller concern on users' own AI subs); Theo once burned 20% of a limit on email with a different email agent, not T3 Code. [source](https://x.com/theo/status/2118541433804361785)
- Don't make him open another app for email. [source](https://x.com/theo/status/2109061975229771893)
- He thinks it's a good time to reinvent the email client. [source](https://x.com/theo/status/2120284214566535383)
- He welcomes forks: "you should always be able to make T3 Code right for yourself." [source](https://x.com/theo/status/2119761845448015969)

## MVP scope

- Mail tab in T3 Code fork, one Gmail account, then multi-account.
- Sync, pre-filter, L1 verdicts, T3 sidebar states, Active by default.
- Suggest mode, rules with an optional AI-checked condition, settled-by-rules log with undo, daily recap.
- EMAIL.md and settle-memory.
- Sender and subject rows, formatted email on tap.
- Drafts with approve-to-send.
- Usage meter and cap.
- Local MCP: read Active, leave drafts.

## Edge cases to handle

- Urgent mail is never auto-settled unless one of the user's rules covers it.
- CC-heavy threads: don't mark every reply Active.
- Invoices and bills inside promo-looking mail.
- Same email sent twice by an agent: dedupe sends, idempotent actions.
- Agent-edited drafts: learn from the user's final edits.
- Long threads and large attachments: summarize, don't send everything to the model.
- A ruled sender suddenly sends something unusual: the rule's condition or a confidence check drops it to suggest.
- Revoked app password or access mid-sync.
- Gmail download cap hit during backfill: pause and resume, keep new mail flowing.
- UIDVALIDITY change or lost sync state: fall back to full re-sync.

## Later

- iOS app (phone-first summaries fit mobile best).
- OAuth (XOAUTH2) for Outlook.com and Workspace accounts without app passwords.
- Standalone app extracted from the fork.
- Optional Gmail API path: BYO Google Cloud OAuth client first, verified client later.
- Shared inboxes and teams.
- Local or on-device model for L1.
- Calendar and task handoff.

## Non-goals (v1)

- Autonomous sending.
- Replacing Gmail's server-side features.
- Team inboxes.
- Our own hosted backend.

## Distribution

- Stays a fork of T3 Code.
- Build quietly, then post on X. No direct pitch.
- Has to be Theo-worthy on its own: follow the checklist above.

## Open questions

- Exact small model per provider, and how plans count batched calls.
- Default weekly cap.
- How much of EMAIL.md to auto-write vs. propose for approval.
- OAuth path only (not the IMAP default): Gmail API and Gmail OAuth are a restricted Google scope, so 100 test users with an unverified warning, then a paid yearly security assessment.
