# Contributing to the Gnosis TMS GitHub App Broker

## License

By submitting a contribution, you agree to license it under the GNU Affero
General Public License, version 3 only (`AGPL-3.0-only`; see [LICENSE](LICENSE)).
You retain copyright in your contributions. No additional relicensing grant or
Contributor License Agreement is required for new contributions. Third-party
components retain their own licenses and notices.

## Developer Certificate of Origin

Sign off each contribution commit to certify that you have the right to submit
the work under the project's license. Read the [Developer Certificate of Origin
1.1](DCO.txt) before adding your sign-off.

With your name and email configured in Git, use:

```bash
git commit --signoff -m "Describe your change"
```

This adds a `Signed-off-by: Your Name <your.email@example.com>` trailer. Sign-off
is a certification of the DCO, not a cryptographic commit signature. Only add it
if you can make that certification. GitHub's web editor also requires sign-off.

If you forgot to sign off your latest commit, you can amend it:

```bash
git commit --amend --no-edit --signoff
```

Amending changes the commit ID; coordinate before rewriting shared history.
Command-line contributors must supply their sign-offs themselves; GitHub's web
sign-off setting does not validate commits pushed from a local checkout.
Maintainers should check contribution sign-offs before merging pull requests.

The previous [CLA template](https://github.com/gnosistms/Gnosis-TMS-tauri-app/blob/main/CLA.md)
is retained for historical reference. New contributors do not sign it. Previously
executed agreements and their records are preserved; this policy change does not
rewrite their terms.

## Development

See [README.md](README.md) for local setup and required environment variables.
Read [AGENTS.md](AGENTS.md) for compatibility, authorization, and deployment rules.
Run `npm test` for code changes and keep pull requests focused on one change.
