# Accuracy benchmark

How well does the rule-based extractor find decisions, open questions and proposals in real meeting notes that were never written for it? This benchmark uses 24 hand-labelled meeting-notes files from open-source projects. The two evaluation sets contain 16 files and 18 strict decision labels between them.

Run it with `npm run benchmark` (Node 22.18 or later, no install needed). It scores the current rules and the rules as they were before tuning, prints a summary and writes [RESULTS.md](RESULTS.md) with every miss and false alarm.

## Recall set (decisions only, labels frozen before any run)

A third, fresh set measures the decision-recall gap. It uses 8 more files chosen by the same rule (the next-oldest in each source), labelled for **decisions only**. The labels were frozen before anything ran on these files: the checksum and time are in [recall/FROZEN.txt](recall/FROZEN.txt).

| Recall set: 10 strict decisions | Rules before tuning (`d04822a`) | Current rules | Rules + AI pass |
| --- | --- | --- | --- |
| Decisions found | 3 | 7 | 9 |
| False alarms | 0 | 0 | 1 |
| Precision / recall | 100% / 30% | 100% / 70% | 90% / 90% |
- **Missed by the current rules:**
  - "Agreed this will be the topic for the next working group meeting" ("Agreed" without a following "to", "that" or ":");
  - "We definitely want this feature.";
  - "CONCLUSION: pnkfelix to comment on the issue." ("Conclusion:" is not one of the recognised labels).

  They are recorded here, but the rules were not changed for them, so this set stays an untouched measure.
- **Reading it together with the held-out set:** on the held-out set the same current rules found 2 of 8 decisions; here they found 7 of 10. Across both untouched sets that is **9 of 18 decisions (50%), with no false decision calls**. Most of this set's decisions are OpenJS outcome lines ("There was consensus…", "…it was therefore approved"), which the tuned rules recognise. Most of the held-out set's decisions were phrased as "Let’s…" or in prose. Recall depends heavily on how a team writes, and 18 decisions is a small sample.

## Historical: held-out set (notes the rules were never tuned on)

| Held-out set: precision / recall | Before tuning | After tuning (first run, before the apostrophe fix) |
| --- | --- | --- |
| Anything flagged (kind ignored) | 61% / 59% | **67% / 70%** |
| Decisions | 100% / 25% | 100% / 25% |
| Open questions | 50% / 57% | 57% / 86% |
| Proposals | 67% / 80% | 75% / 80% |

8 files, 37 strict labels. These numbers come from the first run of either rule version on these files. They are kept as the historical result of the tuning round.

**What this says, plainly**

- **Precision on decisions is perfect on small numbers, recall is low.** Every decision the rules flagged was a real decision, in both sets, before and after tuning: 2 flagged decisions on the held-out set and 7 on the recall set. Recall was 25% on the held-out set and 70% on the recall set. In the app, a finding is shown to a person and can become a Jira comment, so precision is the property we protect. Recall is the known gap, and the reason for the optional AI pass.
- **Tuning helped questions and proposals, not decisions.** On the files used for tuning, decision recall rose from 30% to 70%. On the held-out files it did not move (25%). The new decision phrasings ("Decide to…", "General agreement that…", "decided against") are real but rare. The held-out misses are phrased differently again: "Let’s not block the sub-issues on this.", "We clarified that…", "It was also deemed…", "pnkfelix to report consensus…".
- **Most false alarms come from chat transcripts.** In the Rust language team transcript, conversational questions that are answered moments later ("scottmcm: are we sure we can do that?") are flagged as open questions.

**A bug found by the held-out run.** Typographic apostrophes ("Let’s", which Confluence often stores) were not recognised by any rule. This was fixed after the held-out run, so it doesn't affect the headline numbers. With the fix, the held-out "anything flagged" score is 69% / 78%, decisions are unchanged at 100% / 25%, and proposal precision falls from 75% to 63%. [RESULTS.md](RESULTS.md) is generated from the current rules, so it includes the fix.

## Historical: development set (used for tuning)

| Development set: precision / recall | Before tuning | After tuning |
| --- | --- | --- |
| Anything flagged (kind ignored) | 80% / 55% | 96% / 86% |
| Decisions | 100% / 30% | 100% / 70% |
| Open questions | 83% / 42% | 92% / 92% |
| Proposals | 45% / 71% | 86% / 86% |

8 files, 29 strict labels. The rules were changed while looking at these files, so the "after" column overstates real-world accuracy; the held-out set is the fair measure.

## Numbered-sentence AI evaluation protocol

Use the Forge Claude model and the candidate numbered-sentence `askModel` code. First run the development corpus as a pipeline check. Then run the recall set once and the held-out set once, in that order, with the same prompt, extractor, input limits and frozen labels. Send one prepared public meeting-notes page per model call. Pass the rule findings as already found. Never send the annotation labels or Jira data. The model returns sentence IDs. The app maps them to source text and runs its normal evidence verifier.

