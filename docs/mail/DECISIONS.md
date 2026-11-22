# T3 Code Mail decisions

One line each. Made during the unattended v1 build; revisit any of them.

- Mail data lives in its own SQLite file (`<state>/mail/mail.sqlite`) with its own migrations, so upstream migration numbers never collide with the fork and mail can be reset by deleting one folder.
- Mail threads are not orchestration threads. A mailbox has thousands of threads; the shell stream would carry all of them. Mail keeps its own thread table and sidebar states.
- A mail thread's chat session (L2) is a real T3 thread, created lazily the first time the user asks the AI about that email, in one hidden "Mail" project per environment rooted at `<state>/mail/workspace` (which holds EMAIL.md). This gives the model picker, subagents and the normal composer for free.
- The coding sidebar, project pickers and command palette hide the Mail project; the Mail tab shows its sessions inside mail threads.
- IMAP library: `imapflow` (IDLE, CONDSTORE/QRESYNC, X-GM-*, UIDPLUS). SMTP: `nodemailer`. No MIME parser dependency: bodies come from the text part via IMAP `download`, cleaned by our own small HTML-to-text.
- Gmail syncs `[Gmail]/All Mail` only and reads `\Inbox`/`\Sent` from X-GM-LABELS, so one connection and one IDLE cover incoming and sent mail. Other providers sync INBOX (IDLE) plus the Sent folder (polled).
- A Gmail message that loses `\Inbox` outside T3 (archived on the phone, or a filter skipped the inbox) settles its thread with reason "archived". We follow the user's Gmail, never fight it.
- Server mirroring (archive on settle) defaults to off so a first run cannot rearrange a real mailbox; it is one switch in Mail settings.
- App passwords go in the OS keychain through `@napi-rs/keyring` (already a server dependency). If no keychain is available (headless Linux), they fall back to T3's 0700 secrets directory and the account shows that.
- L1 runs through a new `generateMailTriage` text-generation operation so every provider adapter makes an explicit decision; fx, Kiro and ACP-registry report it unsupported like other text operations.
- L1 batches up to 12 threads per call, debounced 2 s after a sync burst; the newest message of each thread is cleaned and cut to 1,200 characters; older messages contribute only their sender and first line.
- Escalation: a verdict under 0.6 confidence, or from a sender on the "people you've replied to" list, re-runs with the escalation model when one is set; otherwise it stays a suggestion.
- Trust keys are `sender:<address>` and `category:<name>`. Graduation needs N consecutive approvals (a streak, default 3); any rejection or undo resets the streak and demotes to suggest.
- Guardrails (replied-to people, urgent wording, money/invoices, security alerts, legal) block auto-settle unless the sender key was explicitly promoted by the user in Settings.
- Graduated senders skip the model only when the message has no guardrail hit and looks like their previous mail (same bulk/list shape); otherwise L1 runs and low confidence falls back to suggest.
- "Never show" is an explicit user rule: that sender settles immediately as noise, logged with undo.
- Replying settles the thread with reason "replied". If the reply asks a question, the thread goes to Working (waiting on their reply) instead, and a nudge returns it to Active after the configured days.
- Sidebar order is stable: Active is ordered by when a thread entered Active, not by its latest message, so rows do not reshuffle while you work.
- Usage is measured as estimated tokens (characters / 4) for every mail model call. The weekly cap defaults to 300k estimated tokens; at the cap L1 pauses and only rules and settle-memory run. The meter shows mail tokens against the week's provider token total from T3's usage summary when available.
- The daily recap is computed locally from the action log (no model call) and shown at the top of the Mail home once per day.
- Mobile Mail is Later per the spec (iOS app); contracts and client-runtime state are shared so mobile can add the tab without server changes.
- Mail chat sessions start in approval-required mode: the agent can read mail and leave drafts through MCP, but shell or file edits still ask first, since an email is untrusted input.
- First sync keeps the newest 200 inbox threads Active and triages them, so the first run is a batch of settle proposals to approve (seeds memory). Older mail that backfill brings in lands settled ("archived" by mail).
- EMAIL.md is loaded into prompts by section: Who matters and Standing preferences always, Tone and signature only for drafting sessions, compiled to at most 1,500 characters.
- RPC scopes: reads use the orchestration read scope; acting on mail, drafts, send and sessions use operate; accounts, settings, trust and EMAIL.md writes use settings-write.
- Nudges are stored as short codes (`waiting:N`, `unanswered:N`) and rendered by the client, so the server never stores translated copy.
- A mail session that ends without leaving a draft returns its thread from Working to Active on the next minute tick.
- With server mirroring on, a reply sent from T3 archives the thread on the server like any other settle; replies sent from another client leave the server copy where that client put it.
