# Decision extraction and issue matching (domain module)

Finds decisions, proposals and open questions in Confluence and Jira text, and ties each
to the Jira issues in the same project that it concretely points at. Every result cites
an exact quote, and every issue match lists the signals behind it.

```ts
import { extractDecisions } from './domain/extractDecisions';

const { candidates, warnings } = extractDecisions({ sources, issues, maxCandidates: 50 });
```

`extractDecisions` is pure and synchronous: no network, no clock, no randomness, no shared
state, no runtime dependencies. The same input always gives the same output. It does not
fetch, store, or write anything.

## Files

| File | Purpose |
| --- | --- |
| `decisionTypes.ts` | The shared contract: input records, candidates, warnings, the optional classifier hook |
| `extractDecisions.ts` | Validation, sentence splitting, classification, evidence spans, deduplication, ranking |
| `matchIssues.ts` | Same-project issue matching: issue-key signals, weighted term overlap, replaced-term checks |
| `fixtures/demoInput.ts` | The demo story, covering every behaviour in the spec (listed at the top of the file) |
| `fixtures/edgeCases.ts` | Malformed records, duplicate ids, bad timestamps, an over-long sentence, empty input |
| `fixtures/expectedDemoOutput.json` | The exact output for the demo input (golden file) |
| `fixtures/mcDemoInput.ts` | The live demo-site page, the 25 MC issue titles and MC-9's drifted description (see `docs/demo.md`) |
| `fixtures/checkFixtures.ts` | 25 checks against the fixtures; `--update` regenerates the golden file |

## Run the checks

The Forge app does not depend on a TypeScript runtime. Fetch `tsx` temporarily to run the fixture checks:

```bash
npx --yes tsx src/domain/fixtures/checkFixtures.ts
```

The domain module has no runtime dependencies. Only `checkFixtures.ts` uses `node:assert` and
`node:fs`, and nothing imports it into the Forge app.

## Example

Input (from `fixtures/demoInput.ts`): a Jira comment on PAY-107, and the PAY-107 issue.

```ts
extractDecisions({
  sources: [{
    id: 'comment-20001', type: 'jira_comment', title: 'Comment on PAY-107',
    url: 'https://demo-team.atlassian.net/browse/PAY-107?focusedCommentId=20001',
    projectKey: 'PAY', updatedAt: '2026-11-07T15:30:00Z', author: 'Tom (Eng)',
    text: 'Decided in standup: we will cap retries at 3 instead of 5. Anything beyond that goes to the dead letter queue.',
  }],
  issues: [{
    id: '10107', key: 'PAY-107', title: 'Retry failed payment webhooks', projectKey: 'PAY',
    description: 'Retry failed webhook deliveries up to 5 times with exponential backoff.',
    updatedAt: '2026-10-25T09:00:00Z',
  }],
});
```

Output (one candidate; the second sentence is ordinary discussion and is not extracted):

```json
{
  "candidates": [{
    "id": "dc_…",
    "kind": "decision",
    "summary": "We will cap retries at 3 instead of 5.",
    "evidence": { "quote": "Decided in standup: we will cap retries at 3 instead of 5.", "start": 0, "end": 58 },
    "source": { "id": "comment-20001", "type": "jira_comment", "title": "Comment on PAY-107", "url": "…", "projectKey": "PAY", "updatedAt": "2026-11-07T15:30:00Z", "author": "Tom (Eng)" },
    "confidence": 0.85,
    "confidenceReasons": ["Starts with an \"Agreed:\" or \"Decided:\" label"],
    "affectedIssues": [{
      "issueKey": "PAY-107",
      "relevance": 0.75,
      "reasons": ["The decision is in a comment on PAY-107", "The issue still mentions “5”, which this decision replaces"]
    }]
  }],
  "warnings": []
}
```

The full demo output is in `fixtures/expectedDemoOutput.json`. In short:

| Kind | Summary | Affected issues |
| --- | --- | --- |
| decision | Use Stripe Payment Element instead of the legacy card form | PAY-101 (still says "legacy card form"), PAY-104 |
| decision | Guest checkout is out of scope for v1 | PAY-102 (still describes guest checkout) |
| decision | Move the confirmation email from SendGrid to Postmark (stated twice, merged) | PAY-103 (still says SendGrid) |
| decision | Track checkout events with Segment instead of Google Analytics | PAY-108 (its own description), PAY-109 (still says Google Analytics) |
| decision | Cap retries at 3 instead of 5 | PAY-107 (its own comment) |
| decision | PAY-106 ships in the 2.3 release | PAY-106 (named in the quote) |
| decision | Rotate staging certificates monthly (OPS source) | OPS-9 |
| decision | OPS-9 certificate rotation is handled by the platform team (PAY source) | none: OPS-9 is in another project |
| open_question | Do we support Apple Pay at launch? | none |
| open_question | We have not decided whether refunds need a second approver | none |
| proposal | We should probably add rate limiting to the payments API | none |

## How it works

**Text layout.** Text is read line by line. Markdown headings (`## Decisions`), bare
heading lines ("Decisions", "Action items") and short `Label:` lines start a section.
List markers (`-`, `*`, `1.`, `[ ]`) are skipped so they never appear in quotes. Each line
is split into sentences with exact UTF-16 offsets.

**Classification** (first match wins):

