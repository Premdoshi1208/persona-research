# Persona infrastructure

This deployment uses a dedicated private GitHub source repository, a Render Free Node web service, and a dedicated Neon Free PostgreSQL project. Source contains no real credentials.

## Deployment

1. Run `npm ci --include=dev`, `npm run build`, and the relevant tests. Render explicitly includes build tools even though the production runtime sets `NODE_ENV=production`.
2. Push the verified source to the private repository's `main` branch.
3. Run `node --env-file=.env infra/render.mjs create` once, then use `deploy` for later revisions.
4. Inspect `status` and `logs`. Service startup runs database migrations before listening.

The ignored `infra/state.json` records resource IDs and the real service URL. Runtime credentials come from `.env` locally and Render environment variables in production. Render and Neon control-plane credentials must never be supplied to the product runtime.

## Live provider validation

`node --env-file=.env infra/provider-probe.mjs` sends genuine model discovery, reasoning, TTS, and STT requests to Groq. It records sanitized results in `evidence/provider-verification.json`. `tests/fixtures/participant.wav` contains synthetic spoken test content, not real participant audio.

Groq Orpheus requires the organization administrator to accept the model provider terms at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english . The first live verification returned `model_terms_required`; after the user accepted the terms, a second live verification passed with genuine generated WAV audio and an exact Whisper transcription. The initial failure is preserved in `evidence/provider-verification-preterms.json`. Persona must clearly disclose browser speech fallback whenever the provider is unavailable.

## Costs and hosting limits

- Render service compute plan: Free, no paid service provisioned. It spins down after 15 minutes without inbound traffic and may take about a minute to restart. Workspace free hours, bandwidth, and build minutes apply. Render may suspend unusually high outbound API traffic. Free service files are ephemeral; all core product data must remain in PostgreSQL.
- Neon project plan: Free. Current documentation lists 1 GB Postgres storage per project, 100 CU-hours per project per month, 5 GB public transfer, suspension after 5 minutes of database inactivity, and up to 6 hours of point-in-time history. This dedicated Neon database does not have Render Free Postgres's 30-day expiry. Free quota exhaustion can interrupt access; no paid upgrade is authorized.
- Groq usage is charged according to the user's existing account and limits. Current published pricing: GPT OSS 120B $0.15 / 1M input tokens and $0.60 / 1M output tokens; GPT OSS 20B $0.075 / 1M input and $0.30 / 1M output; Whisper turbo $0.04 / audio hour; English Orpheus $22 / 1M characters. Orpheus is a preview model and may change. Application quotas are an additional safety layer, not a replacement for provider billing limits.
- An always-on SLA, paid backups, private networking, email service, and paid compute were not provisioned.

Official references verified during implementation:

- https://render.com/docs/api
- https://api-docs.render.com/reference/create-service
- https://render.com/docs/free
- https://neon.com/docs/introduction/plans
- https://console.groq.com/docs/models
- https://console.groq.com/docs/speech-to-text
- https://console.groq.com/docs/text-to-speech/orpheus
