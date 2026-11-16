# Persona

**Customer research that runs itself.**

Persona is a free public beta for creating research campaigns, conducting adaptive AI voice interviews, and turning participant responses into evidence-backed findings. Researchers can start in a private guest workspace, publish an interview link, review transcripts and analysis, ask research questions, and export or share a report. Participants do not need accounts.

Deployment and acceptance status are recorded in [EXECUTION_STATUS.md](EXECUTION_STATUS.md). That file and the timestamped files in `evidence/` distinguish completed checks from pending checks. A source build or a live provider test alone is not a claim that the public customer journey passed.

## Run locally

Requirements: Node.js 22+, npm, a PostgreSQL database, and a Groq API key whose account can use the configured models. No Redis or email service is required.

```sh
npm ci
cp .env.example .env
# Set DATABASE_URL and GROQ_API_KEY in the ignored .env file.
npm run dev
```

Open `http://localhost:3000`. Startup applies the idempotent PostgreSQL migration under an advisory lock before accepting requests. Development uses the same Express API and PostgreSQL database as production, with Vite middleware for the client.

For a production build:

```sh
npm run build
npm start
```

Set `NODE_ENV=production` and `APP_URL` to the actual HTTPS origin in production. All browser requests use the same origin. Never place credentials in a `VITE_` environment variable, the client, the repository, or a deployment URL.

## Architecture

One Node/Express service serves the React/TypeScript/Vite client and the API. PostgreSQL stores workspace records, users and sessions, consent, campaigns, interview messages, analyses, evidence, assistant conversations, reports, usage reservations, execution records, and recoverable jobs. Parameterized `pg` queries and an explicit SQL migration avoid a generated ORM client and keep the one-service deployment small.

Relevant source:

- `server/index.ts`: same-origin HTTP API, authentication flows, campaign lifecycle, participant sessions, exports, and service startup.
- `server/security.ts`: workspace sessions, CSRF/origin checks, scoped ownership checks, and persistent rate buckets.
- `server/ai.ts`: Groq SDK calls, typed agent outputs, exact-quote validation, research synthesis, retrieval, and speech.
- `server/jobs.ts`: PostgreSQL job claims, leases, retries, and analysis orchestration.
- `server/schema.sql`: relational schema, foreign keys, uniqueness constraints, and full-text search indexes.
- `server/reports.ts`: real PDF/CSV generation and restricted public report views.
- `client/`: the landing page, private workspace, public interview room, reports, and settings.

The browser records one participant turn with `MediaRecorder`, uploads that audio for Groq transcription, and submits the transcript for adaptive reasoning and interviewer generation. Generated Groq WAV audio then plays in the browser. Microphone tracks are released before playback and after each response. This is a turn-based voice conversation. A clearly disclosed browser-speech fallback is available when Groq audio cannot be generated; text input is also available.

## Seven independently executed agents

Each row below is a separate bounded model invocation with its own input, Zod-validated output, and persisted execution status. The activity center reads actual execution records; it does not stream private model reasoning.

| Agent | Responsibility |
| --- | --- |
| Research Strategist | Creates objectives, assumptions, neutral questions, an interview strategy, and success criteria. |
| Adaptive Reasoning Agent | Reviews the interview so far, selects a personalized follow-up or next question, and decides when to finish. |
| Voice Interviewer | Converts that plan into one short, natural spoken interview turn. |
| Interview Analyst | Extracts findings and objective coverage with exact participant-message references. |
| Research Intelligence Agent | Groups findings across completed interviews and answers research questions from retrieved evidence. |
| Product Strategy Agent | Proposes prioritized actions whose rationale references observed themes. |
| Evidence Verification Agent | Independently rejects unsupported themes, executive summaries, recommendation rationale, and research-assistant claims. |

GPT OSS models use strict JSON Schema output. Application code validates every output again. Quotes must be exact substrings of actual participant messages; fabricated message IDs, paraphrases presented as quotations, and interviewer quotations are discarded. Supporting-interview counts and percentages are calculated from distinct interview IDs in code, never accepted from a model. Findings and suggested actions remain separately labeled, and reports state the limits of qualitative research.

