# Demo notes

How the hackathon demo is set up, how to run it, and what it does and does not show. Setup commands are in the [README](../README.md).

## Status (2026-11-11)

| Item | State |
| --- | --- |
| Demo site | `one-atlas-pxox.atlassian.net`, a Forge demo site active until 2027-02-09 |
| Installation | One development installation covering **Jira (required)** and **Confluence**, major version 3, up to date (`forge install list`) |
| Other site | `decitrace.atlassian.net` is still on major version 2. Forge classifies it as a production site, so it is deliberately not upgraded with development builds. |
| Deployed code | Development version **3.5.0**, deployed from commit `60cbb45` and verified live on project `MC`: one decision, no disclaimer finding, the four listed issues matched, and issue, source and Confluence page links all open on the site. |

Redeploy after code changes with `forge deploy --environment development`. The current scopes cover every feature, so redeploys do not need an installation upgrade.

## Run the demo

1. In Jira on the demo site, open **Apps → Decision Drift Radar**.
2. Enter `MC` (the seeded Marketing Content project) and select **Scan project**.
3. The scan reads the 25 most recently updated MC issues (descriptions and comments) and Confluence pages that mention `MC`.
4. Under **Decisions**, open the finding from *Demo Decision — MC Campaign Coordination*:
   - quote: "Decision: We agreed to coordinate the MC website, email, and social campaign under one launch plan."
   - signals: starts with a "Decision:" label; the page title reads like a decision record
   - may affect: MC-1, MC-5, MC-9 and MC-10, each because "the same paragraph as the decision lists" it
5. Click the source link or an issue key to open the page or issue on the site.
6. Select **Mark relevant**, then open MC-1 or MC-10. The issue panel shows the same decision and its saved review. **Undo review** clears it on both screens.

The page's disclaimer sentence ("This is a sample decision, not an approved Marketing team decision.") is deliberately not a finding. Versions before 3.3.0 listed it as a second decision, and matched MC-9, MC-7 and MC-42 instead of the four listed issues; versions before 3.5.0 had broken Jira and Confluence links.

## Sample data and its limits

- The demo page is labelled sample data. Its full text:
  > DEMO DATA — created for testing Decision Drift Radar. This is a sample decision, not an approved Marketing team decision.
  >
  > Decision: We agreed to coordinate the MC website, email, and social campaign under one launch plan. This replaces separate channel plans. Related Jira issues: MC-1, MC-5, MC-9, MC-10.
  >
  > Status: Demo example only.
- `src/domain/fixtures/mcDemoInput.ts` reproduces this page and the 25 MC issue titles, and `checkFixtures.ts` asserts the expected result. The live issues also have descriptions that the fixture does not capture, so live results can add shared-term matches (for example MC-7) after the four listed issues.
- MC issues are Atlassian's seeded sample issues. None of them still describes a superseded plan, so this demo shows **linking a decision to the work it affects**, not the "issue still mentions what the decision replaces" drift signal. To show that signal, add an issue or comment that still states the old plan (for example "Separate channel plans for website and email") and rescan.
- Confluence pages are found by a text search for the project key, so a page must mention `MC` to be scanned.
- `KAN`, the old default key, has no issues on the demo site.
