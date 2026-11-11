# Demo notes

How the hackathon demo is set up, how to run it, and what it does and does not show. Setup commands are in the [README](../README.md).

## Status (2026-11-11)

| Item | State |
| --- | --- |
| Demo site | `one-atlas-pxox.atlassian.net`, a Forge demo site active until 2027-02-09 |
| Installation | One development installation covering **Jira (required)** and **Confluence**, major version 3, up to date (`forge install list`) |
| Other site | `decitrace.atlassian.net` is still on major version 2. Forge classifies it as a production site, so it is deliberately not upgraded with development builds. |
| Deployed code | Development version **3.5.0**, deployed from commit `60cbb45` and verified live on project `MC`: one decision, no disclaimer finding, MC-9 flagged as drift, the four listed issues matched, and issue, source and Confluence page links all open on the site. |

Redeploy after code changes with `forge deploy --environment development`. The current scopes cover every feature, so redeploys do not need an installation upgrade.

## Run the demo

1. In Jira on the demo site, open **Apps → Decision Drift Radar**.
2. Enter `MC` (the seeded Marketing Content project) and select **Scan project**.
3. The scan reads the 25 most recently updated MC issues (descriptions and comments) and Confluence pages that mention `MC`.
4. Under **Decisions**, open the finding from *Demo Decision — MC Campaign Coordination*:
   - quote: "Decision: We agreed to use one shared launch plan instead of separate channel plans for the MC website, email, and social campaign."
   - signals: starts with a "Decision:" label; the page title reads like a decision record
5. Under **May affect**, MC-9 comes first (relevance 0.99). This is the drift: the decision replaced separate channel plans, but MC-9's description still says "the email campaign keeps separate channel plans". Its reasons:
   - The same paragraph as the decision lists MC-9
   - Shares terms with the issue: "separate", "plans", "Email", "channel"
   - The issue still mentions "separate channel plans", which this decision replaces
6. MC-10 (0.71, also shares terms), MC-1 and MC-5 (0.50) follow, each because "the same paragraph as the decision lists" it.
7. Click the source link or an issue key to open the page or issue on the site.
8. Select **Mark relevant**, then open MC-9. The issue panel shows the same decision, the "still mentions" reason and the saved review. **Undo review** clears it on both screens.

The page's disclaimer sentence ("This is a sample decision, not an approved Marketing team decision.") is deliberately not a finding. Versions before 3.3.0 listed it as a second decision, and matched MC-9, MC-7 and MC-42 instead of the four listed issues; versions before 3.5.0 had broken Jira and Confluence links.

## Sample data and its limits

- The demo page is labelled sample data. Its full text:
  > DEMO DATA — created for testing Decision Drift Radar. This is a sample decision, not an approved Marketing team decision.
  >
  > Decision: We agreed to use one shared launch plan instead of separate channel plans for the MC website, email, and social campaign. Related Jira issues: MC-1, MC-5, MC-9, MC-10.
  >
  > Status: Demo example only.
- MC issues are Atlassian's seeded sample issues. To show drift, two demo lines were added to the end of MC-9's description on 2026-11-11 (its seeded text is unchanged above them):
  > Send the launch announcement to the customer mailing list.
  >
  > Scheduling: the email campaign keeps separate channel plans, so email goes out on its own timeline before the website and social posts.
- The "still mentions" signal reads what a decision replaces from the decision sentence itself ("X instead of Y"), so the old plan must be named in that sentence, and the issue must use the same phrase.
- `src/domain/fixtures/mcDemoInput.ts` reproduces the page, the 25 MC issue titles and MC-9's description, and `checkFixtures.ts` asserts the expected result. The other live issues have descriptions that the fixture does not capture, so the live scan adds shared-term reasons the fixture lacks (MC-10 scores 0.71 live, 0.50 in the fixture).
- Confluence pages are found by a text search for the project key, so a page must mention `MC` to be scanned.
- `KAN`, the old default key, has no issues on the demo site.
