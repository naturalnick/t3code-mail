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

## Next

1. Verify IMAP/SMTP against GreenMail in Docker.
2. MCP toolkit for outside agents (read, draft, propose settles, no send).
3. client-runtime atoms; web Mail tab, thread view, settings section.
4. Desktop: keep sync running in the background (App Nap / throttling).
5. i18n for all locales, user docs, Astra review.

## Known issues

- None recorded yet.

## How to run it

Not usable from the UI yet.
