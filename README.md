# Decision Drift Radar

Decision Drift Radar helps software teams catch decisions recorded in Confluence or Jira discussions that have not made it into the Jira work they affect. It brings source context into the project view and is designed to let teammates review suggested updates before applying them.

**Codegeist 2026** · Atlassian Forge app for Jira and Confluence.

## Current implementation

- Jira global page with a project-key scan (defaults to `KAN`).
- Read-only Jira issue lookup using the signed-in user's access.
- Scoped Confluence page search for pages mentioning the project key.
- Decision extraction (`src/domain/`) over issue descriptions, issue comments and those Confluence pages: decisions, open questions and proposals, each with a quote, source link, wording signals, and the reasons it may affect a Jira issue.
- Jira issue panel showing the decisions that point at the open issue.
- Shared per-project review state: teammates can mark a finding relevant or dismiss it, with the review date retained in Forge storage.
- Source links, permission-aware errors, and warnings when Confluence cannot be reached.
- Jira remains read-only; review actions do not write to Jira.

## Local setup

1. Install the official Forge CLI and sign in with the Atlassian account that owns the developer site.
2. Install dependencies with npm.
3. Deploy with `forge deploy --environment development`.
4. Install on a Jira site with `forge install --site <site>.atlassian.net --product Jira --environment development`.
5. Grant the Jira, Confluence, and Forge storage scopes when prompted. Confluence pages are optional; Jira descriptions and comments are scanned even when Confluence is unavailable.
6. If the app was already installed, upgrade the installation after deploying the storage scope so Jira can grant it.
7. To enable Confluence page discovery, install the optional Confluence app on the same demo site: run `forge install --demo-site --environment development` again and select Confluence.

Run the domain fixture checks with `npx --yes tsx src/domain/fixtures/checkFixtures.ts`.

See [Atlassian's Jira Forge tutorial](https://developer.atlassian.com/platform/forge/build-a-hello-world-app-in-jira/) for the current CLI and install flow.

## Project docs

- [Product brief](docs/project-brief.md)
- [Integration boundary](docs/integration-contract.md)

## Product principles

- Show source evidence and links behind every surfaced decision.
- Explain why a Jira issue may be affected.
- Require teammate review before changing Jira.
- Store app review state, not copies of full source documents.
