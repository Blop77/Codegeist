# Privacy policy

Last updated: 12 November 2026

Decision Drift Radar is an Atlassian Forge app made by the Decision Drift Radar team. This policy describes what the app does with data on a site where it is installed.

## Where data is processed

The app runs entirely on Atlassian's Forge platform. It sends no data to servers outside Atlassian, and it uses no external services or analytics.

## What the app reads

When you scan a project or open an issue, the app reads the following, using the permissions of the person signed in:

- Jira: the names and keys of projects you can see, and for the scanned project its recent issues, including summaries, descriptions, statuses, labels and comments.
- Confluence, if the app is installed there: pages whose text mentions the project key.

This content is analysed during the scan and returned to your browser. The app does not keep copies of issue or page content after a scan.

## The optional AI pass

When a person selects **Find more with AI**, the app sends the text of the scanned pages, issue descriptions and comments (up to about 24,000 characters) to a language model hosted by Atlassian through Forge LLMs. Atlassian runs the model; the text does not go to an outside AI provider. The app sends it only when someone selects the button, never automatically, and keeps no copy of the text or of the model's reply. Findings from the AI pass are shown only if their quote is found word for word in the source.

## What the app stores

The app stores a small amount of data in Forge storage for your site:

- For each finding a teammate reviews: the review status ("relevant" or "dismissed") and the time of the review.
- For each note posted to Jira: the issue key, the comment's id and the time it was posted.
- For the AI pass: a count of runs per day and the time of the last run per project, used to limit usage.

These records are keyed by project key and a generated id for the finding. The app does not store Atlassian account ids, names, email addresses, or the text of issues, pages or comments.

Atlassian may keep operational logs for Forge apps. The app's own log messages contain no issue or page content.

## What the app changes

The app posts a comment on a Jira issue only when a person marks a finding relevant, reviews the note and chooses to post it. The comment is posted in that person's name. The app makes no other changes to Jira or Confluence.

The "Try with sample data" scan uses fictional data bundled with the app. It reads and writes nothing on your site.

## Removing data

A reviewer can clear a review with **Undo review**. Uninstalling the app removes its access to your site. Atlassian deletes an app's Forge storage for a site after the app is uninstalled, as described in Atlassian's Forge documentation. Comments the app posted remain in Jira and can be deleted there by anyone with permission.

## Changes and contact

If this policy changes, the updated version will be published at this address. For questions, open an issue at https://github.com/Blop77/Codegeist/issues.
