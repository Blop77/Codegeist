# Integration boundary

The Forge app uses Jira as its required product and Confluence as an optional companion product for page search. Jira owns project selection, UI, and approved Jira updates. Decision extraction and issue matching live in a pure domain module (`src/domain/`) so they can be developed and reviewed independently.

## Data flow

1. The resolver (`src/resolvers/index.js`) fetches, as the signed-in user:
   - up to 25 project issues with `summary, status, labels, updated, description, comment, reporter`;
   - up to 10 Confluence pages whose text mentions the project key, with `body.atlas_doc_format` (falling back to `body.storage`).
2. `src/resolvers/normalize.js` turns those payloads into the domain records in `src/domain/decisionTypes.ts`:
   - each issue becomes an `IssueRecord` (description converted from ADF to plain text);
   - each issue description and each comment becomes a `jira_issue` / `jira_comment` `SourceRecord`; comment URLs use `/browse/KEY?focusedCommentId=ID`, which the matcher uses to find the parent issue;
   - each page becomes a `confluence_page` `SourceRecord` whose `projectKey` is the scanned project key.
   Text follows the conventions in `src/domain/README.md`: `## ` headings, `- ` list items, and Confluence decision items as `Decision: …` (DECIDED) or `Open question: …` (UNDECIDED).
3. `extractDecisions({ sources, issues, maxCandidates: 50 })` returns ranked candidates. Records it skips are logged with `console.warn`; they are not shown to users.

## Resolver responses

`getProjectRadar({ projectKey })`:

- `{ ok: true, projectKey, issues: [{ key, summary, status, labels, url, updated }], pages: [{ id, title, url }], candidates: DecisionCandidate[], notice: string | null, warnings: string[] }`
- `{ ok: false, error }`

`getIssueDecisionContext({ issueKey })` scans that issue's description and comments plus the project's Confluence pages, and returns only candidates whose `affectedIssues` include the issue:

- `{ ok: true, issueKey, candidates: DecisionCandidate[], notice, warnings }`
- `{ ok: false, error }`

Jira links (`issues[].url` and the `url` of `jira_issue` / `jira_comment` sources) are site-relative paths such as `/browse/MC-1`, because inside Forge `issue.self` points at the API gateway (`api.atlassian.com/ex/jira/<cloudId>/…`), not the site. The UI prefixes `siteUrl` from its product context. Confluence links are absolute, built from the page's `_links.base`.

`warnings` holds user-facing Confluence access problems. `notice` is set when candidates were truncated.

The resolver does not write to Jira. `reviewDecision` and `clearDecisionReview` persist only a candidate's review status and timestamp in Forge storage; the key combines the project key and stable candidate ID. `reviewDecision` accepts only the `relevant` and `dismissed` states and requires an authenticated resolver account without storing the account ID. Both actions first confirm, as the signed-in user, that the user can see the Jira project (`GET /rest/api/3/project/{key}`); otherwise nothing is written. Scans read a project's reviews with one paginated prefix query (`review:<KEY>:`), and the issue panel reads reviews only for the candidates it shows. Jira updates remain a separate future action that must validate its target and require an explicit user action.

## Known limits

- Issue search embeds a limited number of comments per issue; very long threads are only partly scanned.
- Confluence pages are matched to a project by text search for the project key, which can be noisy for short keys.
- Source text is capped at 20,000 characters per record.