Completed stages are reused only for the same workspace, campaign/interview, input, model, prompt, and output schema. A later provider failure can therefore resume without paying to replay earlier completed stages. Agent calls time out after 60 seconds and allow at most two attempts. Background jobs allow three attempts, claim work using `FOR UPDATE SKIP LOCKED`, renew a PostgreSQL lease while working, and recover stale work after two minutes. A per-campaign advisory lock serializes synthesis across service instances. Final insight writes recheck and lock the source interviews so a concurrent withdrawal cannot restore deleted evidence.

Ask Persona retrieves participant messages using PostgreSQL full-text ranking within the current workspace. A second agent verifies its answer, and returned evidence links point to real source messages. An empty research workspace produces an explicit insufficient-evidence response without an AI request.

## Configuration and cost controls

`.env.example` contains the canonical variable names. Never pass Render or Neon control-plane API keys to the web service; its runtime needs only the PostgreSQL connection and Groq credentials.

| Variable | Public beta configuration |
| --- | --- |
| `GROQ_REASONING_MODEL` | `openai/gpt-oss-120b` |
| `GROQ_CONVERSATION_MODEL` | `openai/gpt-oss-20b` |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` |
| `GROQ_TTS_MODEL` | `canopylabs/orpheus-v1-english` |
| `GROQ_TTS_VOICE` | `autumn` |
| `DAILY_GLOBAL_AI_REQUESTS` | 1,500 attempted LLM/STT/TTS calls per UTC day |
| `DAILY_WORKSPACE_AI_REQUESTS` | 200 attempted calls per workspace per UTC day |
| `DAILY_GLOBAL_SPEECH_CHARACTERS` | 75,000 generated-speech input characters per UTC day |
| `DAILY_WORKSPACE_SPEECH_CHARACTERS` | 20,000 speech characters per workspace per UTC day |
| `MAX_LLM_OUTPUT_TOKENS` | 6,000; conversational calls are additionally capped at 1,800 |
| `MAX_INTERVIEW_TURNS` | 10 participant responses |
| `MAX_CONCURRENT_INTERVIEWS` | 5 in the example configuration |
| `MAX_AUDIO_MB` / `MAX_AUDIO_BYTES` | 12 MB; the byte limit takes precedence in transcription |
| `AGENT_ATTEMPTS` | 2 maximum, including the initial attempt |

The beta additionally allows three campaigns per workspace and up to twelve participants per researcher-created campaign. Campaign duration is configurable from two to twenty minutes. Per-IP, authentication, participant, campaign-generation, speech, assistant, and regeneration limits protect public endpoints. Quota reservations are atomic across processes and occur before contacting the provider; failed attempts count. LLM usage records include reported token totals, speech records include input characters, and transcription records include uploaded bytes. They are usage measurements rather than an invoice estimator.

Groq provider rate limits can be lower than application allowances. Provider 429 errors are handled with bounded backoff and clear retry messages; background jobs retry later. Request/character allowances are not an exact currency spending cap. Hosting uses free service/database plans; Groq processing uses the existing account's billing and provider limits. No payments or automatic paid upgrades are implemented.

Orpheus accepts at most 200 input characters per call. The application splits speech into segments of at most 190 characters and merges compatible PCM WAV segments for playback. The account owner may need to accept the model provider terms in the Groq console before first use.

Official provider references: [Groq models](https://console.groq.com/docs/models), [structured outputs](https://console.groq.com/docs/structured-outputs), [speech recognition](https://console.groq.com/docs/speech-to-text), and [Orpheus speech generation](https://console.groq.com/docs/text-to-speech/orpheus).

## Security, privacy, and retention

- Passwords and recovery codes use bcrypt. Login sessions use random tokens whose hashes are stored in PostgreSQL; production cookies are HTTP-only, Secure, and SameSite=Lax. State-changing workspace requests require CSRF tokens. Origin checks reject cross-origin mutation requests.
- Every private API operation checks a workspace session and ownership. Participant access uses an independent scoped bearer token. Public campaign/report links use cryptographically random tokens; shared reports can be revoked.
- Zod validation, parameterized SQL, secure headers, a restrictive content-security policy, upload type/signature/size checks, and rate limits protect input paths. Campaign and participant text is treated as untrusted data inside agent instructions. Models cannot access application credentials or run arbitrary SQL.
- Participant consent is recorded before interviewing. Participants can decline, stop, or withdraw and delete their interview. Withdrawal deletes the transcript, clears derived research and assistant history, revokes report sharing, and schedules current-data analysis.
- Uploaded participant audio is sent to Groq from memory and is not permanently stored by Persona. Generated interviewer audio may be cached in PostgreSQL for playback and is cleaned up after seven days. Groq also processes campaign descriptions, interview text, and research requests; its own provider data policies apply.
- Guest workspace access expires after thirty days. Expired guest data is removed by periodic cleanup while the service is running; free-service sleep can delay physical cleanup. Registered workspace data remains until deletion, subject to hosting/database availability and quotas. Workspace/account deletion cascades through its dependent product data.
- Account recovery uses a one-time recovery code displayed at registration and rotated on recovery. There is no email provider, email verification, or email reset delivery. Save the recovery code. A guest workspace without an account depends on its browser session.
- Public reports omit transcripts, participant identifiers, exact quotations, and detailed research notes. They expose selected aggregate theme titles/counts and suggested-action titles. Private downloads contain the researcher's actual data.

No regulatory certification or compliance claim is made. Avoid entering sensitive personal information or confidential material into this public beta.

## Verification

```sh
npm test             # Unit and real PostgreSQL API/database tests; no live AI traffic
npm run typecheck
npm run lint
npm run build
npm run test:live    # REAL Groq requests and PostgreSQL writes; consumes provider allowance
npm run test:e2e     # Browser acceptance suite; see its configured target and fixtures
```

`npm run test:live -- --resume` resumes the dedicated workspace from `evidence/agents-live.json` after a provider interruption. The live check creates a clearly identified, expiring QA workspace, uses two independent synthetic spoken fixtures through real Groq TTS/STT, runs adaptive interviews and all seven agents, and verifies combined findings and research-assistant references. Failure writes evidence and returns a nonzero process exit status. It does not manufacture successful provider results.

The WAV fixtures in `tests/fixtures/` are generated test speech, not real customer recordings. Fixture-based microphone tests verify a browser audio path; they do not prove that every physical microphone, mobile browser, Bluetooth device, speaker, or operating-system permission flow works. Provider tests alone do not verify audible playback on a user's device. Browser and public-deployment checks must be reported separately. Current evidence and any remaining gaps belong in `EXECUTION_STATUS.md` and `evidence/`.

## Deployment and operating limits

`render.yaml` describes the unified Node service. [infra/README.md](infra/README.md) documents the dedicated Render/Neon deployment workflow, source repository, model-term prerequisite, and hosting limitations. The ignored `infra/state.json` records actual provisioned resource IDs and deployment state; credentials remain in environment variables.

Render Free can sleep after inactivity, causing a cold start and pausing the worker until the service wakes. The process filesystem is ephemeral; product data and jobs remain in PostgreSQL. Neon Free can suspend idle compute and has storage, compute, transfer, and recovery-history limits. The selected Neon database does not inherit Render Free PostgreSQL's thirty-day expiry, but free hosting is not an uptime or indefinite-retention guarantee. No paid backup plan, always-on compute, or paid infrastructure upgrade has been provisioned.

Read the current official [Render free-service limits](https://render.com/docs/free) and [Neon plan limits](https://neon.com/docs/introduction/plans) before changing infrastructure. A production deployment is accepted only after the real public HTTPS journey has been tested; do not substitute a plausible URL or localhost result.
