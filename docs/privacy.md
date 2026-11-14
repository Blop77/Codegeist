# Privacy policy

Last updated: 13 November 2026

Decision Drift Radar is an Atlassian Forge app made by the Decision Drift Radar team. This policy describes what the app does with data on a site where it is installed.

## Where data is processed

The app runs entirely on Atlassian's Forge platform. It sends no data to servers outside Atlassian, and it uses no external services or analytics.

## What the app reads

When you scan a project or open an issue, the app reads the following, using the permissions of the person signed in:

- Jira: the names and keys of projects you can see, and for the scanned project its recent issues, including summaries, descriptions, statuses, labels and comments.
- Confluence, if the app is installed there: pages whose text mentions the project key.
- Atlassian's Teamwork Graph: the Atlassian teams linked to the scanned Jira project, those teams' Confluence spaces, and pages linked from the decision pages found. The app then reads decision pages in those spaces and the linked pages, as above.

When an issue's summary or description is edited, Jira notifies the app. If the radar is tracking a drift on that issue, the app reads that one issue's summary and description as the app (not as a person), only to check whether the outdated wording is gone. Nothing from that read is shown to anyone or stored, apart from the fact that the drift was resolved by an issue edit, the time it was resolved, and the time of the read (used to order it against scans).

This content is analysed during the scan and returned to your browser. The app does not persist issue or page bodies as Forge storage records. Results are returned to the browser; operational error logs are a separate consideration below.

## The optional AI pass

When a person selects **Find more with AI** (or asks the Rovo agent to find more with AI), the app sends the text of the scanned pages, issue descriptions and comments (up to about 24,000 characters of source text, plus known finding quotes and instructions) to a language model through Forge LLMs, Atlassian's model service for Forge apps. The app calls no other AI service. Source titles sent with the text can include a person's display name (for example "Comment on MC-9 by Priya"). The app sends it only when someone selects the button, never automatically. The prepared text goes to the app's own background job through Forge's event queue, which Atlassian holds until the job runs, and the app does not save the prompt or model reply as Forge storage records. Findings from the AI pass are shown only if their quote is found word for word in the source.

When a person selects **Draft with AI** on a note, the app sends that finding (its quote, source title and reasons) and the affected issue's title and description (up to 4,000 characters) to the same Atlassian-hosted model, and shows the draft for the person to edit. Nothing is posted until they choose to. **Draft with AI** is offered only for sources the app may quote in Jira (see "What the app changes"); for other sources there is no note to draft.

## What the app stores

The app stores a small amount of data in Forge storage for your site:

- For each finding a teammate reviews: the review status ("relevant" or "dismissed"), the time of the review, and a project-scoped hash of the reviewer’s account ID. The app uses the hash on the server to display whether you or a teammate reviewed the finding. It does not return the hash to viewers.
- For each note posted to Jira: the issue key, the comment's id and the time it was posted.
- For the AI pass: a count of runs per day for the site, and the time of the last run per project and per drafted note (keyed by issue key and finding id), used to limit usage. A run that fails before the model gives a usable answer is not counted.
- For each project's latest AI pass: a job record with its state, start and finish times, counts, and the generated ids of the findings it added. It contains no page or issue text.
- For AI-pass findings that passed the word-for-word check: per project, up to 30 entries, each with the source's id, the quoted sentence (one sentence copied from the page, description or comment), and its kind. They are kept so teammates see the same findings later, and are checked again against the current source on every scan. Running the AI pass again replaces older entries beyond the 30 newest.
- When the Rovo agent prepares a note: the note text (or, when the source may not be quoted, only the fixed follow-up), whether the comment quotes the source, a fingerprint of the exact comment, the issue key, the times used to detect later changes, and expiry, stored under a key derived from the requesting account and issue. The draft is available to that teammate for ten minutes. The app checks source access again before showing or posting it. Forge expires the draft record.
- The radar's history, one record per project, kept in a Forge custom entity with a version number so that simultaneous updates don't overwrite each other: when each finding was first seen (by its generated id), and for each issue that still used wording a decision replaced, the issue key, that short phrase (for example "separate channel plans"), when the drift was first seen, when a scan or the issue-update trigger last confirmed or changed its state, and when and how it was resolved. A project's history from before this record existed is copied into it once, and the old record is then deleted. Up to 300 findings and 300 drifts per project; the oldest resolved entries are dropped first. The app shows drift history, and which issues already have a posted note, only for findings and issues returned by the viewer's own scan. Project scans read up to 50 recently updated issues, so older issues can fall outside the project summary.
- When you last opened a project's radar, keyed by a SHA-256 hash of your account ID and the project key (this hides the ID in storage keys, but anyone who knows your account ID could compute it), so findings first seen after your last visit can be labelled new.
- While posting a Jira note: a random attempt ID and timestamp. The app adds the ID as a Jira comment property so it can recover a missing receipt without writing a second comment.

Review, note and AI-usage records are keyed by project key and a generated id for the finding, and contain no account ids, names, email addresses or source text. The saved AI findings and the radar's drift phrases contain short text from your content, and pending agent notes contain the note text and are keyed by a hash of the account ID, as described above.

Atlassian may keep operational logs for Forge apps. The AI error handlers record a failure without including the model response. The radar logs a project key or issue key with counts, retry attempts and error names or codes, never issue or page text. Other operational errors may still include request details.

## What the app changes

The app posts a comment on a Jira issue only when a person marks a finding relevant, previews the exact comment and chooses to post it, or when a person loads a Rovo draft in the Jira issue panel, previews the exact comment and posts it. The comment is posted in that person's name, and the server posts it only if it is still exactly the comment that was previewed. Posting a Rovo draft also records a relevant review if the finding was unreviewed. The app makes no other changes to Jira or Confluence.

A Jira comment can be read by everyone who can see the issue, and that audience can differ from the audience of the decision's source. The app copies source text (the quote, the source title and its link, and any note text) into a comment only when it can show that everyone who can see the issue may read the source: the source is a Jira issue or comment in the same project, with no issue security level and no comment visibility restriction. It checks this on the server with the posting person's access, on every posting path, immediately before posting. In every other case, including every Confluence page, the comment is a fixed follow-up that says a recorded decision may affect the issue and contains no text, title or link from the source and no note text, including text drafted by the AI or the Rovo agent. Reading the source, or a person confirming the comment, is not treated as permission to share it. The "Try with sample data" preview applies the same rule to the bundled sample and never posts.

The "Try with sample data" scan uses fictional data bundled with the app. The baseline sample scan does not read or change Jira or Confluence data. Selecting its optional AI pass processes bundled fictional text and stores AI usage/cooldown records in Forge storage.

## Removing data

A person with Jira permission to add comments or edit issues can clear a shared review with **Undo review**. The same permission is required to mark a finding relevant, dismiss it, or confirm a Rovo draft that can create a shared review. Uninstalling the app removes its access to your site. Atlassian deletes an app's Forge storage for a site after the app is uninstalled, as described in Atlassian's Forge documentation. Comments the app posted remain in Jira and can be deleted there by anyone with permission.

## Changes and contact

If this policy changes, the updated version will be published at this address. For questions, open an issue at https://github.com/Blop77/Codegeist/issues.
