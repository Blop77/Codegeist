# Demo notes

How the hackathon demo is set up, how to run it, and what it does and does not show. Setup commands are in the [README](../README.md).

## Status (2026-11-12)

| Item | State |
| --- | --- |
| Demo site | `one-atlas-pxox.atlassian.net`, a Forge demo site active until 2027-02-09 |
| Installation | One development installation covering **Jira (required)** and **Confluence**, major version 6, up to date (`forge install list`) |
| Other site | `decitrace.atlassian.net` is still on major version 2. Forge classifies it as a production site, so it is deliberately not upgraded with development builds. |
| Development | Version **6.10.0**, verified on MC-10 for resolution on edit and reopening after restoration, with the drift history carried over from the earlier storage record. The earlier **6.7.0** test verified Rovo draft preparation and posting from the Jira issue panel. |
| Production | Version **3.7.0**, checked on `jiggzer.atlassian.net` on 13 November: a project scan found the Teamwork Graph team link, a decision page in that team's space that never mentions the project key, and two drifts. The earlier **3.3.0** check posted a reviewed note once to the affected issue. |

Version 4 added the `write:jira-work` scope for the note action, so the installation was upgraded to grant it.

To roll out a scope change:

1. `forge deploy --environment development`
2. `forge install --upgrade --site one-atlas-pxox.atlassian.net --product Jira --environment development`, and approve the new scope.
3. `forge install list` should show the deployed major version, up to date.

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
5. Select **Find more with AI**. Timing varies; allow roughly 30–60 seconds. It adds one finding labelled **Found by AI**: "After the review, the team is going ahead with Tuesday-only sends for the email campaign." → MC-9.
6. Select **Mark relevant** on a finding, then **Add note to …**, edit the note and **Post comment**. MC-9 already has a note from testing, so post to MC-10 or MC-8 in a demo.
7. Open the issue: its **Decision Drift Radar** panel shows the baseline decision, the review and the note. Verified AI-pass findings are saved for the project, so the panel (and the Rovo agent) show them too, re-checked against the current source text without a model call.
8. On MC-9, open **Rovo Chat**, choose the **Decision Drift Radar** agent, and select **Which decisions may affect this issue?** Ask it to draft a note for an affected issue without a posted note. Open that issue’s **Decision Drift Radar** panel, select **Load Rovo draft**, review the exact comment, then choose **Post Rovo draft** in Jira.

## Demo the Graph-to-resolution workflow

Use MC-10 as the main story. Show **Social calendar: decisions** and its **Found through Teamwork Graph** label, then show Jira's original scheduling line. It tells the team to publish on the same day as the website update, while the Confluence decision says to publish the day after.

On the demo issue, replace the scheduling line with `Scheduling: social posts go live the day after the website update.` Save and leave the Radar project page and issue panel closed for at least four minutes. Cut over the wait in the video. Return to the issue panel and show **Old wording removed** and **Replacement wording found**, "No longer mentions “on the same day”", **noticed when the issue was edited**, and "Now mentions “after the website update”, the wording the decision asks for." The project summary moves from **3 open drifts** to **2 open drifts · 1 resolved drift**. (The 3.x builds before this change labelled these counts "issues still drifting" and the status **Resolved**.) The edit was made by a person. Radar detected the change.

After capturing the result, restore `Scheduling: social posts go live on the same day as the website update.` and rescan. The development test confirmed the drift reopens with its original date after restoration (**3 open drifts · 0 resolved drifts**).

## Sample data and its limits

- Demo pages on the site (Marketing space, MAR):
  - **MC launch sync: decisions**: two decisions under a Decisions heading, an open question, and a notes line with the indirectly worded decision the AI pass finds.
  - **Social calendar: decisions**: one decision; it does not mention MC, so only Teamwork Graph finds it.
- Demo lines added to issue descriptions: MC-9 ("the email campaign keeps separate channel plans…") and MC-10 ("Scheduling: social posts go live on the same day as the website update.").
- Teamwork Graph link: the existing **Marketing** team was linked to the MC Jira space and to the Marketing Confluence space (team profile → Team links).
- The EO test page was moved to the trash before recording so it no longer adds findings to the MC demo. Test issues and comments from earlier verification may still be present.
- The "still mentions" signal reads what a decision replaces from the decision sentence itself ("X instead of Y"), so the old plan must be named in that sentence, and the issue must use the same phrase.
- `src/domain/fixtures/mcDemoInput.ts` captures an earlier MC demo state, with 25 issue titles and MC-9's description. It is a regression fixture, not a snapshot of the current Graph-expanded live demo. Live content and shared-term scores can differ.
- MC-9 carries one comment posted by the app during verification on 2026-11-11 ("Decision Drift Radar note"). The app shows "Note added to MC-9" and uses the reservation and receipt to prevent repeat posting. To demo posting live, add a note to another listed issue (MC-1, MC-5 or MC-10).
- Text-search discovery uses the project key. Teamwork Graph can additionally discover decision pages in linked team spaces and linked pages without `MC` in their text. Indexing may lag; if a fresh scan reports no linked space, allow indexing time and retry.
- `KAN`, the old default key, has no issues on the demo site.