Record the model, run timestamp, per-file input hash, verified AI findings, rejected count and reported usage. Score the rules alone and the rules plus verified AI findings with the same scorer and ambiguous-label policy. Report decision hits, false positives, misses and precision/recall with denominators. Report input clipping and ambiguous matches alongside the scores. An incomplete set has no comparative score. Do not retry an ambiguous or failed scored call automatically.

For the background run, the development pipeline check exposed a 3,000-output-token cutoff before either scored set was sent. The scored protocol used a 12,000-output-token cap with the same prompt, source preparation, label files and scorer. It reused the four completed development pilot results and completed the remaining pipeline-check files before starting either scored set. The development corpus results use both caps and are diagnostic only.

The standalone runner `node benchmark/run-ai.ts` uses an approved HTTPS development endpoint via `DDR_BENCH_URL` and `DDR_BENCH_TOKEN`. This run used a temporary background worker inside the authenticated development app. Keep endpoint credentials and temporary harness code outside the release diff. Rerun `npm run benchmark` to score [the recorded results](ai-results.json) locally.

### Results on the two evaluation sets

The background run used Forge development 6.17.0 with `claude-sonnet-5`, one public meeting note per call, on 13 November 2026. All prepared source lines fit in the input budget. At the time of the run the app still used a 3,000-output-token cap inside a synchronous request. The app has since been changed to match this run: for a real project the AI pass now runs as a background job with the same prompt, numbered sentences, input budget, 12,000-output-token cap and verification. A project scan can hold up to 15 sources rather than one page per call, so these per-page results are still an estimate of what the app does on a real project.

| Set | Mode | True decisions | False decision flags | Misses | Precision / recall | Ambiguous matches excluded |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Recall | Rules | 7 | 0 | 3 | 100% / 70% | 0 |
| Recall | Rules + AI | 9 | 1 | 1 | 90% / 90% | 1 |
| Held-out | Rules | 2 | 0 | 6 | 100% / 25% | 15 |
| Held-out | Rules + AI | 2 | 8 | 6 | 20% / 25% | 44 |

The recall set scores decisions only. On the held-out set, across all finding kinds with kind ignored, precision fell from 69% to 49% and recall rose from 78% to 84%. Across all kinds, all 35 recall-set and 50 held-out AI suggestions passed the exact-quote check. This check establishes that the quote exists in the source. Whether it records a real decision is a separate judgement. The held-out comparison supports keeping AI optional and visibly labelled.

## Commitment vs opinion change and the fresh set

The rules were changed to separate a team commitment from nearby things that look like one. Changes in `src/domain/extractDecisions.ts`: a sentence that says an earlier decision was reversed, withdrawn or rescinded is no longer reported ("The decision to adopt Postgres was reversed"); a hedged personal view on a transcript line ("josh: I think we agreed to ship it") or a condition or future decision ("once we agree", "we will decide next week") is no longer a decision (at most a proposal); and a speaker's question that the next speaker replies to straight away is no longer an open question. Explicit labels ("Decision:", "Agreed:") are never downgraded. These were developed against `corpus/` and `src/domain/fixtures` only. The 27 fixture checks and their golden output are unchanged; one check was added.

**Protocol.** Before running any rules on it, a fresh set was prepared by the same selection rule (next-oldest minutes from the same public sources): OpenJS CPC 2025-04-01, 03-18, 03-04, 02-18; Rust language team 2022-11-01; Polonius working group 2019-04-23 and 03-07 (only two older files exist). The third Polonius slot is filled by the next-oldest language team minutes, 2022-10-25, a rule stated after the Polonius folder ran out. Files are unmodified (MIT and Apache-2.0; commits in [sources-fresh.tsv](sources-fresh.tsv)), labelled by hand in [labels-fresh.json](labels-fresh.json) with the same protocol as the held-out set, and frozen with the time and SHA-256 in [fresh/FROZEN.txt](fresh/FROZEN.txt). Then the old rules (`fa2a139`, origin/main) and the new rules were run on it once, and the rules were not changed afterwards. The held-out and recall sets were not used for tuning; the new rules' held-out score was seen after the change was written. [RESULTS.md](RESULTS.md) has the old-vs-new counts table for all four sets.

**Reading it.** The fresh set has only 9 strict labels (5 decisions) and 76 ambiguous ones, so it says little about decision recall. Its main signal is false alarms: 13 to 10 findings, mostly transcript questions that are answered in the notes. Decision precision and recall are unchanged on every set (100% precision throughout); recall on decisions did not improve. On the development set one correctly labelled open question ("Is it a blocker?") was lost to the answered-question rule. Nothing got worse on the held-out or recall sets. The answered-question rule only catches a question that ends its speaker's line and is followed by another speaker; several fresh false alarms are questions in the middle of a line or followed by the same speaker, and remain.

