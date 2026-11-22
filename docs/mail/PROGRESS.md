# T3 Code Mail progress

Build log for the v1 described in [SPEC.md](SPEC.md). Choices made without a human are in [DECISIONS.md](DECISIONS.md).

## Done

- Contracts: `packages/contracts/src/mail.ts` (wire types) and `mailRpc.ts` (`mail.*` RPCs and scopes).
- Text generation: `generateMailTriage` and `generateMailNotes` operations, with a decision in every provider adapter.
- Server (`apps/server/src/mail`):
  - `MailStore`: `<state>/mail/mail.sqlite`, own migrations, FTS5 trigram search.
  - `imapSession` / `MailSync`: imapflow, Gmail All Mail with X-GM-LABELS/THRID/RAW, IDLE, QRESYNC or UID-window tracking, recent-first sync then backfill, Gmail quota pause, sleep detection, server ops queue (archive mirror, seen, append to Sent).
  - `MailEngine`: ingest and threading, state changes from mail (replies return threads, Gmail archive elsewhere settles), stream events, usage and recap.
  - `mailPrefilter` (no-AI pass), `mailTrust` (trust ramp), `mailText` (cleaning for the model), `mailPrompts`.
  - `MailService`: L1 triage worker, act/undo with trust updates, drafts and approve-to-send over SMTP, chat sessions in the hidden Mail project, accounts, settings, rules dry run, EMAIL.md, voice seeding, nudges, snoozes.
  - Wired into `ws.ts` and `server.ts`.
- Tests: trust ramp, prefilter, text cleaning, and an end-to-end ramp through `MailService` (`vp test run src/mail` in `apps/server`).

- Outside agents can list, search, read, draft, propose settles and reopen mail over MCP and the CLI. Neither interface sends mail.
- Web settings, shared client state, permission-aware RPC commands and Mail capability discovery are implemented.
- Verified 32 server Mail tests, two settings logic tests and the client-runtime typecheck at takeover.

- Mail and Code tabs, inbox, search, settled filters, batch approvals, recap and action log are wired into web and desktop. A mail thread opens full messages, related conversations, editable drafts and its T3 chat.
- Draft saves, discards and explicit sends check the reviewed revision. A server regression test reproduced and now rejects stale edits.
- The user guide and initial set of 234 Mail catalog keys cover all nine web translations.

## In progress

- Verify isolated GreenMail sync and SMTP, desktop background behavior and the integrated web client.
- Address milestone review findings on provider selection, usage accounting, resync, queued mailbox operations, account cleanup, guardrails, undo and concurrent session creation. Run focused checks and a final review.

## How to try it

1. In this checkout run `T3CODE_DEV_INSTANCE=mail-v1 vp run dev --home-dir "$HOME/.t3-mail-v1" --no-seed`. Open the local web address and use the pairing URL printed by this server. This keeps the fork’s accounts, mail and chats separate from your installed T3 Code.
2. Open **Mail → Mail settings → Add account**. For Gmail, enable 2-Step Verification, create a Google app password using the link in the dialog, then enter your Gmail address and the generated password. Gmail accounts whose administrator disables app passwords need OAuth, which is outside v1.
3. Pick a **Default mail model** from your configured T3 providers. Review the initial suggestions in **Mail home**. The default trust threshold is three consecutive approvals.
4. Use **Settled by AI** to inspect or undo automatic settles. Open a thread to draft, review and explicitly approve a reply. Server archiving is opt-in.

See [the Mail guide](../user/mail.md) for other providers, rules, MCP tools and CLI examples.
