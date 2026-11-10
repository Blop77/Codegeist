# Decision Drift Engine

The extraction and matching module for **Decision Drift Radar**. It takes normalized
Jira and Confluence records and returns decision candidates. Each candidate comes with a
source citation, the Jira issues it affects, why each issue matched, and whether that
issue still reflects the old plan.

It is a pure function of its input: no network calls, no storage, no Jira writes. The
Forge resolver fetches data, stores review state and applies actions; this module only
analyses data.

## Run it

Needs Node 22.18 or later (TypeScript runs directly, no build step).

```bash
npm test             # 27 tests
npm run demo         # the seeded PAY demo, human readable
npm run demo:json    # the same as JSON, exactly what the UI would receive
npm run typecheck    # needs `npm install` first
```

## Use it

```ts
import { analyzeDecisions, confluenceAdfToBlocks, adfToPlainText } from './decision-engine/src/index.ts';

const { candidates, diagnostics } = await analyzeDecisions({
  projectKey: 'PAY',
  issues,            // JiraIssueRecord[]
  sources,           // (ConfluencePageRecord | JiraCommentRecord)[]
  since: '2026-10-01T00:00:00Z',   // optional time window
  options: { minMatchStrength: 'moderate', hideReflected: false },
});
```

Building the records in the resolver:

| Record | Fetch with | Convert |
| --- | --- | --- |
| `JiraIssueRecord` | Jira REST v3 search, fields `summary,description,status,labels,components,updated,flagged` plus remote links | `description` ← `adfToPlainText(fields.description)` |
| `JiraCommentRecord` | `/rest/api/3/issue/{key}/comment` | `body` ← `adfToPlainText(comment.body)` |
| `ConfluencePageRecord` | Confluence v2 `/pages/{id}?body-format=atlas_doc_format` | `blocks` ← `confluenceAdfToBlocks(JSON.parse(body.atlas_doc_format.value))` |

Request ADF rather than storage format: Confluence decision items (`decisionItem` with
`DECIDED` / `UNDECIDED`) are the most reliable decision signal, and the ADF converter keeps them.

## The contract (proposal for shared contracts 2 and 3 in the brief)

All types are in [`src/types.ts`](src/types.ts). The parts the UI and storage depend on:

- **`DecisionCandidate.id`** is a stable hash of project, source and passage. Key review
  state on it so a dismissed or snoozed candidate doesn't come back as new.
- **`kind`**: `explicit` (stated as decided), `possible` (a proposal) or `unresolved`
  (an open question). This is how the UI separates a decision from a discussion.
- **`confidence`** is `high | medium | low` plus `confidenceReasons`. It is a label, not a
  probability. `high` needs deterministic evidence; a model review alone tops out at `medium`.
- **`evidenceExcerpt` + `evidenceSpan`**: the exact passage, with offsets into the
  block (`blockId`) or comment body. `body.slice(start, end) === evidenceExcerpt` is tested.
- **`affectedIssues[]`**: each has `strength`, `reasons[]` (why it matched) and
  `drift` + `driftReasons[]`:
  - `stale-reference`: the issue still names what the decision replaced or removed
  - `not-reflected`: no sign the issue was updated
  - `possibly-reflected`: the issue links the source or names the new direction
- **`change`**: `{ from, to }` or `{ removed }` when the wording makes it clear. Useful
  for the suggested note ("Replaces *legacy card form* with *Stripe Payment Element*").
- **`priority`**: a `tier` plus `signals[]` with labels. Show the labels, not the weights.
- **`alsoSeenIn`**: the same decision stated elsewhere, merged into one candidate.

Fields from the brief's candidate model that are **not** here, on purpose: `state`,
`createdAt`, `updatedAt`. Those belong to the storage layer.

## How it decides

1. **Extract.** Each sentence is classified by rules: Confluence decision items,
   "Decision:" / "Agreed:" labels, "we decided/agreed", statements under a Decisions
   heading, proposals ("we should"), and open questions ("TBD", "have not decided"). Sentences
   about the page itself ("this page records what we agreed") are skipped.