| Kind | Signals | Confidence |
| --- | --- | --- |
| open_question | "Open question:" / "TBD:" label | 0.80 |
| open_question | "not decided", "TBD", "to be confirmed", "pending decision" | 0.70 |
| decision | "Decision:" / "Agreed:" / "Decided …:" label | 0.85 |
| decision | "we decided/agreed", "decided to", "final call" | 0.80 |
| decision | "we're going with" | 0.65 |
| decision | "approved" as a verb or label ("was approved by", "leadership approved the", "Approved:"), "signed off", "going forward" | 0.60 |
| open_question | a question with "should we", "do we", "which", "whether" | 0.60 |
| proposal | "we should", "let's", "propose", "probably", "leaning towards" | 0.60 |
| decision | a 4+ word statement under a Decisions heading, with no other signal | 0.60 |

Adjustments: +0.05 under a Decisions heading, +0.05 when the source title reads like a
decision record (decision, ADR, RFC, spec), +0.05 when stated more than once in the source.
Confidence is capped at 0.95, because these are wording heuristics, not certainty.
Sentences about the document itself ("this page records what we agreed") are skipped, and so
are disclaimers ("This is a sample decision, not an approved team decision", "not a final
decision", "for illustration only"). Negated approvals ("not yet approved", "no one has signed
off") and adjective uses ("approved vendors") never count as approval; "never decided" is an
open question.

**Deduplication.** Within one source, the same statement (identical text, or the same kind
with 80%+ shared terms) becomes one candidate. The clearest wording is kept, with a
"Stated N times in this source" reason.

**Issue matching** happens only within the source's `projectKey`. An issue is included only
when at least one of these holds, and each one that holds becomes a reason:

| Signal | Relevance added |
| --- | --- |
| The quote names the issue key | 0.60 |
| Otherwise, the same paragraph or list item lists the key ("… Related Jira issues: MC-1, MC-5.") | 0.50 |
| The source is the issue itself, or a comment on it (from the `/browse/KEY` URL or a matching id) | 0.55 |
| Shared terms: rarer words weigh more; needs 2+ shared terms and 36%+ of the decision's term weight to count on its own | up to 0.80 × overlap |
| The issue still names what the decision replaces or removes ("X instead of Y", "replace X with Y", "from X to Y", "drop X", "X is out of scope") | 0.20 |
| The source also mentions the key elsewhere (only alongside shared terms) | 0.15 |

Relevance is the sum, capped at 0.99. Issue keys from other projects are ignored.

**Ranking.** Decisions first, then open questions, then proposals. Within each kind:
candidates with affected issues first, then by confidence, top relevance, source recency
and position. Malformed timestamps rank as oldest. `maxCandidates` applies after ranking.

**Warnings** (never exceptions): `invalid_input`, `empty_input`, `invalid_source`,
`invalid_issue`, `duplicate_source`, `duplicate_issue` (the first record wins),
`invalid_timestamp` (the record is kept, the original string is passed through),
`invalid_option`, `candidates_truncated`.

## Optional classifier (future model path)

`extractDecisions(input, { classifier })` swaps the built-in sentence rules for any
**pure, synchronous** function. `defaultClassifier` is exported so a custom one can fall
back to it. A classifier that throws skips that sentence. There is no LLM dependency. A
model-backed step, which would be asynchronous, belongs outside this module, for example
re-ranking or filtering candidates after `extractDecisions` returns, so this function stays
deterministic.

## Assumptions

- **No existing stack to match.** The repo had only a README, so this is plain TypeScript
  (ES2022, strict) with extensionless relative imports, the usual convention for bundlers
  such as Forge's. It compiles cleanly under `--strict --noUnusedLocals`.
- **`text` is plain text** produced by the resolver. The rules work best if the resolver
  renders Confluence headings as `## Heading`, list items as `- item`, and Confluence
  decision items as `Decision: …` (DECIDED) or `Open question: …` (UNDECIDED). That keeps
  the strongest signal, Confluence's own decision marker, which plain text would otherwise lose.
- **`projectKey` on a Confluence source is a Jira project key**, not the Confluence space
  key. The resolver decides which project a page belongs to.
- **A comment's parent issue comes from its URL** (`/browse/PAY-107?...`), because the
  contract has no parent-issue field.
- **Deduplication is per source**, as specified. The same decision stated on two pages gives
  two candidates.

## Limitations

- English only and rules based. Unusual phrasing ("let's lock that in") is missed, and
  sarcasm or hypotheticals can be misread.
- Term matching is lexical: no synonyms ("sign-in" vs "login"). Very short issues give
  little to match on.
- Replaced-term detection covers the listed patterns only. A bare number ("5") counts only
  when the issue is already tied to the decision some other way.
- No reversal tracking: a later decision that overturns an earlier one shows as a separate
  candidate.
- Heading detection in plain text is heuristic. A short line ending in ":" starts a section.
- Long sentences are cut to 280 characters at a word boundary; the summary then ends in "…".
- Matching is sources × issues per project. Scope the input to one project and a time window.

## Integration questions

1. **Parent issue for comments.** Can `SourceRecord` gain an optional `issueKey`? Inferring it
   from the URL works for standard Jira URLs but is fragile.
2. **Text rendering.** Will the resolver use the conventions above (`## ` headings, `Decision:`
   / `Open question:` lines for Confluence decision items)? If not, decision items lose their
   strongest signal.
3. **Page → project mapping.** How will a Confluence page get its Jira `projectKey`: space
   mapping, page labels, or issue links?
4. **Cross-source duplicates.** Should the same decision on two pages be merged? (Out of scope
   here; easy to add later.)
5. **PR #1** (`decision-engine/`) is an earlier, broader version of this module with a
   different contract. If this module is the one you integrate, PR #1 can be closed.
