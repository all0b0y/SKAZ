## What changed and why

## Related issue
Link to the issue, if any (e.g. `Closes #123`).

## How to test
Commands or steps to reproduce and verify.

```sh
npm run typecheck
npm run test
npm run build
```

## Risks
New dependencies, permission changes (microphone, screen/system audio, file access),
data handling (recordings, transcripts, API keys), or backward compatibility
(stored sessions, settings).

## Author checklist
- [ ] I have verified the changes myself.
- [ ] I added or updated tests where needed.
- [ ] I updated documentation where needed.
- [ ] I checked that no secrets or personal data (keys, tokens, recordings, transcripts) were added.
