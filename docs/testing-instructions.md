# Testing instructions

How to install Decision Drift Radar on your own Atlassian site and see it working. Judges: start with Part 1. It needs no data setup (the app still has to be installed) and takes about one minute. Part 2 uses your own Jira and Confluence data and takes about five minutes. Part 3 shows the Teamwork Graph integration with your own team (about five minutes of steps, plus a wait for Teamwork Graph to index them), and Part 4 the Rovo agent.

## What you need

- An Atlassian cloud site with **Jira** and **Confluence**, where you are a site admin.
- The [installation link](https://developer.atlassian.com/console/install/68a157f1-8d36-4681-ad80-656a45181b6a?signature=AYABeErQrktzFiwiP0JBC0WC3lIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBL6%2BHB6IcT2W5B6PYJtfwSgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDFYEFTpntWYOhX%2BLDwIBEIA7t7oDfDaRrRCxVKZubC4B7RA97rAkfVk%2FnBHm30DkUpGgmZO5LjiMRcEQKdQr%2F8NGA4JfBbz7veBJfCoAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgFFUfSUfE0TtKWq%2BEgaVIIXAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMA8HAfzMzNyXQzYniAgEQgDsRW2ABoyiQYKniXglzhfW9UWoWrX6FhadL5gn6JMbPYOXHZa7oZ%2B4S0cAL2Sns33x%2F8xHUQye65iXv8wAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAbS4b6dRAYV%2FLK6Q23vA0jsAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAxHOKip3ek9xrrZpT8CARCAO%2FH4QqO82%2FBmgzDOvCFDwMa2qz3D%2Bz473b85tV%2FO%2BOLZBDWbyywsCEuX2XEQqNiU3VnmEBFasYJJBAE8AgAAAAAMAAAQAAAAAAAAAAAAAAAAACYgLikmR2W48JXlIXvTTyf%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADJVn7ZYE%2Fz30hEDuvLgQQ%2BeF6C65RMfI0M1pqA8yP5N5eSVTAt4EK9WoBB2UpvHdH93fFBCl2wMoomDux9tUp6U6VE%3D&product=jira&product=confluence), also given in the submission and the README.

## Install

1. Open the installation link and choose your site.
2. Install the app into **Jira** first. Jira is required.
3. Open the link again (or use **Connected apps**) and add **Confluence** on the same site. Without this step, Confluence pages cannot be read and the app shows a "Confluence project-key search unavailable" warning. Jira issues and comments are still scanned.
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

## Part 1: see it in one minute (sample data, no setup)

**Start here.** Everything in this part is fictional sample data, labelled as sample in the app. It is not a result from your site. The app must be installed first (see **Install**).

1. In Jira, open **Apps → Decision Drift Radar**.
2. Select **Try with sample data**. Do not choose a project first: this button scans only the bundled sample.

This runs the real analysis on a small fictional payments team (project PAY) bundled with the app. The baseline sample does not read or change Jira or Confluence data. Its optional AI pass stores usage/cooldown records in Forge storage.

Expected results, as the app shows them:

- A banner titled **Sample data: a fictional payments team**.
- **Scanned 8 sample issues and 3 sample Confluence pages.**
- Three groups: **Decisions · 5**, **Open questions · 2** and **Proposals · 1**.
- A **Context from Teamwork Graph (sample)** box reading: "Teams linked to PAY: Payments. Their Confluence spaces: Payments team (sample). Added 1 decision page from those spaces and 0 linked pages that do not mention PAY."
- The sample Teamwork Graph finding, under **Decisions**: **Manual fraud review covers high-risk orders only, instead of all international orders.** It comes from the page "Payments team: risk decisions", which never mentions PAY, and carries the line **Found through Teamwork Graph: a Confluence space of team Payments, linked to PAY (sample)**. Under **May affect** it lists **PAY-108**, with **Outdated wording found** and the reason "The issue still mentions “international orders”, which this decision replaces".

The sample Graph finding stands in for a live discovery. Live results never carry the "(sample)" label; Part 3 shows a live one with your own team.

Each finding shows the quoted evidence, the wording signals, and the issues it may affect with the reasons, for example:

> **PAY-103 · Strong match: still uses the replaced wording**
> • Shares terms with the issue: “confirmation”, “mail”, “old”, “relay”
> • The issue still mentions “old mail relay”, which this decision replaces
> *Match score 0.85: a signal strength from these reasons, not a probability.*

**3. See what happens after review (sample only).** On any sample finding, select **Mark relevant (sample)**, then **Preview a note for PAY-…** under an affected issue. A **Sample only** box says nothing is saved or posted, and the preview shows the exact comment a teammate would post:

- For a decision from a sample Confluence page (for example the fraud-review finding and **PAY-108**), the preview is the fixed follow-up: "A recorded decision may affect this issue. Its source may not be visible to everyone who can see this issue, so it is not quoted here. …" On a real project the app never copies a Confluence page into Jira, because it cannot check that everyone on the issue may read that page.
- For the decision in a Jira comment ("We will cap retries at 3 instead of 5.", on **PAY-107**), you can edit the note and select **Preview comment**: the preview includes your note, the quoted decision and its source, because a comment in the same project is visible to everyone who can see the issue.

Sample reviews are not saved, and the sample cannot post anything. Part 2 shows the real review and posting.

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

**5. Post a follow-up.** Under `KEY-1`, select **Add note to KEY-1**. Because this decision comes from a Confluence page, the app shows a **Comment preview** with the fixed follow-up and the reason: "The decision comes from a Confluence page. The app cannot check that everyone who can see this Jira issue may also read that page, so the comment does not quote it, name it or link to it." There is no note to edit and no **Draft with AI** for this source. Select **Post follow-up to KEY-1**. The card shows "Note added to KEY-1" with a **View comment** link. The comment on the issue is in your name and contains exactly the previewed text, with no quote, page title or link.

The server builds the comment, and posts it only if it is still exactly the preview you confirmed. If the source or who can see it changed in between, nothing is posted and the new preview is shown.

*To see a quoted note:* add a comment to `KEY-1` reading `Decision: we agreed the launch email uses the shared plan instead of separate channel plans.`, scan again, mark that finding relevant, and select **Add note to KEY-1**. A decision in a Jira comment in the same project, with no issue security level or comment restriction, is visible to everyone who can see the issue, so you can edit the note (or select **Draft with AI**), select **Preview comment**, and post a comment that includes your note, the quoted decision and a link to the comment.

**6. Try the AI pass (optional).** Below the findings, select **Find more with AI**. It looks for decisions the wording rules missed and shows each with a **Found by AI** label and a quote checked against its source. On a real project it runs in the background and usually finishes within a minute; the page waits for it, and you can also leave and scan again later. On your test page it may find nothing more, which is expected. **Try with sample data** includes one indirectly worded decision ("Marcus confirmed the team is locking in weekly payouts to merchants starting in January"), so running the AI pass there shows a result. On a real project, verified AI findings are saved: the next scan, the issue panel and the Rovo agent show them too, after checking each quote again against the current source text, without calling the model.

**7. Check the safeguards.**

- Scan again: there is still one decision. The app's own comment is not read as a new decision, and `KEY-1` no longer offers to post the note.
- Open `KEY-1`: the **Decision Drift Radar** panel on the issue shows the same decision, its review and the posted note. If the panel isn't shown, use the apps button below the issue title and choose **Decision Drift Radar**; Jira then keeps the panel on the issue.
- Open the project and choose **Decision Drift Radar** in its sidebar (Jira labels it "Space navigation"): the app scans that project without asking for a key. On a new site the app may not be in the sidebar yet: use **Add to navigation**, then find it under **More**.

**8. Verify the correction.** In Jira, replace the scheduling line you added to the issue with `Scheduling: this work follows one shared launch plan.` Save and scan again. `KEY-1` now shows **Replacement wording found**. Its reason says that the issue mentions “one shared launch plan” and no longer mentions “separate channel plans”. The existing comment remains available. Radar checks the wording on each scan. Deleting the old wording alone does not produce this status.

The radar also remembers the drift. Before the edit, the **Radar** summary under the scan line counted `KEY-1` as still drifting, with "Drifting since …" under it. After the edit, `KEY-1` shows **Old wording removed** and **Replacement wording found** · "No longer mentions “separate channel plans”", with "Now mentions “one shared launch plan”, the wording the decision asks for.", and the summary counts it as a resolved drift. If you had deleted the line instead, it would show only **Old wording removed**, with "The decision's wording (“one shared launch plan”) is not in the issue yet. Check the issue says what was decided." The summary counts drifts, one per decision and issue, so an issue affected by two decisions counts twice. If the old wording comes back, the next scan reopens the drift with its original date. You don't need to scan: a few minutes after you save the issue, Jira notifies the app, and the issue panel and the next scan show "noticed when the issue was edited". If a scan resolves the drift before Jira delivers the update, it shows "found by a later scan".

**9. See what's new.** Add another decision paragraph to your Confluence page, for example `Decision: We agreed to publish release notes on Fridays instead of Mondays. Related Jira issues: KEY-1.` Wait a minute for search indexing, and scan again. The new decision has a **New since your last visit** label, and the summary counts it. On your first visit nothing is labelled new, because there is no earlier visit to compare with.

## Part 3: Teamwork Graph with your own team (about five minutes, plus an indexing wait)

This part shows decisions that live in a team's own Confluence space and never mention the project key. Only the Teamwork Graph connects them to the project. Unlike Part 1, everything here is a **live** result from your site: it has no "(sample)" label.

In the steps, `KEY` is your Jira project key, `KEY-1` is a test issue from Part 2, and `Launch team` is the team you create.

**1. Create a team (skip this if you already have one to use).** Select the **Teams** dropdown in the Atlassian navigation and select **Create team**. The same dropdown has **Search people and teams**, which opens the people and team directory. Name the team `Launch team`. Under **Invite people to your team**, keep yourself as a member: a team needs at least one member. Create the team.

**2. Link the team to your Jira project and to a Confluence space.** Open the team's profile (`Launch team`, from the Teams dropdown or the directory). Find the **Team links** section and select its add button (**+**). Choose your Jira project `KEY`. Add again and choose the Confluence space you will use in step 3. A team profile can hold up to 10 links in total and a team can link up to 15 spaces, so two links are enough.

Check that both appear under **Team links** before you continue. Atlassian's support page documents the Team links section, but not a fixed click path for it, so the labels can differ between layouts. Atlassian also documents a shortcut from the Jira project: open the project, select the team icon near its name, search for `Launch team` and select **Add**. That shortcut links the team to the project only, so still add the Confluence space from the team profile. These steps use the team profile, which Atlassian documents for both links.

**3. Create the team page in that Confluence space.** Open the space you linked in step 2, create a page, and set the title and body below exactly. Publish.

Title:

```text
Team decisions
```

Body:

```text
Weekly sync with the launch team.

Decision: Status updates go out on Fridays instead of on Mondays.
```

Do not mention `KEY` or any issue key such as `KEY-1` anywhere on this page, title and body included. A page that mentions the project key is found by the ordinary key search instead, and the Teamwork Graph line in step 5 does not appear for it. The title matters: in team spaces the app reads pages whose title says they hold decisions ("decision", "decisions", "decided", "agreed" or "ADR").

**4. Add one more line to `KEY-1`'s description** and save. Keep the Part 2 line:

```text
Status updates go out on Mondays.
```

**5. Wait, then scan.** Atlassian does not publish how long Teamwork Graph takes to index new team links. The app's own message says "a few minutes", so wait about five minutes after step 2 and, if needed, up to about fifteen minutes (that range is a suggestion, not an Atlassian figure). Then open **Apps → Decision Drift Radar**, choose `KEY` in **Jira project** and select **Scan project**.

You should see, as a live result:

- A **Context from Teamwork Graph** box (no "(sample)"): "Teams linked to KEY: Launch team. Their Confluence spaces: [your space name]. Added 1 decision page from those spaces and 0 linked pages that do not mention KEY."
- A decision, "Status updates go out on Fridays instead of on Mondays.", from **Team decisions**, with the line **Found through Teamwork Graph: a Confluence space of team Launch team, linked to KEY**.
- Under **May affect**, `KEY-1`, with **Outdated wording found** and the reason "The issue still mentions “on Mondays”, which this decision replaces".
- Under **Confluence pages scanned for KEY**, "Team decisions · found through Teamwork Graph: a Confluence space of team Launch team, linked to KEY".

**Not ready yet?** These are the app's own messages, quoted from the current code. Their wording may change.

- No team linked yet, or the link is not indexed yet: there is no **Context from Teamwork Graph** box. An italic line under the scan summary says: "No team linked: Teamwork Graph answered clearly that no Atlassian team is linked to KEY, so no team spaces were searched. Link a team to the project to include its Confluence spaces; a link made in the last few minutes may take a moment to show." Wait a few minutes and scan again. Without Part 3, the scan works as in Part 2 and shows that same line.
- The Graph answered without a usable result: "Teamwork Graph temporarily unavailable: it gave no usable answer about teams linked to KEY after 4 tries, so no team spaces were searched. Scan again in a minute." (The number of tries can be lower if the scan is near its time limit.) Scan again after a minute.

**6. Follow the same finding through to resolution.** Replace only the line from step 4 with `Status updates go out on Fridays.` Save and leave the Radar project page and issue panel closed for about four minutes. Then open the issue panel. If the finding is still shown there, look for **Old wording removed** and **No longer mentions “on Mondays”**, followed by **noticed when the issue was edited**. Because `Status updates go out on Fridays.` contains the decision's replacement ("on Fridays"), it also shows **Replacement wording found**, with "Now mentions “go out on Fridays”, the wording the decision asks for." The project page also shows it, under **Resolved since it was found** if the updated issue no longer matches the decision. If a scan recorded it first, the reason reads **found by a later scan**. This verifies the issue wording. The underlying work may still need to be carried out.

If something in the Teamwork Graph path fails, the scan still completes and the italic line says which step failed, keeping what was found before it. Each quote below is from the current code (`[space name]` is the name of your Confluence space):

- "Launch team has no Confluence space linked in Teamwork Graph, so no team spaces were searched." The team is linked to the project but not to a space. Repeat step 2 for the space. The context box still appears and shows the team.
- "Partial results: found Launch team in Teamwork Graph, but could not read its Confluence spaces (HTTP …), so no team spaces were searched. Scan again in a minute." The Graph space lookup failed. Scan again later.
- "Partial results: Teamwork Graph found [space name], but Confluence could not search it (HTTP 403), so no decision pages were added from team spaces. Scan again in a minute." The team and space were found, but your account cannot search that space, or the app is not installed in Confluence (install step 3).
- "Teamwork Graph temporarily unavailable (HTTP …): the team lookup failed after 3 tries, so no team spaces were searched. Scan again in a minute." The Graph request itself failed. Scan again later. The "(HTTP …)" part appears only when a status code is returned.
- "Partial results: could not read Teamwork Graph links from 1 of 3 decision pages (HTTP …). Scan again in a minute." Links from the other pages were still read. The numbers depend on how many decision pages were checked.
- "Teamwork Graph lookups stopped early to keep the scan within Jira's time limit, so some team pages may be missing (partial results). Scan again to retry." Pages found before the stop are kept.

## Part 4: ask the Rovo agent (optional)

If Rovo is available on your site, the app adds an agent named **Decision Drift Radar**. Rovo is not enabled on every site; a new free developer site may not have it. Atlassian's Codegeist demo sites (`forge site provision`) include it.

1. Open `KEY-1` in Jira and open **Rovo Chat**.
2. In the agent menu at the top of the chat, search for **Decision Drift Radar** and select it.
3. Choose the starter **Which decisions may affect this issue?**

The agent runs the same scan and answers with the decision, its exact quote, a link to your page, the reasons (starting with "The issue still mentions "separate channel plans", which this decision replaces"), and whether a teammate has reviewed it. You can also ask it to scan the project, or to **find more with AI**, which runs the AI pass.

To try a Rovo draft, choose an affected issue without a posted note and ask **“Draft a note for KEY-1 about this decision”**. Rovo asks for confirmation to prepare the draft. Open the issue's **Decision Drift Radar** panel and select **Load Rovo draft**. The panel shows **Rovo draft: exactly what will be posted**. For a decision from a Confluence page this is the same fixed follow-up as in Part 2, without the agent's note, the quote or the page; for a quotable Jira source it is the agent's note with the quote and source. Select **Post Rovo draft to KEY-1** if you want that comment posted. The draft expires after ten minutes. If the issue or source changes after preparation, make a new draft. Preparing and loading the draft leave Jira unchanged.

## If something looks wrong

| What you see | What to do |
| --- | --- |
| "Confluence project-key search unavailable" | The app is not installed into Confluence on this site. Repeat install step 3. |
| "No matching Confluence pages found" | The page must contain the project key as text. Search indexing can also lag by a minute. |
| "No findings detected" | The scan looks for explicit wording such as "Decision:", "we agreed" or "we decided to". Check the page text matches step 1. |
| "No team linked: Teamwork Graph answered clearly that no Atlassian team is linked to KEY…" | Part 3, step 2: link the team to the project and a space, wait a few minutes, then scan again. |
| The decision appears but `KEY-1` has no "still mentions" reason | The issue description must contain the exact phrase "separate channel plans". |
| "You do not have permission to comment" | Your account needs permission to add comments in that project. Nothing was posted. |

## What the app does not do

- It never edits issue fields, statuses or assignees. Its only change to Jira is the comment you confirm in Jira.
- New drift is found only when someone scans a project, opens an issue's panel, or asks the Rovo agent; nothing scans on a schedule. The issue-update trigger acts only after that: when an issue with an open drift has its summary or description edited, it reads that one issue and marks the drift resolved if the replaced wording is gone. It never finds new decisions.
- It copies source text into a Jira comment only when it can show that everyone who can see the issue may read the source: a Jira issue or comment in the same project with no issue security level or comment restriction. A decision from a Confluence page is posted as a fixed follow-up without the quote, title or link.
- It reads the 50 most recently updated issues, up to 20 project-key search pages, up to 10 additional team-space pages and up to 10 linked pages. Results depend on permissions and search/Graph indexing.
- The main scan works on English text with explicit decision wording and uses no AI model, so the same input always gives the same findings. The optional AI pass finds indirectly worded decisions; it keeps a finding only if its quote is found word for word in the source, and a usage counter targets 40 runs per site per day, without an atomic concurrent-request guarantee. Verified AI-pass findings are saved per project, checked again against the current sources on every scan, and shown on the project page, the issue panel and in Rovo; they disappear if their quote is no longer in the source. **Draft with AI** counts towards the same daily limit.

## Verification notes (12–13 November 2026)

Production 3.7.0 was checked on the judge test site on 13 November: a project scan found the Teamwork Graph team link, a decision page in that team's space and two drifts.

Production 3.3.0 was checked on the judge test site on 12 November. The sample scan worked, Teamwork Graph discovered a decision page that omitted the Jira project key, and the reviewed note appeared on the issue. A rescan offered no duplicate note. Rovo was unavailable on that site. Draft preparation and posting from the Jira issue panel were checked on the development demo site. Jira may label project navigation **Space navigation**; use the same Apps entry within that space. Extra existing decision pages can add findings beyond the minimal test example, especially through Teamwork Graph.

The app reserves the finding and issue before posting and can recover a missing receipt from the Jira comment. If a write remains uncertain, check the issue’s comments before retrying.
