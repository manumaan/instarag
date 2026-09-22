# Reel Lens

Instagram reel & post analysis with Claude.

**Built so far: Phases 1-4, plus public reel downloading.** Upload a screen recording or
screenshots, or paste any public reel permalink. A pasted permalink is downloaded with
yt-dlp; everything then runs through keyframe extraction on ingest, with progress pushed
to the browser over a WebSocket, and lands on the reel detail screen as a filmstrip.
Each reel then gets a Claude vision pass that writes per-frame descriptions, verbatim OCR,
and the places it can actually read off the signage, then gets embedded into a vector
index so you can ask questions about it. Lens is the remaining phase.

Downloading public reels is unauthenticated: no IG account, no password, no cookies. It
does violate Meta's ToS, and Instagram may refuse requests from datacenter IP ranges. The
exposure is the fetching IP being blocked rather than an account ban, since no account is
involved; yt-dlp is pinned in `infra/extract/Dockerfile`, and bumping that version is the
expected fix when Instagram changes its markup and downloads start failing.

## Layout

```
infra/           AWS CDK app (TypeScript) — S3, DynamoDB, Cognito, HTTP API, pipeline, WebSocket
infra/extract/   Keyframe extraction Lambda: container image with static ffmpeg
web/             Next.js app — Library and Reel detail screens
scripts/         write-web-env.sh (env from stack outputs) + two end-to-end test scripts
```

## Ingest pipeline

Completing an upload starts a Step Functions execution, which owns every status the
record takes on:

```
queued -> [downloading ->] extracting -> analysing -> [transcribing ->] indexing -> ready
                                                                                 \-> failed
```

The `downloading` leg runs only for a pasted permalink; an upload is already in S3. The
download also yields the reel's caption, uploader and posted-at date from its public
metadata, so a URL-sourced reel gets a caption without an OCR pass.

## Speech

Extraction also pulls a mono 16 kHz audio track, and reels that have one go through Amazon
Transcribe with automatic language identification. The transcript is stored as segments,
split at sentence boundaries so each one is a useful citation target, and indexed alongside
the frames — so Ask can answer a question whose evidence was only ever spoken, and cite the
second it was said. A reel with no audio skips this leg; a transcription that fails leaves
the reel usable rather than failing it.

Two things to know about the output. ASR mishears proper nouns — the caption's
`@no_diet_club` came back as "No Doubt Club" — so the caption and frame OCR are the
authority on names, and speech is the authority on what was said. And Transcribe returns
coarse blocks (a 46s reel came back as three ~20s segments), so segments longer than ~10s
are split with timestamps apportioned by character count: close enough to put the player
within a second or two, not exact.

## Analysis

`analysing` is **one Bedrock call per reel** carrying every keyframe in order, each labelled
with its `ts_ms`. It returns, via structured output: a reel summary, per-frame description
and verbatim OCR, entities, and `places[]` — each place carrying the text it was read from
and the timestamp that text appeared at. That evidence is what makes "which cafe is in this
reel" answerable and citable; a place with no evidence is downgraded to `inferred` before
storage so it can never be presented as read.

Measured on a real 46s reel: 20 frames, 9,521 input + 3,403 output tokens, ~5p at Sonnet 5
rates, ~40s wall clock. Frame count is the main lever — `-c maxFrames=20`.

Frames are **thinned across the whole reel** rather than truncated at the cap. That matters:
the original code stopped once the cap filled, so a 46s reel was only ever analysed to 28s
and the last third did not exist as far as Ask was concerned.

The model is `-c analysisModel=`, defaulting to `us.anthropic.claude-sonnet-4-6` because
this account is not yet entitled to Sonnet 5 on Bedrock. Two things to know before changing
it: model ids need the `us.` cross-region inference-profile prefix (a bare
`anthropic.claude-...` is rejected for on-demand use), and
`get-foundation-model-availability` reports `AUTHORIZED` for models whose invocation is
then denied — a one-token `invoke-model` is the only reliable entitlement test.

Extraction follows the keyframe spec: scene-cut detection at 0.35, cover
frame always kept, perceptual-hash dedupe at a Hamming distance of 8, capped at 12
frames, resized to a 720px long edge. A clip with no scene cuts and more than 6s of
runtime is sampled evenly instead, so a talking-head reel still yields frames.

Status changes reach the browser over a WebSocket: the media table's DynamoDB stream
drives a broadcaster, so nothing in the pipeline needs to know about connections.
The Library falls back to a 30s poll if the socket drops.

## Prerequisites

- Node 22+ and the AWS CLI, authenticated against the target account
- CDK bootstrapped in the region (`npx cdk bootstrap`) — already done for `us-east-1`

## First run

```bash
cd infra && npm install && npm run deploy
```

Create the single owner account (self-signup is disabled, so this is the only way in).
Pick your own password when prompted — nothing in this repo stores or sees it:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_AkqbUBXmf \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Then point the web app at the deployed stack and start it:

