# Contributing to SKAZ

SKAZ is an alpha desktop app. Small bug fixes and documentation improvements
can go straight to a pull request. For a new feature, a major change or a new
dependency, open an [issue](https://github.com/4IPE/SKAZ/issues) first and agree
on the scope before implementing it. A proposal or PR does not guarantee acceptance.

## Development setup

The current desktop target is **macOS on Apple Silicon**. Windows, Linux and
Intel Macs are not verified targets. Use Node.js **20.19+ within the 20.x line,
or 22.12+** (Vite's engine requirement), Python **3.11+**, and
[uv](https://docs.astral.sh/uv/). macOS system-audio capture requires 14.2+.

```bash
git clone https://github.com/4IPE/SKAZ.git
cd SKAZ
npm ci
uv sync --project backend
npm run dev
```

The development command launches Electron, the renderer and the local Python
backend. It uses a persistent development profile: do not use private recordings
for testing destructive actions. Automated desktop smoke tests should use isolated
profiles, not your everyday application data.

For basic UI work, provider keys are unnecessary. To use speech recognition,
configure Soniox and cloud consent in **Settings → API keys**. Configure Assistant
and Notes separately. Paid services may charge for requests; do not run paid API
or microphone checks without explicit permission from the account/device owner.

### Optional environment configuration

Normal desktop setup uses Settings, not an `.env` file. The backend supports
explicit environment-key fallback for development/CI; see [.env.example](.env.example).
Neither `npm run dev` nor the backend automatically loads that example as dotenv.
If needed, make a private `.env.local` and export its variables into the launching
process using your own trusted local setup. Do not put secrets in shell history,
PRs, screenshots or logs. Keep `SKAZ_ALLOW_ENV_KEYS=0` unless you deliberately
want environment-key fallback. An existing stored key takes precedence.

## Verify changes

Run from the repository root:

```bash
npm test -- --maxWorkers=1
npm run typecheck
npm run build
uv run --project backend pytest backend/tests
uv run --project backend ruff check backend/src backend/tests
uv run --project backend mypy backend/src backend/tests
# Built Electron integration tests; no real ASR/model-quality claim:
npx playwright test
```

Use focused tests while working, then report the exact commands and results in
your PR. If a check fails, include the failure and whether it was reproduced
before your change; do not call a partially passing suite green. Python typing
currently has a known dependency-stub compatibility issue in some environments;
do not hide it with blanket ignores. For packaging, see [Packaging](docs/PACKAGING.md).

Add a regression test for bug fixes. Keep changes scoped, follow neighboring code,
and avoid unrelated formatting. Deterministic provider fixtures are useful tests,
but are not evidence of real speech recognition or model quality. Label demo data.

## Sending a pull request

1. Fork the repository and create a focused branch.
2. Explain the problem, approach and any user-visible behavior changes.
3. List verification results and remaining limitations. Add sanitized UI screenshots
   when relevant, and update all README translations if their content changed.
4. Check the diff for credentials, recordings, local databases, build output and
   personal data. Do not include local agent instructions or internal work notes.
5. Submit the PR and respond to review feedback.

Contributions are provided under the project's [MIT license](LICENSE). Only submit
work you have the right to contribute. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in public issues.
