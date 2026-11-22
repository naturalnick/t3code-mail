# T3 Code Mail progress

Mail v1 is implemented on the fork’s `mail` branch. [SPEC.md](SPEC.md) defines the release scope. [DECISIONS.md](DECISIONS.md) records implementation choices.

## Implemented

- Web and desktop share the Mail tab, five sidebar sections, local search, Gmail server search, daily recap and action history. A mail thread opens one ordinary T3 chat with the existing model picker and subagent controls.
- IMAP sync prioritizes recent mail and backfills older messages. Mailbox rebuilds preserve pins, snoozes and chat associations. Queued archive and read operations target the messages present when the user acted.
- Triage checks rules before calling the selected provider, batches short summaries and checks the weekly budget before each automatic triage call. Users can adjust the default three-approval threshold, review automatic settles and undo them. Protected categories require explicit trust.
- Draft editing and send approval check the revision the user reviewed. Outside agents can read, search, leave drafts and propose settles through the CLI or MCP. Sending requires approval in the app.
- Settings cover accounts, provider models, trust, rules, EMAIL.md, notifications, server mirroring and usage. The web catalogs include all nine translated locales.

## Verification and remaining coverage

- A local GreenMail server delivered an explicitly approved synthetic reply to INBOX and Sent. A minimized Electron window received new mail and recovered from a simulated suspend and wake. The temporary Docker VM, containers and desktop profiles were removed.
- An isolated web client showed batch approval moving a suggestion from Active to Settled with an undo action. Browser fixtures covered draft conflicts, explicit approval, action undo and chat navigation.
- Focused server, settings, client type and translation checks passed. The final single-worker run passed 171 tests across Mail, chat launch, provider text generation and migration reconciliation. The server regression suite covers trust graduation and demotion, weekly caps, account isolation, UIDVALIDITY changes, undo after later edits and concurrent send and chat operations.
- The final Astra review identified four additional issues. Regression cases reproduced all four before the fixes and passed afterward: explicit trust provenance, stale batch approval, partial SMTP delivery and quota-limited body downloads.
- Gmail extensions have no live Gmail verification. Physical sleep and switching macOS Spaces were not exercised. Model evals used synthetic dry runs because the eval runner lacked a configured live provider. The broad changed-package check was interrupted to relieve host memory pressure.

## How to try it

1. In this checkout run `T3CODE_DEV_INSTANCE=mail-v1 vp run dev --home-dir "$HOME/.t3-mail-v1" --no-seed`. Open the local web address and use the pairing URL printed by this server. This keeps the fork’s accounts, mail and chats separate from your installed T3 Code.
2. Open **Mail → Mail settings → Add account**. For Gmail, enable 2-Step Verification, create a Google app password using the link in the dialog, then enter your Gmail address and the generated password. Gmail accounts whose administrator disables app passwords need OAuth, which is outside v1.
3. Pick a **Default mail model** from your configured T3 providers. Review the initial suggestions in **Mail home**. The default trust threshold is three consecutive approvals.
4. Use **Settled by AI** to inspect or undo automatic settles. Open a thread to draft, review and explicitly approve a reply. Server archiving is opt-in.

See [the Mail guide](../user/mail.md) for other providers, rules, MCP tools and CLI examples.

## Verify with fake mail

With Docker running, use `(cd apps/server && node scripts/mail-test-server.ts verify)` for an isolated loopback IMAP and SMTP round trip. On macOS, `(cd apps/desktop && node scripts/verify-mail-background.cjs)` exercises the minimized desktop path. Run these separately.