```bash
./scripts/write-web-env.sh
cd web && npm install && npm run dev
```

Open http://localhost:3000 and sign in. Cognito will ask you to replace the temporary
password on first sign-in.

## Ask

`indexing` embeds every keyframe with Titan Multimodal Embeddings — one 1024-dimension
vector covering the frame image *and* its description and OCR text together, which is what
lets a single index serve both written questions and (later) image-to-image Lens search.

Retrieval is **hybrid**: kNN over those vectors plus BM25 over `ocr_text`, `places`,
`description` and `caption`, merged with reciprocal rank fusion. Pure vector search is the
wrong tool on its own here — the questions this app exists to answer are often about exact
strings, like a cafe name on an awning or a street sign, where BM25 wins; paraphrased
questions need the vector side. RRF merges the two without calibrating incomparable scores.

The answer is then generated with the same Claude model, from the retrieved frames only.
Two guardrails, both enforced in code rather than trusted to the prompt:

- A citation is dropped unless it points at a frame that was actually retrieved.
- `answered` is reported false when nothing supports an answer, and the UI says so rather
  than showing a confident-looking guess.

The index is an OpenSearch Serverless **NEXTGEN** collection group, which has no OCU
minimum and scales to zero after ten minutes idle. A CLASSIC collection would bill a 2-OCU
floor (~$350/month) whether used or not, which would dwarf every other cost here — do not
switch the collection group to CLASSIC without deciding to accept that standing charge.

Two consequences worth knowing. Writes are visible on the service's own schedule rather
than immediately, so a question asked seconds after indexing may miss the newest frames.
And the first request after ten idle minutes waits for capacity to spin up, which is why
`DELETE /media/{id}` runs with a longer timeout than the other handlers.

Deleting a reel removes its documents from the index as well as its rows and objects —
otherwise Ask would keep citing a reel that is gone. That delete is idempotent: if it fails
halfway, calling it again finishes the job rather than reporting the media as missing.

## Checks

```bash
cd infra && npm test          # handler logic, perceptual hashing, template assertions
./scripts/smoke.sh            # drives the deployed API handlers against real S3/DynamoDB
./scripts/pipeline-smoke.sh   # pushes a real 4-scene clip through the pipeline (needs Docker)
```

Both scripts create their own media items and delete them again, so they are safe to
re-run against a live library. `pipeline-smoke.sh` also checks the failure path: bytes
that are not really a video must end on `failed` with the reason recorded, never stuck.

`pipeline-smoke.sh` runs the vision pass, so each full run costs a few cents of Bedrock.
Its grounding check leans on the smoke clip being ffmpeg test patterns with no real places
in it: the model must return **no** places at all, which is how we know it is not inventing
venues to be helpful.

Its download-leg check deliberately uses a presigned S3 URL rather than an Instagram
link, so it tests our plumbing and not Instagram's mood. Live reel fetching has to be
checked by hand against a real permalink.

## API

All routes sit behind the Cognito JWT authorizer and take the **id token** in `authorization`.

| Route | Purpose |
|---|---|
| `POST /uploads` | Reserve a media id, return a presigned PUT URL (content-type is signed in) |
| `POST /media/{id}/complete` | Confirm the object landed, move the item to `queued` |
| `POST /media/url` | Register a pasted instagram.com permalink and start fetching it |
| `GET /media` | Newest-first library listing, `?limit` and `?cursor` |
| `GET /media/{id}` | Record, presigned playback URL, keyframes |
| `DELETE /media/{id}` | Remove the record, its frames and its S3 objects |
| `POST /ask` | Ask a question; `mediaId` scopes it to one reel, omit it for the library |
| `GET /threads` | Ask threads, newest first |
| `GET /threads/{id}` | One thread's turns, with their citations |

The WebSocket endpoint takes the same id token as `?token=…`, because a WebSocket
handshake cannot carry an authorization header.

## Notes on cost and data

- Everything is on-demand: DynamoDB PAY_PER_REQUEST, Lambda, HTTP API, Step Functions.
  Idle cost is effectively the S3 storage of whatever you upload, plus the ECR storage
  for the extraction image.
- Downloading runs at 2048 MB, extraction at 3008 MB, for a few seconds per reel. The
  analysis call is the only per-reel cost that is not trivial: see Analysis above.
- The vector index scales to zero when idle, so an untouched library costs nothing to keep
  searchable beyond the S3 storage. Embedding a reel is a fraction of a cent. Lambda scales vCPU with memory,
  so that is cheaper per reel than a smaller, slower setting.
- The stack defaults to **destroy-on-delete** while it is a skeleton. Deploy with
  `-c retainData=true` once there is data worth keeping, and `-c retentionDays=90` to
  expire media objects.
- Web origins default to `http://localhost:3000`; override with
  `-c webOrigins=https://app.example.com`.

## Teardown

```bash
cd infra && npx cdk destroy ReelLens
```
