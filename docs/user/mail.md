# Mail

Open **Mail** in the web or desktop app to review email and send replies. Your T3 Code environment stores synced mail on its host computer. Model-assisted triage and mail chats share message content with your chosen model provider.

## Connect an account

Open **Settings → Mail → Accounts → Add account** and enter your email address.

- **Gmail.** Enable 2-Step Verification in your Google Account. Choose **Create a Gmail app password**, name it `T3 Mail`, and paste the generated password into **App password**. If you change your Google password, create a replacement and choose **Re-enter app password** in Mail settings. [Google’s app password help](https://support.google.com/accounts/answer/185833)
- **Other accounts.** Enter your provider’s app password. Mail recognizes common iCloud, Yahoo, and Fastmail addresses. For a custom domain, expand **Other provider** and enter the IMAP and SMTP hosts, ports, and TLS settings from your provider.

Choose **Add account** to start syncing. Select a **Default mail model** to get triage suggestions. AI sorts mail that arrives after you connect; recent mail that was already in your inbox stays in your inbox untouched. To have AI sort that too, choose **Review emails with AI** on **Mail home**, which shows how many it will read. **Stop** halts it, and anything the weekly token cap interrupts waits for you to ask again.

## Review mail and reply

**Inbox** holds pinned threads and mail that needs you. Use the mailbox menu below Search to switch to Sent, Drafts, Settled, or another mailbox while keeping the current email open. Your mail model reads each new email and suggests settling the ones that don't, with a one-line reason: hover the model's icon on a sidebar row, or see it in the email's details. Settle one, or tick the ones you want under **Suggested settles** in **Mail review** and choose **Settle**. Ignore a suggestion and the email stays in your inbox. **Move to inbox** reopens a settled thread. To also archive settled mail in your provider’s inbox, enable **Archive on the mail server when settled**.

Use the filter icon beside **Search mail** to find a label or custom IMAP folder. A label narrows the current mailbox. Choose **All mail** in the mailbox menu to include settled conversations. Selecting a folder shows all its filed mail. Open the filter again to clear it. Opening an IMAP folder starts syncing its messages, newest first.

An email’s details show its labels. Choose **Labels** there to apply or remove an existing Gmail label or IMAP tag on the synced messages in the conversation. These changes go directly to the connected account. Custom IMAP folders are available for browsing.

Mail only suggests until you make a rule. Open an email’s details and choose **Auto-settle** to create a rule. The section shows the sender, domain, subject or mailing list each rule covers. **Conditional** means a rule is in scope and its **Only when** condition determines which messages settle. Choose **Edit rule** or **Remove** there to change what happens to future mail. You can also open the rule editor from the email’s **…** menu. Mail fills in the sender and, when available, a short description, such as "Amazon shipping updates", which you can narrow, for example "Shipping updates. Keep delivery confirmations." The AI checks each email from that sender against the description; leave the description empty to settle everything that matches. In **From**, use `<updates@example.com>` for one exact address or plain text to match part of an address. A rule applies to everything it covers, bills and security mail included. You can also ask an email's chat to make or change a rule, such as "stop showing me Amazon shipping updates but keep deliveries"; it takes effect right away. Manage rules under **Settings → Mail → Rules**, which notes the ones an agent added, and where **Dry run** previews what a rule covers among your existing mail.

Under **Settings → Mail → Rules**, turn on **Automatically trash sign-in codes** to clean up new code emails without AI. The defaults are five minutes after delivery or one minute after Mail first sees the message marked read, whichever comes first. A shorter stated expiry also applies. You can adjust both timers. Cleanup catches up when the server resumes syncing. Pinned conversations and conversations with open drafts are spared. **Mail review → Automatic actions** shows the sender and lets you restore an individual message.

The **Daily recap** at the top of **Mail review** lists what your rules settled since yesterday and why; choose **Bring back** to return an email to your inbox.

To keep a sender's mail away from AI entirely, right-click it and choose **Turn off AI for this sender**, or add addresses and domains under **Settings → Mail → AI off**. Mail skips model review for those senders. An unconditional rule can still settle their mail. When a domain covers the sender, **Turn on AI** names that domain and turns it back on for the whole domain.

Formatted messages open in a simplified view that keeps the sender’s words, links and tables in your theme, without their layout or images. Choose **Show original** for the sender’s layout, such as a boarding pass or a coupon; emails that are mostly pictures open that way. In the original, **Load images** displays pictures hosted by the sender for that message.

Choose **Chat** on an email to open its chat beside the email, with the saved triage history. Each entry shows what Mail decided, why, and whether the model or one of your rules made the decision. Opening the chat uses no model tokens. Ask a follow-up there to work with the email.

A thread reads oldest first. The newest and unread messages are open; select a collapsed message to read it, and **•••** shows the earlier conversation quoted inside a message. Each open message has **Reply**, **Reply all** (when others were on it) and **Forward**; the toolbar buttons answer the newest message someone else sent. The editor opens under the message it answers and names it. A reply quotes that message below your text, as other mail apps do, and a forward includes its attachments. **Send** sends it; **Save draft** or closing the editor keeps it under that message, including drafts an agent left. If the mail server accepts only some recipients, the draft lists who received it and keeps only the rejected recipients for your next send.

Select an attachment beneath an open message to preview a PDF, Office document (.docx, .xlsx, .pptx), image, text, audio, or video file. Use the download button to save a copy. Other file types download when selected. Mail retrieves the file from your connected mailbox when you open or save it, with a limit of 50 MiB per file.

Right-click an email in the sidebar, or open the **…** menu on an open email, for **Mark as unread**, **Pin**, **Snooze**, **Turn off AI for this sender**, mail rules and **Delete**. **Delete** moves the whole thread to your provider's Trash, even when server archiving is off. Choose **Undo** in the confirmation, or **Restore** under **Trash** in the sidebar, to bring it back to your inbox. Trash lists what you deleted in Mail during the last 30 days.

## Write a new email

Choose **New email** at the top of the Mail sidebar, or use the **New thread** shortcut while in Mail. Mail saves it to **Drafts** as you type, so you can leave and come back to it. Choose **Chat** to have your mail model help write it; edits the chat makes appear in the email, and only you can send it. With more than one account, choose the sending address under **From**.

**Sent** in the sidebar lists conversations you've written in, newest first. A sent email that asks a question waits in **Working** for the answer, and the reply brings it back to your inbox.

## Use the CLI or an MCP agent

With T3 Code running, search from a terminal. Use a thread ID from the results for the subsequent commands.

```sh
t3 mail list --search "invoice"
t3 mail show THREAD_ID
t3 mail draft THREAD_ID "Thanks, I received the invoice."
t3 mail propose THREAD_ID --reason receipt
```

An MCP agent can search with `t3_mail_list` and `{"query":"invoice"}`, then call `t3_mail_read` with `{"threadId":"THREAD_ID"}`. To leave a draft for your review, call `t3_mail_draft` with `{"threadId":"THREAD_ID","body":"Thanks, I received the invoice."}`. It answers the newest message someone else sent; to answer or forward a particular one, add its `messageId` from `t3_mail_read` as `targetMessageId`, and `"mode":"forward"` with `to` for a forward. Drafts and settle proposals from either interface appear in Mail for approval. [Connect an outside agent](./outside-agents.md)
