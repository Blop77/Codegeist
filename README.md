# Decision Drift Radar

Decision Drift Radar helps teams catch decisions recorded in Confluence or Jira discussions that have not made it into the Jira work they affect. It brings source context into the project view and is designed to let teammates review suggested updates before applying them.

**Codegeist 2026** · Atlassian Forge app for Jira, Confluence and Rovo.

[![Tests](https://github.com/Blop77/Codegeist/actions/workflows/test.yml/badge.svg)](https://github.com/Blop77/Codegeist/actions/workflows/test.yml)

## Try it

**[Install Decision Drift Radar on your Atlassian site](https://developer.atlassian.com/console/install/68a157f1-8d36-4681-ad80-656a45181b6a?signature=AYABeErQrktzFiwiP0JBC0WC3lIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBL6%2BHB6IcT2W5B6PYJtfwSgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDFYEFTpntWYOhX%2BLDwIBEIA7t7oDfDaRrRCxVKZubC4B7RA97rAkfVk%2FnBHm30DkUpGgmZO5LjiMRcEQKdQr%2F8NGA4JfBbz7veBJfCoAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgFFUfSUfE0TtKWq%2BEgaVIIXAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMA8HAfzMzNyXQzYniAgEQgDsRW2ABoyiQYKniXglzhfW9UWoWrX6FhadL5gn6JMbPYOXHZa7oZ%2B4S0cAL2Sns33x%2F8xHUQye65iXv8wAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAbS4b6dRAYV%2FLK6Q23vA0jsAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAxHOKip3ek9xrrZpT8CARCAO%2FH4QqO82%2FBmgzDOvCFDwMa2qz3D%2Bz473b85tV%2FO%2BOLZBDWbyywsCEuX2XEQqNiU3VnmEBFasYJJBAE8AgAAAAAMAAAQAAAAAAAAAAAAAAAAACYgLikmR2W48JXlIXvTTyf%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADJVn7ZYE%2Fz30hEDuvLgQQ%2BeF6C65RMfI0M1pqA8yP5N5eSVTAt4EK9WoBB2UpvHdH93fFBCl2wMoomDux9tUp6U6VE%3D&product=jira&product=confluence)**

You need to be an admin of a site with Jira and Confluence. Install into Jira, then open the link again to connect Confluence on the same site.

- **No setup:** in Jira, open **Apps → Decision Drift Radar** and select **Try with sample data** to see a full scan of a small bundled project. The baseline sample does not read or change Jira or Confluence data. Its optional AI pass stores usage counters in Forge storage.
- **With your own data:** follow the [testing instructions](docs/testing-instructions.md). It takes about five minutes and includes copy-paste text.

The link installs the production build. The app sends no data outside Atlassian; see the [privacy policy](docs/privacy.md).

## Current implementation

- Jira global page with a project picker, and a Jira project page that scans the open project.
- Jira issue and project lookups using the signed-in user's access.
- **Teamwork Graph context**: besides pages that mention the project key, the scan follows Atlassian's Teamwork Graph from the Jira project to its linked teams, their Confluence spaces, and pages linked from decision pages, so decisions recorded in a team's own space are found too. Each such finding says how it was found.
- **Check the wording after a fix**: affected issues show **Outdated wording found** when the scan finds a phrase the decision replaces or removes. After a teammate updates the issue and scans again, an explicitly linked issue can show **Replacement wording found** when it contains the new phrase and the old phrase is gone.
- **AI pass, on request**: **Find more with AI** asks an Atlassian-hosted model (Forge LLMs) for decisions phrased indirectly that the wording rules miss. A finding is kept only if its quote is found word for word in the source, and it is labelled **Found by AI**. Verified AI findings are saved for the project and re-checked against the current sources on every scan, so the issue panel and the Rovo agent show them too. **Draft with AI** writes the note for an affected issue and, when a phrase in the issue's description conflicts with the decision, suggests the change, quoting that phrase word for word. A usage counter targets 40 AI runs per site per day; this is not a strict concurrent-request cap.
- **Rovo agent** "Decision Drift Radar": ask in Rovo Chat which decisions may affect an issue or a project, ask it to find more with AI, or ask it to draft a note. It answers with the quote, the source link, the reasons and the team's review. Rovo prepares a private draft. You load the exact comment in the Jira issue panel and choose whether to post it. Drafts expire after ten minutes, and the app rechecks the finding before posting.
- **Try with sample data**: the same analysis on a small bundled project, for sites that have no decision pages yet, including a sample Teamwork Graph discovery. The baseline sample does not read or change Jira or Confluence data.
- Scoped Confluence page search for pages mentioning the project key.
- Decision extraction (`src/domain/`) over issue descriptions, issue comments and those Confluence pages: decisions, open questions and proposals, each with a quote, source link, wording signals, and the reasons it may affect a Jira issue.
- Jira issue panel showing the decisions that point at the open issue.
- **A radar with memory**: each scan records when a finding was first seen and which issues still use wording a decision replaced. Findings first seen since your last visit are labelled **New since your last visit**, and a summary shows how many issues are still drifting and how many are resolved. A drift is marked **Resolved** when the issue stops using the replaced wording, on the next scan or as soon as the issue is edited (a Jira issue-update trigger checks only issues with an open drift).
- Shared per-project review state: teammates can mark a finding relevant or dismiss it, with the review date retained in Forge storage.
- Source links, permission-aware errors, and warnings when Confluence cannot be reached.
- One Jira write, always confirmed by a person: once a finding is marked relevant, a teammate can edit a note and post it as a comment on an affected issue, with the quote and source link (or post a Rovo draft from the issue panel). The app reserves each finding and issue before posting and can recover a missing receipt from the Jira comment. Reviews alone never change Jira.

## Local setup

1. Install the official Forge CLI and sign in with the Atlassian account that owns the developer site.
2. Install dependencies with npm.
3. Deploy with `forge deploy --environment development`.
4. Install on a Jira site with `forge install --site <site>.atlassian.net --product Jira --environment development`.
5. Grant the Jira (read and write), Confluence, and Forge storage scopes when prompted. Confluence pages are optional; Jira descriptions and comments are scanned even when Confluence is unavailable.
6. If the app was already installed, upgrade the installation after deploying a scope change so Jira can grant it: `forge install --upgrade --site <site>.atlassian.net --product Jira --environment development`.
7. To enable Confluence page discovery, install the optional Confluence app on the same demo site: run `forge install --demo-site --environment development` again and select Confluence.

Run the tests with `npm test` (Node 22.18 or later; no install needed). It runs the domain, resolver, Rovo and Teamwork Graph tests, which replace Jira, Confluence, Teamwork Graph, Forge storage and Forge LLMs with in-memory mocks (`test/mocks`). GitHub Actions runs the same on every push and pull request.

See [Atlassian's Jira Forge tutorial](https://developer.atlassian.com/platform/forge/build-a-hello-world-app-in-jira/) for the current CLI and install flow.

## Accuracy

The rule-based extractor is measured on 16 real, openly licensed meeting-notes files from the OpenJS Foundation and the Rust project, labelled by hand. Half were used to tune the rules; the other half were labelled afterwards and held out. On the held-out notes, 67% of what it flags is a real decision, open question or proposal, and it finds 70% of them. Every decision it flagged was a real decision, but it finds only about a quarter of the decisions in real notes. That gap is what the optional AI pass targets. Method, labels, every miss and false alarm: [benchmark/](benchmark/README.md). Run it with `npm run benchmark`.

## Project docs

- [Accuracy benchmark](benchmark/README.md): method, labels and held-out results on real meeting notes
- [Testing instructions](docs/testing-instructions.md): install the app on your own site and try it, with or without your own data
- [Demo notes](docs/demo.md): current deployment and install status, scan steps, and sample-data limits
- [Product brief](docs/project-brief.md)
- [Privacy policy](docs/privacy.md) and [terms of service](docs/terms.md)
- [Integration boundary](docs/integration-contract.md)

## Product principles

- Show source evidence and links behind every surfaced decision.
- Explain why a Jira issue may be affected.
- Change Jira only on an explicit, reviewed action: one comment, written in the teammate's name.
- Store app review state, not copies of full source documents.
