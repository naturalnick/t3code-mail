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

Open a thread and choose **Draft reply**, or ask an agent for a draft with **Start mail chat**. Select **Review and send** to check the recipients and text, then **Approve and send**.

## Use the CLI or an MCP agent

With T3 Code running, search from a terminal. Use a thread ID from the results for the subsequent commands.

```sh
t3 mail list --search "invoice"
t3 mail show THREAD_ID
t3 mail draft THREAD_ID "Thanks, I received the invoice."
t3 mail propose THREAD_ID --reason receipt
```

An MCP agent can search with `t3_mail_list` and `{"query":"invoice"}`, then call `t3_mail_read` with `{"threadId":"THREAD_ID"}`. To leave a draft for your review, call `t3_mail_draft` with `{"threadId":"THREAD_ID","body":"Thanks, I received the invoice."}`. Drafts and settle proposals from either interface appear in Mail for approval. [Connect an outside agent](./outside-agents.md)
