# Security policy

## Supported version

The latest commit on `main` is the supported public baseline.

## Reporting

Please do not open a public issue containing credentials, private messages,
production state, endpoint URLs with embedded secrets, or decrypted wake events.
Use GitHub private vulnerability reporting when available.

## Deployment rules

- Keep state directories at `0700` and state/credential files at `0600`.
- Run the heartbeat under a dedicated unprivileged account.
- Keep delivery disabled until tests and observe-only calibration pass.
- Never commit an Aru sender bundle.
- Put HTTPS and authentication in front of the dashboard.
- Do not expose `127.0.0.1:18760` directly to the internet.
- Treat a delivery timeout after submission as uncertain; do not blindly retry.