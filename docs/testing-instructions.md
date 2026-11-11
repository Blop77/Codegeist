# Testing instructions

How to install Decision Drift Radar on your own Atlassian site and see it working. Part 1 needs no setup. Part 2 uses your own Jira and Confluence data and takes about five minutes.

## What you need

- An Atlassian cloud site with **Jira** and **Confluence**, where you are a site admin.
- The installation link from the submission.

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
| `write:jira-work` | Post one comment on an issue, only when you review a note and select **Post comment**. |

The app calls no external services. All data stays in Atlassian.

## Part 1: see it in one minute (no setup)

1. In Jira, open **Apps → Decision Drift Radar**.
2. Select **Try with sample data**.

This runs the real analysis on a small fictional project bundled with the app. It reads and writes nothing on your site. You should see four decisions, two open questions and one proposal. Each finding shows the quoted evidence, the wording signals, and the issues it may affect with the reasons, for example:

> **PAY-103 · relevance 0.85**
> • Shares terms with the issue: "confirmation", "mail", "old", "relay"
> • The issue still mentions "old mail relay", which this decision replaces

Sample findings have no links, and cannot be reviewed or posted. Part 2 covers those.

## Part 2: your own data (about five minutes)

Use any Jira project that has at least one issue. Below, `KEY` is that project's key (for example `KAN`), and `KEY-1` is one of its issues.

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
  - The same paragraph as the decision lists KEY-1
  - The issue still mentions "separate channel plans", which this decision replaces
- **Open questions · 1**: "Do we need a second approver for the launch checklist?"

**4. Review it.** Select **Mark relevant**. The review is saved for the project; **Undo review** clears it. Nothing in Jira changes yet.

**5. Post a note.** Under `KEY-1`, select **Add note to KEY-1**. Edit the suggested note if you like, then select **Post comment to KEY-1**. The card shows "Note added to KEY-1" with a **View comment** link. The comment on the issue is in your name and contains the note, the quoted decision and a link to the page.

**6. Check the safeguards.**

- Scan again: there is still one decision. The app's own comment is not read as a new decision, and `KEY-1` no longer offers to post the note.
- Open `KEY-1`: the **Decision Drift Radar** panel on the issue shows the same decision, its review and the posted note.
- Open the project and choose **Decision Drift Radar** in its navigation: the app scans that project without asking for a key.

## Part 3: ask the Rovo agent (optional)

If Rovo is available on your site, the app adds an agent named **Decision Drift Radar**.

1. Open `KEY-1` in Jira and open **Rovo Chat**.
2. In the agent menu at the top of the chat, search for **Decision Drift Radar** and select it.
3. Choose the starter **Which decisions may affect this issue?**

The agent runs the same scan and answers with the decision, its exact quote, a link to your page, and the reasons, starting with "The issue still mentions "separate channel plans", which this decision replaces". You can also ask it to scan the project. The agent only reads; to review a finding or post a note it sends you back to the app.

## If something looks wrong

| What you see | What to do |
| --- | --- |
| "Confluence source search unavailable" | The app is not installed into Confluence on this site. Repeat install step 3. |
| "No matching Confluence pages found" | The page must contain the project key as text. Search indexing can also lag by a minute. |
| "No decisions detected" | The scan looks for explicit wording such as "Decision:", "we agreed" or "we decided to". Check the page text matches step 1. |
| The decision appears but `KEY-1` has no "still mentions" reason | The issue description must contain the exact phrase "separate channel plans". |
| "You do not have permission to comment" | Your account needs permission to add comments in that project. Nothing was posted. |

## What the app does not do

- It never edits issue fields, statuses or assignees. Its only change to Jira is the comment you confirm.
- It reads the 25 most recently updated issues in a project and up to 10 pages per scan.
- It works on English text with explicit decision wording. It does not use an AI model, so the same input always gives the same findings.
