# Security policy

## Supported versions

SKAZ is **alpha / early access**. Security fixes target only the latest published
release; older releases do not receive separate backports. Update before reporting
an issue that may already be fixed. Development snapshots have no separate support
commitment. No releases are currently published; the policy applies when releases begin.

## Reporting a vulnerability

The intended channel is **GitHub Private Vulnerability Reporting** for
[4IPE/SKAZ](https://github.com/4IPE/SKAZ/security).

**Private reporting is not enabled yet (checked September 26, 2026). There is
currently no configured confidential reporting channel.** Until it is enabled,
do not put vulnerability details, exploit steps, credentials or personal data in
public issues, discussions or pull requests. You may open an issue containing only
a request to enable private security reporting, with no vulnerability details.

Once the repository's Security page offers **Report a vulnerability**, use that
private form. Include the affected version and macOS version, impact, minimal
reproduction steps and sanitized evidence. Use test data, not another person's
recordings or credentials. We do not guarantee response or fix deadlines.

## Security boundaries and limitations

- The desktop backend listens on loopback and uses a per-launch authentication
  token. Do not expose it to a network or publish its token.
- Provider keys are stored in an encrypted file in the app's data directory.
  The encryption key is stored alongside it. File permissions are the main local
  boundary: this does not protect against other processes running as your user,
  or a backup containing both files.
- Transcripts, notes and chat history are sensitive local data, not an encrypted
  personal vault. Protect your device and any exported or synchronized folders.
- Speech recognition sends audio to Soniox after cloud consent. Assistant and
  Notes send context to the selected provider. Provider retention, training,
  account and billing policies apply; local storage does not make inference offline.
- Transcripts and imported content are untrusted input. AI answers and citations
  may be wrong; verify important claims against the source.

This policy covers security vulnerabilities, not conduct complaints. See the
[Code of Conduct](CODE_OF_CONDUCT.md) for community rules.
