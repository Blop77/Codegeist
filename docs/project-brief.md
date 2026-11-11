# Decision Drift Radar

## One-line pitch
Decision Drift Radar connects decisions recorded across Jira and Confluence to the work they change, then helps a teammate close the gap with source-linked, reviewable updates.

## Target user and urgent problem
Product and engineering teams make decisions in design docs, meeting notes, comments, and issue discussions. The decision often never reaches the Jira issue, acceptance criteria, or delivery plan. Teams then implement against stale assumptions, rediscover context late, or ship the wrong thing.

## Product promise
For a Jira project or issue, show the important decisions that may affect it, where each decision came from, what work appears out of sync, and a safe next step. Every claim must be traceable to Atlassian source context. The app proposes changes; a person reviews and applies them.

## Core user journey
1. Open Decision Drift Radar from a Jira project or issue.
2. Choose a scope and time window, or open a precomputed project radar.
3. Review a prioritized list of candidate decisions with source excerpts, timestamps, and links.
4. Inspect affected Jira issues and the reason each was matched.
5. Accept, edit, dismiss, or snooze a proposed action.
6. If accepted, apply a narrowly scoped Jira update and record an audit trail linking the decision and source.
7. Revisit the radar to see resolved, new, and still-unacknowledged drift.

## Non-negotiable product principles
- Evidence before assertion: show source, excerpt, date, and confidence/reasoning for every surfaced decision.
- Human approval: no silent edits, comments, assignments, or status changes.
- Useful without AI: deterministic links, filters, and issue context remain usable if model services are unavailable.
- Minimize data: request only the Atlassian scopes and content needed for the chosen workflow.
- Explain uncertainty: distinguish an explicit decision from a possible decision or an unresolved discussion.
- Designed for team trust: idempotent actions, audit history, retries, and clear permission errors.

## Product scope
### Demo-critical MVP
- Jira project/issue entry point.
- Confluence source discovery for relevant pages and Jira discussion context.
- Decision candidate extraction with citations and source links.
- Affected-issue matching with an explainable reason.
- Review queue: accept/edit/dismiss/snooze.
- One safe action: append a reviewed decision note to a selected Jira issue, preserving the source link.
- Status tracking so the same candidate does not repeatedly reappear as new.
- Seed/demo dataset and a complete end-to-end demonstration.

### Stretch goals, only after the MVP is reliable
- Teamwork Graph context to connect people, goals, projects, and related work.
- Rovo agent or reusable skill/action to answer “what decisions could block this issue?” with citations.
- Scheduled radar refresh and notifications.
- Cross-project decision dependencies and stale-decision detection.
- Marketplace-ready packaging, analytics, and admin controls.

## Suggested architecture
- Forge UI module in Jira for the project radar and issue-level view.
- Forge resolver/backend owns Atlassian API calls, authorization checks, candidate persistence, and action execution.
- Atlassian REST APIs retrieve Jira issues/comments and Confluence pages using least privilege.
- Candidate model: `id`, `projectId`, `decisionText`, `sourceType`, `sourceId`, `sourceUrl`, `evidenceExcerpt`, `sourceUpdatedAt`, `confidence`, `confidenceReasons`, `affectedIssueKeys`, `state`, `createdAt`, `updatedAt`.
- Action ledger: `candidateId`, `issueKey`, `actionType`, `before/after`, `actor`, `timestamp`, `result`.
- Use Forge storage for app-owned review state; do not copy whole source documents into storage.
- Keep extraction/matching behind interfaces so a deterministic baseline can be replaced or complemented by an approved AI/Rovo path without changing the UI.

## Initial prioritization logic
Rank candidates using transparent signals: explicit decision language, recency, source authority, overlap with issue/project terms, and whether the affected issue is active or blocked. Show the signals to the reviewer; do not present a score as certainty.

## Work split
### You: product owner and integrator
- Confirm the target persona and the exact first-demo scenario.
- Own shared repo, Forge app creation/configuration, environment variables, and final merge.
- Build the end-to-end demo path and keep the product scope coherent.
- Review Claude's branch before integration; resolve conflicts and verify install/deploy permissions.
- Decide which stretch goals survive after the core journey works.

### Claude: isolated discovery/extraction workstream
Give Claude a bounded task with a separate branch or isolated files:
- Research and implement the decision-candidate extraction/matching module behind a typed interface.
- Input: normalized Jira issue and Confluence/Jira discussion records; output: candidate decisions, evidence spans, affected issue keys, and explainable match reasons.
- Include deterministic rules and a mock fixture set first; make any LLM provider optional and injectable.
- Do not edit Forge manifest, app shell, shared routing, or storage schema without an agreed interface change.
- Deliver: branch/patch, interface/schema, fixture examples, known limitations, and how to run it.

### Me (Codex): Forge foundation and product integration
- Establish the Forge app structure and manifest/modules.
- Implement Jira UI shell, resolver boundary, permission-aware Atlassian data adapters, candidate/review storage, and the human-approved Jira note action.
- Integrate Claude's module once its input/output contract is stable.
- Keep an integration checklist and a coherent demo storyline.

## Shared contracts to agree before parallel coding
1. Runtime and UI framework selected from the current Forge template.
2. Normalized source record schema: Jira issue, comment, Confluence page, and page excerpt.
3. Candidate schema and confidence semantics.
4. Persistence ownership and migration/versioning approach.
5. Action semantics: exact Jira field/comment change, permission check, retry/idempotency key, and audit record.
6. Branch/patch delivery and naming conventions.

## Definition of done for the demo
A judge can install/open the app, select a project, see at least one decision with a direct source citation, understand why a Jira issue is affected, review/edit the proposed note, apply it with one explicit confirmation, and see the resulting Jira update and audit state. A failed permission/API call produces a useful message and does not create partial or duplicate changes.

## Risks to resolve early
- Forge API permissions and product scopes may constrain cross-product discovery; validate the exact APIs before building broad ingestion.
- Teamwork Graph and Rovo access may have eligibility or product availability constraints; treat them as an enhancement until confirmed in the developer tenant.
- Broad search can be noisy and expensive; scope discovery to a project, time window, and explicit source set.
- AI can hallucinate decisions; citations, uncertainty labels, and approval are required for trust.
