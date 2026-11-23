import type { EnvironmentId, MailThreadDetail, MailThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { mailEnvironment } from "../../state/mail";
import { useEnvironmentQuery } from "../../state/query";

const INTENT_DELAY_MS = 120;

/** The newest message opens first and is the one the reader sees without scrolling. */
function newestMessageBody(environmentId: EnvironmentId, detail: MailThreadDetail) {
  const newest = detail.messages.at(-1);
  return newest === undefined
    ? null
    : mailEnvironment.messageBody({
        environmentId,
        input: { threadId: detail.thread.id, messageId: Number(newest.id) },
      });
}

/**
 * Reads the thread and its newest formatted body once the pointer or focus rests on a row, so the
 * click paints the email at once. Passing over rows asks nothing; leaving a row stops reading it.
 */
export function useMailIntentPrefetch(environmentId: EnvironmentId) {
  const [threadId, setThreadId] = useState<MailThreadId | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detail = useEnvironmentQuery(
    threadId === null
      ? null
      : mailEnvironment.thread({
          environmentId,
          input: { threadId, includeSpamAndUnsubscribe: true },
        }),
  ).data;
  useEnvironmentQuery(
    detail === null || detail.thread.id !== threadId
      ? null
      : newestMessageBody(environmentId, detail),
  );
  return useStableCallback((next: { readonly id: MailThreadId } | null) => {
    clearTimeout(timer.current);
    if (next === null) {
      setThreadId(null);
      return;
    }
    timer.current = setTimeout(() => setThreadId(next.id), INTENT_DELAY_MS);
  });
}
