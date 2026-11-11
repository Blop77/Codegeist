# Decision Drift Radar

Decision Drift Radar helps teams catch decisions recorded in Confluence or Jira discussions that have not made it into the Jira work they affect. It brings source context into the project view and is designed to let teammates review suggested updates before applying them.

**Codegeist 2026** · Atlassian Forge app for Jira, Confluence and Rovo.

## Try it

**[Install Decision Drift Radar on your Atlassian site](https://developer.atlassian.com/console/install/68a157f1-8d36-4681-ad80-656a45181b6a?signature=AYABeErQrktzFiwiP0JBC0WC3lIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBL6%2BHB6IcT2W5B6PYJtfwSgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDFYEFTpntWYOhX%2BLDwIBEIA7t7oDfDaRrRCxVKZubC4B7RA97rAkfVk%2FnBHm30DkUpGgmZO5LjiMRcEQKdQr%2F8NGA4JfBbz7veBJfCoAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgFFUfSUfE0TtKWq%2BEgaVIIXAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMA8HAfzMzNyXQzYniAgEQgDsRW2ABoyiQYKniXglzhfW9UWoWrX6FhadL5gn6JMbPYOXHZa7oZ%2B4S0cAL2Sns33x%2F8xHUQye65iXv8wAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAbS4b6dRAYV%2FLK6Q23vA0jsAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAxHOKip3ek9xrrZpT8CARCAO%2FH4QqO82%2FBmgzDOvCFDwMa2qz3D%2Bz473b85tV%2FO%2BOLZBDWbyywsCEuX2XEQqNiU3VnmEBFasYJJBAE8AgAAAAAMAAAQAAAAAAAAAAAAAAAAACYgLikmR2W48JXlIXvTTyf%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADJVn7ZYE%2Fz30hEDuvLgQQ%2BeF6C65RMfI0M1pqA8yP5N5eSVTAt4EK9WoBB2UpvHdH93fFBCl2wMoomDux9tUp6U6VE%3D&product=jira&product=confluence)**

You need to be an admin of a site with Jira and Confluence. Install into Jira, then open the link again to connect Confluence on the same site.

- **No setup:** in Jira, open **Apps → Decision Drift Radar** and select **Try with sample data** to see a full scan of a small bundled project. Nothing is read from or written to your site.
- **With your own data:** follow the [testing instructions](docs/testing-instructions.md). It takes about five minutes and includes copy-paste text.

The link installs the production build. The app sends no data outside Atlassian; see the [privacy policy](docs/privacy.md).

## Current implementation

- Jira global page with a project picker, and a Jira project page that scans the open project.
- Jira issue and project lookups using the signed-in user's access.
- **AI pass, on request**: **Find more with AI** asks an Atlassian-hosted model (Forge LLMs) for decisions phrased indirectly that the wording rules miss. A finding is kept only if its quote is found word for word in the source, and it is labelled **Found by AI**. Limited to 40 runs per site per day.
- **Rovo agent** "Decision Drift Radar": ask in Rovo chat which decisions may affect an issue or a project. It runs the same scan through two read-only actions and answers with the quote, the source link and the reasons. It cannot change Jira; reviews and notes stay in the app.
- **Try with sample data**: the same analysis on a small bundled project, for sites that have no decision pages yet. It reads and writes nothing on the site.
- Scoped Confluence page search for pages mentioning the project key.
- Decision extraction (`src/domain/`) over issue descriptions, issue comments and those Confluence pages: decisions, open questions and proposals, each with a quote, source link, wording signals, and the reasons it may affect a Jira issue.
- Jira issue panel showing the decisions that point at the open issue.
- Shared per-project review state: teammates can mark a finding relevant or dismiss it, with the review date retained in Forge storage.
- Source links, permission-aware errors, and warnings when Confluence cannot be reached.
- One Jira write, always confirmed by a person: once a finding is marked relevant, a teammate can edit a note and post it as a comment on an affected issue, with the quote and source link. Each note is recorded so it is not posted twice. Reviews alone never change Jira.

## Local setup

1. Install the official Forge CLI and sign in with the Atlassian account that owns the developer site.
2. Install dependencies with npm.
3. Deploy with `forge deploy --environment development`.
4. Install on a Jira site with `forge install --site <site>.atlassian.net --product Jira --environment development`.
5. Grant the Jira (read and write), Confluence, and Forge storage scopes when prompted. Confluence pages are optional; Jira descriptions and comments are scanned even when Confluence is unavailable.
6. If the app was already installed, upgrade the installation after deploying a scope change so Jira can grant it: `forge install --upgrade --site <site>.atlassian.net --product Jira --environment development`.
7. To enable Confluence page discovery, install the optional Confluence app on the same demo site: run `forge install --demo-site --environment development` again and select Confluence.

Run the domain fixture checks with `npx --yes tsx src/domain/fixtures/checkFixtures.ts`.

See [Atlassian's Jira Forge tutorial](https://developer.atlassian.com/platform/forge/build-a-hello-world-app-in-jira/) for the current CLI and install flow.

## Project docs

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
