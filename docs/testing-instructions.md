# Testing instructions

How to install Decision Drift Radar on your own Atlassian site and see it working. Part 1 needs no setup. Part 2 uses your own Jira and Confluence data and takes about five minutes. Part 3 shows the Teamwork Graph integration with your own team (about five more minutes), and Part 4 the Rovo agent.

## What you need

- An Atlassian cloud site with **Jira** and **Confluence**, where you are a site admin.
- The [installation link](https://developer.atlassian.com/console/install/68a157f1-8d36-4681-ad80-656a45181b6a?signature=AYABeErQrktzFiwiP0JBC0WC3lIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBL6%2BHB6IcT2W5B6PYJtfwSgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDFYEFTpntWYOhX%2BLDwIBEIA7t7oDfDaRrRCxVKZubC4B7RA97rAkfVk%2FnBHm30DkUpGgmZO5LjiMRcEQKdQr%2F8NGA4JfBbz7veBJfCoAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgFFUfSUfE0TtKWq%2BEgaVIIXAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMA8HAfzMzNyXQzYniAgEQgDsRW2ABoyiQYKniXglzhfW9UWoWrX6FhadL5gn6JMbPYOXHZa7oZ%2B4S0cAL2Sns33x%2F8xHUQye65iXv8wAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAbS4b6dRAYV%2FLK6Q23vA0jsAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAxHOKip3ek9xrrZpT8CARCAO%2FH4QqO82%2FBmgzDOvCFDwMa2qz3D%2Bz473b85tV%2FO%2BOLZBDWbyywsCEuX2XEQqNiU3VnmEBFasYJJBAE8AgAAAAAMAAAQAAAAAAAAAAAAAAAAACYgLikmR2W48JXlIXvTTyf%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADJVn7ZYE%2Fz30hEDuvLgQQ%2BeF6C65RMfI0M1pqA8yP5N5eSVTAt4EK9WoBB2UpvHdH93fFBCl2wMoomDux9tUp6U6VE%3D&product=jira&product=confluence), also given in the submission and the README.

## Install

1. Open the installation link and choose your site.
2. Install the app into **Jira** first. Jira is required.
3. Open the link again (or use **Connected apps**) and add **Confluence** on the same site. Without this step, Confluence pages cannot be read and the app shows a "Confluence source search unavailable" warning. Jira issues and comments are still scanned.
4. Approve the permissions:

| Permission | Why the app needs it |
| --- | --- |
| `read:jira-work` | Read issues, descriptions and comments in the project you scan, and list your projects. |
| `search:confluence`, `read:confluence-content.all` | Find and read Confluence pages that mention the project key. |
| `storage:app` | Save each finding's review status, and record notes already posted. |
| Forge LLMs (AI feature, shown on the install screen) | The optional **Find more with AI** pass. Runs only on request. |
| `read:graph:project:jira`, `read:graph:team:atlassian`, `read:graph:space:confluence`, `read:graph:page:confluence` | Teamwork Graph: find the teams linked to the project you scan, their Confluence spaces, and pages linked from decision pages. |
| `write:jira-work` | Post one comment on an issue, only when you review a note and select **Post comment**, or post a Rovo draft from the Jira issue panel. |

The app calls no external services, and all data stays in Atlassian. The optional AI pass uses a model hosted by Atlassian (Forge LLMs), and runs only when you select **Find more with AI**. Because it is an AI feature, Atlassian shows it on the install screen and asks site admins to approve it.

## Part 1: see it in one minute (no setup)

1. In Jira, open **Apps → Decision Drift Radar**.
2. Select **Try with sample data**.

This runs the real analysis on a small fictional project bundled with the app. The baseline sample does not read or change Jira or Confluence data. Its optional AI pass stores usage/cooldown records in Forge storage. You should see five decisions, two open questions and one proposal, and a **Context from Teamwork Graph (sample)** box. One decision, "Manual fraud review covers high-risk orders only…", comes from a page in the Payments team's own space that never mentions PAY; it shows how a Teamwork Graph discovery looks ("Found through Teamwork Graph…", affecting PAY-108). Part 3 shows the same thing with your own team. Each finding shows the quoted evidence, the wording signals, and the issues it may affect with the reasons, for example:

> **PAY-103 · relevance 0.85**
> • Shares terms with the issue: "confirmation", "mail", "old", "relay"
> • The issue still mentions "old mail relay", which this decision replaces

Sample findings have no links, and cannot be reviewed or posted. Part 2 covers those.

## Part 2: your own data (about five minutes)

Use any Jira project that has at least one issue (Jira now calls projects "spaces"). On a brand-new site with no projects, create one and add an issue first. Below, `KEY` is that project's key (for example `KAN`), and `KEY-1` is one of its issues.

**1. Create a Confluence page** in any space, titled `Decision log`, with these three paragraphs. Replace `KEY` with your project key in both places, and publish:

```text
Launch planning notes for KEY.

Decision: We agreed to use one shared launch plan instead of separate channel plans. Related Jira issues: KEY-1.

Open question: Do we need a second approver for the launch checklist?
```

Keep the Decision paragraph as one paragraph. The page must mention the project key, because the app finds pages by searching for it.

**2. Add one line to the end of `KEY-1`'s description** and save:

```text
Scheduling: this work keeps separate channel plans for now.
```

This makes the issue still describe the plan the decision replaced. That is the drift the app looks for.

**3. Scan.** Open **Apps → Decision Drift Radar**, choose your project in the **Jira project** dropdown, and select **Scan project**. (Confluence search can take a minute to index a new page. If the page is not listed under "Confluence pages mentioning KEY", wait and scan again.)

You should see:

- **Decisions · 1**: "We agreed to use one shared launch plan instead of separate channel plans." with a link to your page.
- Under **May affect**, `KEY-1` with these reasons:
  - **Outdated wording found**
  - The same paragraph as the decision lists KEY-1
  - The issue still mentions "separate channel plans", which this decision replaces
- **Open questions · 1**: "Do we need a second approver for the launch checklist?"

**4. Review it.** Select **Mark relevant**. The review is saved for the project; **Undo review** clears it. Nothing in Jira changes yet.

**5. Post a note.** Under `KEY-1`, select **Add note to KEY-1**. Edit the suggested note if you like, or select **Draft with AI** to have the AI write it from the decision and the issue (when a phrase in the description conflicts with the decision, the draft suggests the change, quoting that phrase word for word). Then select **Post comment to KEY-1**. The card shows "Note added to KEY-1" with a **View comment** link. The comment on the issue is in your name and contains the note, the quoted decision and a link to the page.

**6. Try the AI pass (optional).** Below the findings, select **Find more with AI**. It looks for decisions the wording rules missed and shows each with a **Found by AI** label and a quote checked against its source. On your test page it may find nothing more, which is expected. **Try with sample data** includes one indirectly worded decision ("Marcus confirmed the team is locking in weekly payouts to merchants starting in January"), so running the AI pass there shows a result. On a real project, verified AI findings are saved: the next scan, the issue panel and the Rovo agent show them too, after checking each quote again against the current source text, without calling the model.

**7. Check the safeguards.**

- Scan again: there is still one decision. The app's own comment is not read as a new decision, and `KEY-1` no longer offers to post the note.
- Open `KEY-1`: the **Decision Drift Radar** panel on the issue shows the same decision, its review and the posted note.
- Open the project and choose **Decision Drift Radar** in its sidebar (Jira labels it "Space navigation"): the app scans that project without asking for a key. On a new site the app may not be in the sidebar yet: use **Add to navigation**, then find it under **More**.

**8. Verify the correction.** In Jira, replace the scheduling line you added to the issue with `Scheduling: this work follows one shared launch plan.` Save and scan again. `KEY-1` now shows **Replacement wording found**. Its reason says that the issue mentions “one shared launch plan” and no longer mentions “separate channel plans”. The existing comment remains available. Radar checks the wording on each scan. Deleting the old wording alone does not produce this status.

The radar also remembers the drift. Before the edit, the **Radar** summary under the scan line counted `KEY-1` as still drifting, with "Drifting since …" under it. After the edit, `KEY-1` shows **Resolved** · "No longer mentions “separate channel plans”", and the summary counts it as resolved. You don't need to scan: a few minutes after you save the issue, Jira notifies the app, and the issue panel and the next scan show "noticed when the issue was edited". If you scan straight away, it shows "found by a later scan" instead.

**9. See what's new.** Add another decision paragraph to your Confluence page, for example `Decision: We agreed to publish release notes on Fridays instead of Mondays. Related Jira issues: KEY-1.` Wait a minute for search indexing, and scan again. The new decision has a **New since your last visit** label, and the summary counts it. On your first visit nothing is labelled new, because there is no earlier visit to compare with.

## Part 3: Teamwork Graph with your own team (about five minutes)

This part shows decisions that live in a team's own Confluence space and never mention the project key. Only the Teamwork Graph connects them to the project.

**1. Create a team.** Open `https://YOUR-SITE.atlassian.net/people`, select **Create team**, name it (for example `Launch team`) and add yourself. You can use an existing team instead.

**2. Link the team to your project and a space.** On the team's profile, find **Team links** and select **+**. Choose your Jira project (`KEY`). Select **+** again and choose a Confluence space, for example the one you used in Part 2.

**3. Create a page in that space** titled `Team decisions`, with these two paragraphs, and publish. Do not mention `KEY` on this page:

```text
Weekly sync with the launch team.

Decision: Status updates go out on Fridays instead of on Mondays.
```

The title matters: in team spaces the app reads pages whose title says they hold decisions ("decision", "decisions", "decided", "agreed" or "ADR").

**4. Add one more line to `KEY-1`'s description** and save:

```text
Status updates go out on Mondays.
```

**5. Scan again.** You should see:

- A **Context from Teamwork Graph** box naming your team and its Confluence space, and saying it added one decision page that does not mention `KEY`.
- A new decision, "Status updates go out on Fridays instead of on Mondays.", with **Found through Teamwork Graph: a Confluence space of team Launch team, linked to KEY**.
- Under **May affect**, `KEY-1`, with "The issue still mentions "on Mondays", which this decision replaces".

Teamwork Graph can take a few minutes to index new team links. Until then there is no **Context from Teamwork Graph** box, and a line under the scan summary says "Teamwork Graph shows no Atlassian team linked to KEY…". Wait a few minutes and scan again. Without Part 3, the scan works as in Part 2 and shows that same line.

If something in the Teamwork Graph path fails, the scan still completes and that line says which step failed, keeping what was found before it:

- "Teamwork Graph gave no usable answer about teams linked to KEY…": the Graph answered without a usable result. Scan again in a minute.
- "Teamwork Graph could not be reached (HTTP …)…": the Graph request itself failed.
- "Launch team has no Confluence space linked in Teamwork Graph…": the team is linked to the project but not to a space. Repeat step 2 for the space.
- "Teamwork Graph found Launch, but Confluence could not search it (HTTP 403)…": the team and space were found, but your account cannot search that space, or the app is not installed in Confluence.
- "Could not read Teamwork Graph links from 1 of 3 decision pages…": links from the other pages were still read.

## Part 4: ask the Rovo agent (optional)

If Rovo is available on your site, the app adds an agent named **Decision Drift Radar**. Rovo is not enabled on every site; a new free developer site may not have it. Atlassian's Codegeist demo sites (`forge site provision`) include it.

1. Open `KEY-1` in Jira and open **Rovo Chat**.
2. In the agent menu at the top of the chat, search for **Decision Drift Radar** and select it.
3. Choose the starter **Which decisions may affect this issue?**

The agent runs the same scan and answers with the decision, its exact quote, a link to your page, the reasons (starting with "The issue still mentions "separate channel plans", which this decision replaces"), and whether a teammate has reviewed it. You can also ask it to scan the project, or to **find more with AI**, which runs the AI pass.

To try a Rovo draft, choose an affected issue without a posted note and ask **“Draft a note for KEY-1 about this decision”**. Rovo asks for confirmation to prepare the draft. Open the issue's **Decision Drift Radar** panel and select **Load Rovo draft**. Check the exact note, quote, source and audience. Select **Post Rovo draft to KEY-1** if you want the comment posted. The draft expires after ten minutes. If the issue or source changes after preparation, make a new draft. Preparing and loading the draft leave Jira unchanged.

## If something looks wrong

| What you see | What to do |
| --- | --- |
| "Confluence source search unavailable" | The app is not installed into Confluence on this site. Repeat install step 3. |
| "No matching Confluence pages found" | The page must contain the project key as text. Search indexing can also lag by a minute. |
| "No decisions detected" | The scan looks for explicit wording such as "Decision:", "we agreed" or "we decided to". Check the page text matches step 1. |
| The decision appears but `KEY-1` has no "still mentions" reason | The issue description must contain the exact phrase "separate channel plans". |
| "You do not have permission to comment" | Your account needs permission to add comments in that project. Nothing was posted. |

## What the app does not do

- It never edits issue fields, statuses or assignees. Its only change to Jira is the comment you confirm in Jira.
- Its issue-update trigger only marks a tracked drift resolved; it does not find new decisions in the background. New findings appear when someone scans or opens the issue panel.
- It reads the 50 most recently updated issues, up to 20 project-key search pages, up to 10 additional team-space pages and up to 10 linked pages. Results depend on permissions and search/Graph indexing.
- The main scan works on English text with explicit decision wording and uses no AI model, so the same input always gives the same findings. The optional AI pass finds indirectly worded decisions; it keeps a finding only if its quote is found word for word in the source, and a usage counter targets 40 runs per site per day, without an atomic concurrent-request guarantee. Verified AI-pass findings are saved per project, checked again against the current sources on every scan, and shown on the project page, the issue panel and in Rovo; they disappear if their quote is no longer in the source. **Draft with AI** counts towards the same daily limit.

## Verification notes (12 November 2026)

Production 3.3.0 was checked on the judge test site. The sample scan worked, Teamwork Graph discovered a decision page that omitted the Jira project key, and the reviewed note appeared on the issue. A rescan offered no duplicate note. Rovo was unavailable on that site. Draft preparation and posting from the Jira issue panel were checked on the development demo site. Jira may label project navigation **Space navigation**; use the same Apps entry within that space. Extra existing decision pages can add findings beyond the minimal test example, especially through Teamwork Graph.

The app reserves the finding and issue before posting and can recover a missing receipt from the Jira comment. If a write remains uncertain, check the issue’s comments before retrying.