## Corpus

Files were chosen by a fixed rule decided before reading them: the most recent minutes in each source folder for the development set, then the next-oldest for the held-out set.

| Set | Files | Source | Licence |
| --- | --- | --- | --- |
| Development (`corpus/`) | OpenJS CPC 2025-08-05, 08-19, 09-16, 09-30 | [openjs-foundation/cross-project-council](https://github.com/openjs-foundation/cross-project-council) `meetings/2025/` | MIT |
| | Rust language team 2022-11-22 | [rust-lang/lang-team](https://github.com/rust-lang/lang-team) `minutes/` | Apache-2.0 |
| | Rust traits working group 2019-02-24, 03-04, 03-11 | [rust-lang/compiler-team](https://github.com/rust-lang/compiler-team) `content/working-groups/traits/minutes/` | Apache-2.0 |
| Held-out (`heldout/`) | OpenJS CPC 2025-06-09, 06-24, 07-08, 07-22 | as above | MIT |
| | Rust language team 2022-11-15 | as above | Apache-2.0 |
| | Rust Polonius working group 2019-05-28, 06-04, 06-11 | [rust-lang/compiler-team](https://github.com/rust-lang/compiler-team) `content/working-groups/polonius/minutes/` | Apache-2.0 |
| Recall (`recall/`) | OpenJS CPC 2025-04-15, 04-29, 05-13, 05-27 | as above | MIT |
| | Rust language team 2022-11-08 | as above | Apache-2.0 |
| | Rust Polonius working group 2019-04-30, 05-07, 05-14 | as above | Apache-2.0 |

The traits working group has only three minutes files, so the held-out set takes its three prose summaries from the Polonius working group instead. That rule was stated before reading them: the next working group in the same repository with the most minutes.

Files are unmodified copies. [sources.tsv](sources.tsv), [sources-heldout.tsv](sources-heldout.tsv), [sources-recall.tsv](sources-recall.tsv) and [sources-fresh.tsv](sources-fresh.tsv) record each source path and commit, and `corpus/LICENSES/` holds the licences. Copyright remains with the original authors: the OpenJS Foundation and contributors, and the Rust project contributors.

## Method

1. **Preparation** ([prepare.ts](prepare.ts)) turns Markdown into the plain-text layout the app builds from a Confluence page: one line per paragraph, `## ` headings, `- ` list items. Hard-wrapped lines are joined. Link targets, bold markers, front matter and code blocks are dropped; no wording is changed.
2. **Labels** ([labels.json](labels.json), [labels-heldout.json](labels-heldout.json)) are verbatim spans of the prepared text, each with one kind:
   - **decision**: the notes record that the group decided, agreed, approved or resolved something, or reached consensus;
   - **open question**: a question about what to do that the notes leave unresolved;
   - **proposal**: a suggestion put to the group that is not recorded as decided.

   Questions answered later in the notes are not labelled, so flagging one counts as a false alarm. A script checks that every label appears verbatim.
3. **Ambiguous labels** mark borderline sentences: action items ("X will…", "Next step: …"), deferrals, agenda boilerplate and tentative plans. A finding that matches an ambiguous label counts neither for nor against the extractor. This matters for precision: on the held-out set, 15 of the 57 findings (26%) matched ambiguous labels and were not scored. Precision is 69% over the 42 scored findings; counting all 15 as wrong, it would be 51% (29 of 57). On the development set the same comparison is 96% against 62% (25 of 40). On the recall set no finding matched an ambiguous label.
4. **Order of work:**
   1. Label the development set.
   2. Run the original rules on it.
   3. Tune the rules on it.
   4. Download and label the held-out set.
   5. Run both rule versions on the held-out set once.

   No rule was changed after looking at held-out results, except the apostrophe bug fix, which is reported separately above.
5. **Scoring** ([run.ts](run.ts)): a finding matches a label when one normalised text contains the other and the shorter is at least half as long. Each label and finding is used once. A finding of the wrong kind counts as a false alarm for its kind and a miss for the label's kind. The "before tuning" rules are loaded from git ref `d04822a`.

## Limits

- **Small sample:** 66 strict labels across 16 files, plus 10 strict decisions in the recall set. Read the percentages as indicative, not precise.
- **Who labelled:** the labels were written by the app's authors. They are published so anyone can check or dispute them.
- **Duplicates:** in one held-out file, "Is AI-assisted development allowed?" appears twice and was labelled twice. The app reports a repeated sentence from the same page once, so one of the two counts as a miss.
- **Kind of notes:** open-source governance notes are not a company team's Confluence pages, but they are real and unedited, which is the point.
- **The AI pass is not measured:** it runs on Atlassian-hosted Forge LLMs, which aren't available locally.
- **Further tuning** would need a third, fresh set to be reported fairly.
