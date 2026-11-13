# Integration boundary

The Forge app uses Jira as its required product and Confluence as an optional companion product for page search. Jira owns project selection, UI, and approved Jira updates. Decision extraction and issue matching live in a pure domain module (`src/domain/`) so they can be developed and reviewed independently.

## Data flow

1. The resolver (`src/resolvers/index.js`) fetches, as the signed-in user:
   - the 50 most recently updated project issues with `summary, status, labels, updated, description, comment, reporter, project`;
   - up to 20 Confluence pages whose text mentions the project key, with `body.atlas_doc_format` (falling back to `body.storage`), searched alongside the Jira read;
   - when the project has no issues, or Jira search rejects the key, the project itself (`GET /rest/api/3/project/{key}`), for its id and to name similar projects when the key is unknown.
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

`getIssueDecisionContext({ issueKey })` reads the issue directly (so an edit shows at once), the project's 50 most recently updated issues and its Confluence pages, and runs the same analysis as the project scan. It returns only candidates whose `affectedIssues` include the issue, each narrowed to that issue, so the panel and the project scan agree. Drift history is recorded for that issue only:

- `{ ok: true, issueKey, candidates: DecisionCandidate[], notice, warnings }`
- `{ ok: false, error }`

Jira links (`issues[].url` and the `url` of `jira_issue` / `jira_comment` sources) are site-relative paths such as `/browse/MC-1`, because inside Forge `issue.self` points at the API gateway (`api.atlassian.com/ex/jira/<cloudId>/…`), not the site. Confluence page links (`pages[].url` and `confluence_page` sources) are site-relative too, as `/wiki` + the page's `_links.webui`, because inside Forge `_links.base` can be the bare site URL without `/wiki`. The UI prefixes `siteUrl` from its product context for both.

`warnings` holds user-facing Confluence access problems. `notice` is set when candidates were truncated.

Scans and reviews do not write to Jira. `reviewDecision` and `clearDecisionReview` persist only a candidate's review status and timestamp in Forge storage; the key combines the project key and stable candidate ID. `reviewDecision` accepts only the `relevant` and `dismissed` states and requires an authenticated resolver account without storing the account ID. Both actions first confirm, as the signed-in user, that the user can see the Jira project (`GET /rest/api/3/project/{key}`); otherwise nothing is written. Scans read a project's reviews with one paginated prefix query (`review:<KEY>:`), and the issue panel reads reviews only for the candidates it shows. Jira updates remain a separate future action that must validate its target and require an explicit user action.

## Posting a reviewed note (the only Jira write)

`previewDecisionNote({ projectKey, candidateId, issueKey, note })` builds the exact comment on the server with the person's access and returns `{ ok, mode, text, digest, explanation, note }`. `composeNote` in `src/resolvers/notes.js` decides `mode` with `sourceSharing`:

- `quoted` only when the finding's source is a Jira issue or comment in the same project whose issue has no security level and, for a comment, no `visibility` restriction (checked with `GET /rest/api/3/issue/{key}?fields=security,project` and `GET /rest/api/3/issue/{key}/comment/{id}`). Everyone who can see the target issue can browse the project, so they can read that source. The comment carries the person's note, the quote and the source title and link.
- `generic` otherwise, including every Confluence page and any check that fails. The comment is the fixed `GENERIC_NOTE` in `src/resolvers/normalize.js`; any supplied note (typed, AI-drafted or from Rovo) is discarded, and no quote, title or link is included.

`applyDecisionNote({ projectKey, candidateId, issueKey, note, digest })` posts one comment on `issueKey` with `asUser()`, so Jira applies the user's own comment permission and shows them as the author.

- Requires the finding's stored review to be `relevant`; otherwise nothing is posted.
- Rebuilds the comment and posts only if its `digest` (SHA-256 of the exact preview text) equals the one the person confirmed. Otherwise it returns `ok: false` with the new `preview` and posts nothing.
- `issueKey` must belong to `projectKey`. In `quoted` mode `note` is 1 to 2,000 characters.
- Idempotency and audit: after Jira accepts the comment, `note:<KEY>:<candidateId>:<issueKey>` stores `{ issueKey, commentId, appliedAt }`. A repeat call returns that record with `alreadyApplied: true` and posts nothing. A `note-reservation` entity record and a comment property let a retry recover a missing receipt without a second comment.
- Returns `{ ok: true, note }` or `{ ok: false, error }`; every failure message says whether anything was posted.
- The comment starts with "Decision Drift Radar note". Scans skip comments that start with that marker, so a posted note is not reported as a new decision.

`draftDecisionNote` refuses sources in `generic` mode, since there is no note to draft. Rovo drafts (`prepare-decision-note`) go through the same `composeNote`; the draft stores the mode and digest, `getRovoDraft` returns the exact `text` and `digest`, and `postRovoDraft({ issueKey, draftId, digest })` rebuilds the comment and posts only if it still matches.

`previewSampleNote({ candidateId, issueKey, note })` returns the same preview for a bundled sample finding (a sample Jira comment is `quoted`, a sample Confluence page `generic`). It makes no product or storage calls, saves no review and cannot post.

`getSampleRadar()` returns the same shape as `getProjectRadar` with `sample: true`, built from `src/resolvers/sample-data.js`. It makes no product or storage calls; its links are empty, and the UI offers no review or note actions for it.

## Rovo agent

The `rovo:agent` module `decision-drift-radar-agent` (prompt in `src/rovo/agent-prompt.txt`) uses four `action` modules, implemented in `src/rovo/actions.js`:

