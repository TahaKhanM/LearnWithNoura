# Security boundaries

LearnWithNoura currently supports synthetic demonstrations. Do not use real child identities, recordings or lesson transcripts. Provider keys belong only in the server environment, and local databases and `.env` files must remain untracked.

The demo login and parent-scoped session capabilities are implemented controls, but they do not replace a real multi-user identity system or production privacy operations. Rate limits are per process. Review `server/runtimeConfig.ts`, `server/security.ts`, and `docs/privacy/threat-model.md` before deploying.

For a suspected vulnerability, contact contact.mtaha@gmail.com with a minimal reproduction using synthetic data. Please avoid putting credentials or personal data in a public issue. No response-time guarantee is implied.
