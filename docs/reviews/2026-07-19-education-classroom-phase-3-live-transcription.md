# Education Classroom Phase 3 — Unit 6 Live Transcription

## Outcome

Unit 6 code is implemented for the two-Web classroom: bounded local-first transcription jobs, validated provisional/final/corrected subtitle revisions, teacher review, student live projection, provider failure/retry, raw-audio deletion with transcript retention, and explicit `audio_with_subtitles / subtitles_only / textbook_board_only` modes. The plan checkbox remains open until a real loopback Whisper-compatible provider, microphone, three students and final-subtitle P95 are accepted on the trusted HTTPS LAN entry.

## Architecture and safety evidence

- PCM persists before transcription and is never rolled back by provider failure. A bounded per-classroom queue prevents unbounded provider concurrency.
- Every job carries classroom/recording generation, stable chunk ID/hash, recording-relative time, attempt and explicit external opt-in.
- Startup recovery scans durable PCM manifests, including the manifest-written/job-not-written crash window. Failed chunks remain teacher-retryable after restart.
- Provider output is bounded before JSON parsing, schema/time/confidence validated, overlap deduplicated, and appended as auditable revisions. Corrected revisions preserve the original final text.
- Local mode accepts loopback only. External mode requires HTTPS, public DNS/IP, server opt-in and the teacher’s per-recording checkbox; redirects and URL credentials are rejected.
- Shared state contains subtitle/status metadata only. Error responses expose stable codes and logs contain no PCM/WAV, transcript text, SDP/ICE, bearer token, nickname or provider API key.
- Deleting raw audio keeps transcript/correction metadata and marks `audio_available=false`; deleting the classroom aborts jobs and removes all state.

## Browser evidence

- Teacher HTTP page shows the per-recording external-transcription consent, realtime subtitle panel, mode label, and trusted-HTTPS audio degradation: `docs/reviews/education-unit6-teacher-http.png`.
- Student HTTP page shows zero microphone/camera capture, disabled audio under HTTP, realtime subtitle panel and `仅课本与板书`: `docs/reviews/education-unit6-student-http.png`.
- `/classroom` now routes to the classroom entry in Vite development rather than the legacy reading SPA.

## Verification

- Focused Unit 6/store/audio/handler/client gate: passed.
- Demo full regression: 111 files / 675 tests passed.
- Demo TypeScript, Biome (379 files) and production build passed.
- Root SDK regression: 14 files / 98 tests passed.
- Root TypeScript, Biome (445 files), production build and Obsidian plugin packaging passed.
- `git diff --check` passed.

## Tier 2 review

Full in-thread review covered correctness, testing, maintainability, project standards, security, performance, API contracts, reliability, adversarial TypeScript and frontend race concerns. Safe fixes applied during review: durable job registration, manifest-only crash recovery, bounded queue, retry UI/idempotency, loopback-only local URL policy, DNS/private-address checks, response-size limit, recording-generation fence, transcript dual-write repair, cross-chunk segment identity and correct multi-failure state projection. No unresolved actionable code finding remains.

## Human acceptance still required

Run the trusted HTTPS classroom with a real loopback provider and verify the fixed WAV/teacher script produces “移项”“两边加九”“完全平方”“正负二”“负一或者负五”, final subtitle P95 ≤ 5 seconds, three students see the same corrected projection, and audio/subtitle failure modes degrade independently. These operational gates are documented in the education classroom validation runbook.

## Next unit

Unit 7 builds one revision-fingerprinted evidence bundle from textbook focus, board events, confirmed formula recognition and final/corrected transcript segments, then migrates student explanations, missed-segment recovery, practice, summaries and teacher `LessonGraph` to that boundary.