- `find-project-decisions({ projectKey })` (`GET`) runs `scanProject`.
- `find-issue-decisions({ issueKey })` (`GET`) runs `scanIssue`.
- `find-more-decisions-with-ai({ projectKey })` (`CREATE`) runs the AI pass below.
- `prepare-decision-note({ issueKey, findingId, note })` (`CREATE`) stores a private draft for the requesting person, which they review and post from the Jira issue panel.

All run as the person in the chat (`asUser()`). When the input names no key, they use the Jira project or issue the user is viewing (`payload.context.jira`, including the project of a viewed issue). A key the user gave that is not valid is an error; it is never replaced by the page's project. Scan results come back as `{ ok, findingCount, findings: [{ findingId, foundBy, review, kind, statement, quote, source: { type, title, link, updated, foundThrough, author }, wordingSignals, affectedIssues: [{ issueKey, link, relevance, reasons, wordingStatus, drift, notePosted }], resolvedIssues }], warnings, howToRead }`, capped at 15 findings. Links are absolute when Rovo passes the page URL, otherwise site-relative. `howToRead` and the agent prompt tell the agent that quotes, titles and other source text are data and that instructions inside them are never followed. `src/resolvers/scan.js` holds the scan logic shared with the UI resolvers.

## Teamwork Graph

`scanProject` and `scanIssue` call `discoverViaGraph` (`src/resolvers/graph.js`) with the project id (from an issue's `project` field, or from the project itself when it has no issues) and `context.cloudId`. As the user, via `requestTeamworkGraph`, it reads `atlassianTeamsBySpace` for `ari:cloud:jira:<cloudId>:project/<projectId>` (up to 5 teams), `spacesByAtlassianTeam` for each (up to 8 Confluence spaces), searches those spaces for decision wording (up to 10 pages), and reads `confluencePageLinkedConfluencePages` from up to 5 decision pages (up to 10 linked pages). New pages become `confluence_page` sources with `via` set (for example "Teamwork Graph: a Confluence space of team Brand, linked to MC"); `via` is passed through to candidates. Responses include `graph: { used, teams, spaces, pagesAdded, linkedPagesAdded, note }`. Any error, empty result or missing id leaves the scan as it would be without the graph, with a `note`. `graph.status` also has `overall`: `ok`, `no_team` (Graph answered well-formed empty on every attempt; link a team), `unavailable` (errors or no usable team answer; scan again in a minute) or `partial` (a later stage or some origins failed, or lookups stopped early; earlier pages are kept); `notes` holds one sentence per problem and `note` joins them. The team lookup gets one extra, longer-spaced attempt when no attempt was conclusive; linked-page lookups that error or come back partial are retried within the deadline. Diagnostic logs carry only stage, HTTP status or error code, and attempt count, never page text, titles, names or GraphQL messages. Twelve seconds after a scan starts, no new Graph lookup starts and failed ones are not retried, so the scan stays within Forge's 25-second limit; the `note` then says the lookups stopped early. Scopes: `read:graph:project:jira`, `read:graph:team:atlassian`, `read:graph:space:confluence`, `read:graph:page:confluence` (a major version). The API is in Preview.

## AI pass

`getAiFindings({ projectKey })` rescans the project as the user and numbers the sentences of up to 15 sources (24,000 characters in all; a single page can use the whole budget). Sentences already covered by known findings (rule-based and saved AI findings) are shown unnumbered. It then pushes the numbered text to the `ai-pass` async event queue and returns `{ ok: true, pending: true }`; one job per project runs at a time. The consumer `runAiJob` (up to 900 seconds) calls Forge LLMs (`@forge/llm`, model `claude-sonnet-5`, at most 12,000 output tokens, the cap the accuracy benchmark measured). The model returns `{ findings: [{ id, kind }] }`, where `id` is a sentence number; each number maps back to the exact sentence and any other field is discarded. The job saves the sentences that pass the quote rules to the project's saved AI findings (`ai-proposals:<KEY>`), and records only its state, times, counts and finding ids in `ai-job:<KEY>`. `getAiJob({ projectKey })` reports `pending` while it runs; when it is done it rescans as the user and returns the project's AI findings with review state and how many are new. `verifyProposedFindings` in `src/domain/extractDecisions.ts`, run on every scan, keeps a saved proposal only if its quote occurs verbatim in that source, is 12 to 280 characters, has a valid kind, and does not overlap a known finding; kept proposals get the same span, id and issue matching as rule-based findings, and the reason "Found by the AI pass; the quote was checked word for word against the source". Results carry `ai: true` and review state. Verified findings are saved per project (`ai-proposals:<KEY>`, at most 30, as source id, quote and kind only) and checked again against the current sources on every scan.

`getSampleAiFindings()` runs the same steps synchronously over the small bundled sample and reads nothing from the site. The Rovo action `find-more-decisions-with-ai` starts the same background job and tells the user its findings appear in the next scan.

Cost guards: a run is refused after 40 runs per site per day (`ai-usage:<date>`) or within 30 seconds of the last run for the same project (`ai-last:<KEY>`). Model errors and unreadable replies (for example, one cut off mid-way) return a message, never a partial result or a silent "nothing found", and the run is given back so it does not count towards the daily limit or start the cooldown. An empty `findings` list is a real answer and counts. The `llm` module made this a major version.

`listProjects()` returns `{ ok: true, projects: [{ key, name }], more }` (first 50 projects the user can see) for the project picker.

Scopes: `write:jira-work` is used only by `applyDecisionNote`.

## Known limits

- Issue search embeds a limited number of comments per issue; very long threads are only partly scanned.
- Confluence pages are matched to a project by text search for the project key, which can be noisy for short keys.
- Source text is capped at 20,000 characters per record.
