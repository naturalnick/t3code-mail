import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type MailRule,
  type UsageSummary,
} from "@t3tools/contracts";
import { insertToneNotes, mailUsageShare, normalizeRule } from "./MailSettings.logic";

it("requires a scope or a condition and drops empty fields before previewing or saving", () => {
  const rule: MailRule = {
    id: "rule",
    enabled: false,
    match: { from: "  " },
    when: " ",
    reason: "fyi",
  };
  const { when: _when, ...bare } = rule;
  expect(normalizeRule(rule)).toBeNull();
  expect(
    normalizeRule({ ...rule, match: { from: " ", domain: " example.org ", listId: "list" } }),
  ).toEqual({ ...bare, match: { domain: "example.org", listId: "list" } });
  expect(normalizeRule({ ...rule, when: " Shipping updates " })).toEqual({
    ...bare,
    match: {},
    when: "Shipping updates",
  });
});

it("adds voice notes within the existing tone section or creates one", () => {
  const notes = "- Keep it short.";
  const original = "## Tone and signature\n- Cheers\n\n## Priorities\n- Family\n";
  expect(insertToneNotes(original, notes)).toBe(
    "## Tone and signature\n- Cheers\n- Keep it short.\n\n## Priorities\n- Family\n",
  );
  expect(insertToneNotes("# EMAIL.md\n", notes)).toBe(
    "# EMAIL.md\n\n## Tone\n\n- Keep it short.\n",
  );
  expect(insertToneNotes("## Tone\r\n- Hello\r\n", notes)).toBe(
    "## Tone\r\n- Hello\r\n- Keep it short.\r\n",
  );
  expect(insertToneNotes(original, "  ")).toBe(original);
});

it("compares Mail with recorded provider tokens only when the summary can support a share", () => {
  const day = UsageDay.make("2026-11-16");
  const source = {
    fingerprint: {
      hostId: "host",
      provider: "codex",
      resolvedHomePath: "/synthetic",
      volumeId: "",
    },
    status: "ok",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 1,
    message: null,
  } as const;
  const summary: UsageSummary = {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-11-16T18:00:00Z",
    sinceDay: day,
    untilDay: day,
    timeZone: "UTC",
    sources: [source],
    scanDurationMs: 0,
    pricing: { status: "unavailable", source: "fixture", knownModels: 0, fetchedAt: null },
    buckets: [
      {
        day,
        provider: "codex",
        model: "test",
        records: 1,
        sessions: 1,
        unpricedRecords: 1,
        costUsd: 0,
        cacheSavingsUsd: 0,
        costSource: "unpriced",
        totals: {
          uncachedInputTokens: 20,
          cachedInputTokens: 30,
          cacheCreationTokens: 10,
          outputTokens: 40,
          reasoningTokens: 25,
        },
      },
    ],
  };
  const environment = EnvironmentId.make("test");
  expect(mailUsageShare(environment, 25, summary)).toBe(0.25);
  expect(mailUsageShare(environment, 120, summary)).toBeNull();
  expect(mailUsageShare(environment, 0, { ...summary, buckets: [] })).toBeNull();
  expect(
    mailUsageShare(environment, 25, { ...summary, sources: [{ ...source, refreshing: true }] }),
  ).toBeNull();
});
