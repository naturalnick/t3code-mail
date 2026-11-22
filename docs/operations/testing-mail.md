# Test Mail with a local inbox

With dependencies installed and Docker running, run the following from the repository root:

```sh
(cd apps/server && node scripts/mail-test-server.ts verify)
```

The verifier starts a temporary GreenMail container on loopback ports and uses isolated app data. It syncs synthetic mail over IMAP, searches message bodies, sends an approved draft over SMTP, and checks delivery in Inbox and Sent. It also exercises reconnection after a changed mailbox cursor and simulated suspend/resume.

On macOS, run the desktop check separately to exercise the same path with a minimized Electron window:

```sh
(cd apps/desktop && node scripts/verify-mail-background.cjs)
```

To explore the inbox manually, run `node scripts/mail-test-server.ts start` from `apps/server`. Enter the account details it prints in **Settings → Mail → Accounts**. Run `node scripts/mail-test-server.ts seed` to deliver more mail and `node scripts/mail-test-server.ts stop` to remove the test container.

For Gmail-specific labels, quotas, authentication policies, or physical sleep behavior, verify on the target account or device. The local fixture exercises standard IMAP and SMTP.
