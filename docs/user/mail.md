# Mail

Open **Mail** in the web or desktop app to review email and send replies. Your T3 Code environment stores synced mail on its host computer. Model-assisted triage and mail chats share message content with your chosen model provider.

## Connect an account

Open **Settings → Mail → Accounts → Add account** and enter your email address.

- **Gmail.** Enable 2-Step Verification in your Google Account. Choose **Create a Gmail app password**, name it `T3 Mail`, and paste the generated password into **App password**. If you change your Google password, create a replacement and choose **Re-enter app password** in Mail settings. [Google’s app password help](https://support.google.com/accounts/answer/185833)
- **Other accounts.** Enter your provider’s app password. Mail recognizes common iCloud, Yahoo, and Fastmail addresses. For a custom domain, expand **Other provider** and enter the IMAP and SMTP hosts, ports, and TLS settings from your provider.

Choose **Add account** to start syncing. Select a **Default mail model** to get triage suggestions.

## Review mail and reply

**Active** holds threads that need you. In **Mail home**, choose **Settle these** to accept the displayed suggestions or **Keep in Active** on a thread you still need. Open **Settled by AI** to review or undo an automatic decision. **Move back to Active** reopens a settled thread. To also archive settled mail in your provider’s inbox, enable **Archive on the mail server when settled**.

Mail learns from consecutive approvals for a sender or category. Adjust the approval threshold or switch a sender back to **Suggest** under **Settings → Mail → Trust**. For an explicit rule, use **Rules → Add rule → Dry run** to preview matches before saving.

Formatted messages preserve the sender’s layout. Choose **Load remote images** to display pictures hosted by the sender for that message.

Choose **Chat** on an email to open its chat beside the email, with the saved triage history. Each entry shows what Mail decided and whether a model, rule or learned preference made the decision. Opening the chat uses no model tokens. Ask a follow-up there to work with the email.

A thread reads oldest first. The newest and unread messages are open; select a collapsed message to read it, and **•••** shows the earlier conversation quoted inside a message. Each open message has **Reply**, **Reply all** (when others were on it) and **Forward**; the toolbar buttons answer the newest message someone else sent. The editor opens under the message it answers and names it. A reply quotes that message below your text, as other mail apps do, and a forward includes its attachments. **Send** sends it; **Save draft** or closing the editor keeps it under that message, including drafts an agent left. If the mail server accepts only some recipients, the draft lists who received it and keeps only the rejected recipients for your next send.

Right-click an email in the sidebar, or open the **…** menu on an open email, for **Mark as unread**, **Pin**, **Snooze**, **Never show this sender** and **Delete**. **Delete** moves the whole thread to your provider's Trash, even when server archiving is off. Choose **Undo** in the confirmation to restore it to your inbox.

## Use the CLI or an MCP agent

With T3 Code running, search from a terminal. Use a thread ID from the results for the subsequent commands.

```sh
t3 mail list --search "invoice"
t3 mail show THREAD_ID
t3 mail draft THREAD_ID "Thanks, I received the invoice."
t3 mail propose THREAD_ID --reason receipt
```

An MCP agent can search with `t3_mail_list` and `{"query":"invoice"}`, then call `t3_mail_read` with `{"threadId":"THREAD_ID"}`. To leave a draft for your review, call `t3_mail_draft` with `{"threadId":"THREAD_ID","body":"Thanks, I received the invoice."}`. It answers the newest message someone else sent; to answer or forward a particular one, add its `messageId` from `t3_mail_read` as `targetMessageId`, and `"mode":"forward"` with `to` for a forward. Drafts and settle proposals from either interface appear in Mail for approval. [Connect an outside agent](./outside-agents.md)