2. **Dedupe.** The same decision on two pages becomes one candidate with both sources.
3. **Model review (optional).** See below.
4. **Match.** Each decision is compared with each issue in scope: the decision came from
   the issue's own comments, the passage names the issue key, shared rare terms (weighted
   by how few issues use them), the issue links the page, or the issue names a distinctive
   term the decision replaces. A page-level link alone counts as weak, so one decision log
   doesn't tie every decision on it to one issue.
5. **Drift.** Each matched issue's summary and description are checked for the old term,
   the new term and a source link, and its later comments are checked too.
6. **Rank.** Visible signals: decision vs proposal, Confluence decision item, decision
   record, recency, stale references, match strength, blocked or in-progress work.

## Optional model review

`analyzeDecisions(input, { model })` accepts anything that implements `DecisionModel`
([`src/llm.ts`](src/llm.ts)). That could be Rovo, an approved LLM endpoint, or nothing.
The engine never calls a vendor itself. Guards, all tested:

- The model must quote evidence word for word from the source; otherwise its output is
  thrown away (`rejectedUnverifiedEvidence`).
- It may reclassify or drop a candidate; every drop is reported with its rationale.
- Errors and timeouts fall back to the deterministic result.
- Only uncertain candidates are sent by default, capped at 20 calls per run.

## Demo data

[`fixtures/demo-scenario.ts`](fixtures/demo-scenario.ts) is a checkout-redesign story
with four seeded drifts, each with a different reason:

| Decision | Source | Drifted issue | Why |
| --- | --- | --- | --- |
| Stripe Payment Element replaces the legacy card form | Confluence decision item | PAY-101 (in progress) | Still says "legacy card form" |
| Guest checkout is out of scope for v1 | Decision log + meeting notes (merged) | PAY-102 | Still describes guest checkout |
| Confirmation email moves from SendGrid to Postmark | "Agreed:" in meeting notes | PAY-103 (blocked) | Still says SendGrid |
| Cap webhook retries at 3, not 5 | Jira comment on PAY-107 | PAY-107 | Description still says 5 |

It also includes an issue that already reflects its decision (PAY-104), unrelated work,
a done issue, two open questions, a proposal, and another project's data that must be ignored.

## Known limitations

- **English only, rule based.** Unusual phrasing ("let's lock that in") is missed unless a
  model is plugged in. Decisions in tables, images or attachments are not read.
- **Change detection is pattern based.** It handles "X instead of Y", "replace X with Y",
  "from X to Y", "drop X" and "X is out of scope". Bare numbers work only when the issue is
  matched another way (as with the retry example).
- **Term matching is lexical.** Synonyms ("sign-in" vs "login") don't match. Very short
  issues give little to match on.
- **Issue descriptions are targets, not sources.** Decisions written in a description are
  not extracted, only those in comments and Confluence.
- **No reversal tracking.** A later decision that overturns an earlier one shows as two
  candidates; nothing yet marks the first as superseded.
- **Scale.** Matching is decisions × issues. That's fine for one project and a time window
  (the intended scope); a whole site would need pre-filtering in the resolver.
- **Forge bundling is unverified.** Imports use `.ts` extensions (Node's type stripping
  needs them). Check this on the first `forge deploy`; if the bundler objects, switch on
  `rewriteRelativeImportExtensions` or drop the extensions. `node:crypto` is used for ids.

## Files

```
src/types.ts      contracts (input records, candidates, options)
src/engine.ts     analyzeDecisions: window, dedupe, model review, match, rank
src/extract.ts    sentence classification and evidence spans
src/change.ts     old/new/removed term extraction
src/match.ts      issue matching and drift assessment
src/rank.ts       priority signals and tiers
src/llm.ts        optional model review with evidence verification
src/adf.ts        ADF → blocks / plain text
src/text.ts       sentence splitting, tokens, phrase search
fixtures/         demo scenario
test/             node:test suites
scripts/demo.ts   prints the radar for the demo data
```
