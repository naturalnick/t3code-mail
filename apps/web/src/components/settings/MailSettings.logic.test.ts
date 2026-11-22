import { expect, it } from "vite-plus/test";
import type { MailRule } from "@t3tools/contracts";
import { insertToneNotes, normalizeRule } from "./MailSettings.logic";

it("requires a match and drops empty fields before previewing or saving", () => {
  const rule: MailRule = {
    id: "rule",
    enabled: false,
    match: { from: "  " },
    action: "settle",
    reason: "fyi",
  };
  expect(normalizeRule(rule)).toBeNull();
  expect(
    normalizeRule({ ...rule, match: { from: " ", domain: " example.org ", listId: "list" } }),
  ).toEqual({
    ...rule,
    match: { domain: "example.org", listId: "list" },
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
