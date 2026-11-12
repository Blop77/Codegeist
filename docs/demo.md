# Demo notes

How the hackathon demo is set up, how to run it, and what it does and does not show. Setup commands are in the [README](../README.md).

## Status (2026-11-11)

| Item | State |
| --- | --- |
| Demo site | `one-atlas-pxox.atlassian.net`, a Forge demo site active until 2027-02-09 |
| Installation | One development installation covering **Jira (required)** and **Confluence**, major version 4, up to date (`forge install list`) |
| Other site | `decitrace.atlassian.net` is still on major version 2. Forge classifies it as a production site, so it is deliberately not upgraded with development builds. |
| Development | Version **6.x**, verified live on project `MC` (12 Nov 2026): 4 decisions and 2 open questions, including one decision found only through Teamwork Graph; the AI pass; reviews and notes; the sample data; and the Rovo agent. |
| Production | Deployed, and shared by installation link (Distribution: Sharing with anyone). Reviewers install this build. Redeploy production after every change that should reach them. |

Version 4 added the `write:jira-work` scope for the note action, so the installation was upgraded to grant it.

To roll out a scope change:

1. `forge deploy --environment development`
2. `forge install --upgrade --site one-atlas-pxox.atlassian.net --product Jira --environment development`, and approve the new scope.
3. `forge install list` should show version 4, up to date.

Redeploys without scope changes need no installation upgrade.

## Share the app with reviewers

Reviewers install from an installation link, which needs the production environment:

1. `forge deploy --environment production`
2. In the [developer console](https://developer.atlassian.com/console/myapps/), open the app, then **Distribution → Edit**, choose **Sharing**, fill in the app details, select Jira and Confluence, and save.
3. Copy the installation link and give it to reviewers with [testing-instructions.md](testing-instructions.md).

After later changes, deploy to production again. Reviewers who already installed the app get code updates; new permissions need their approval.

## Run the demo

1. In Jira on the demo site, open **Apps → Decision Drift Radar**, or open the MC project and choose **Decision Drift Radar** in its sidebar.
2. Choose **Marketing Content (MC)** and select **Scan project**. The scan reads the 50 most recently updated MC issues, Confluence pages that mention `MC`, and, through Teamwork Graph, decision pages in the Confluence space of the **Marketing** team linked to MC.
3. The **Context from Teamwork Graph** box names the Marketing team and its space, and the pages it added.
4. Findings, each with its quote, source link and reasons:
   - **Social calendar: decisions** (found through Teamwork Graph; the page never mentions MC): "social posts go live the day after the website update, instead of on the same day" → **MC-10** (0.99): the issue still mentions "on the same day".
   - **MC launch sync: decisions**: "use one shared launch plan instead of separate channel plans" → **MC-9** (0.99): the issue still mentions "separate channel plans".
   - **MC launch sync: decisions**: "Product documentation is out of scope for launch week" → **MC-8** (0.99): the issue still mentions "Product documentation".
   - Open question: "Do we need a legal review of the email copy before launch?"
5. Select **Find more with AI**. After about 20–30 seconds it adds one finding labelled **Found by AI**: "After the review, the team is going ahead with Tuesday-only sends for the email campaign." → MC-9.
6. Select **Mark relevant** on a finding, then **Add note to …**, edit the note and **Post comment**. MC-9 already has a note from testing, so post to MC-10 or MC-8 in a demo.
7. Open the issue: its **Decision Drift Radar** panel shows the decision, the review and the note.
8. On MC-9, open **Rovo Chat**, choose the **Decision Drift Radar** agent, and select **Which decisions may affect this issue?**

## Sample data and its limits

- Demo pages on the site (Marketing space, MAR):
  - **MC launch sync: decisions**: two decisions under a Decisions heading, an open question, and a notes line with the indirectly worded decision the AI pass finds.
  - **Social calendar: decisions**: one decision; it does not mention MC, so only Teamwork Graph finds it.
- Demo lines added to issue descriptions: MC-9 ("the email campaign keeps separate channel plans…") and MC-10 ("Scheduling: social posts go live on the same day as the website update.").
- Teamwork Graph link: the existing **Marketing** team was linked to the MC Jira space and to the Marketing Confluence space (team profile → Team links).
- Test data from the judge-path checks also exists: the EO project's "Decision log" page (in MAR, so Teamwork Graph finds it), EO-1's extra line, and test comments on MC-9 and EO-1.
- The "still mentions" signal reads what a decision replaces from the decision sentence itself ("X instead of Y"), so the old plan must be named in that sentence, and the issue must use the same phrase.
- `src/domain/fixtures/mcDemoInput.ts` reproduces the page, the 25 MC issue titles and MC-9's description, and `checkFixtures.ts` asserts the expected result. The other live issues have descriptions that the fixture does not capture, so the live scan adds shared-term reasons the fixture lacks (MC-10 scores 0.71 live, 0.50 in the fixture).
- MC-9 carries one comment posted by the app during verification on 2026-11-11 ("Decision Drift Radar note"). Because that note is recorded, the app shows "Note added to MC-9" and will not post it again. To demo posting live, add a note to another listed issue (MC-1, MC-5 or MC-10).
- Confluence pages are found by a text search for the project key, so a page must mention `MC` to be scanned.
- `KAN`, the old default key, has no issues on the demo site.
