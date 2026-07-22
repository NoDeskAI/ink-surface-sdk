# Education Classroom Phase 3 — Unit 5 One-Way Audio

## Outcome

Unit 5 implementation is complete for the two-Web classroom: explicit teacher-only microphone capture, teacher-to-student WebRTC audio, bearer-scoped ephemeral signaling, independent raw PCM recording, recording recovery/deletion, HTTP degradation, and a same-origin HTTPS launcher. Its plan checkbox remains open until trusted-certificate, real microphone, three-student playback and LAN P95 human acceptance are recorded.

## Security and lifecycle evidence

- Student code never calls `getUserMedia`; fake WebRTC tests prove it only creates an answer for the current negotiation generation.
- Teacher peers add only `getAudioTracks()` and create offers with video reception disabled.
- Signaling is role/direction scoped, participant isolated, TTL bounded, non-persistent, and filters stale negotiation generations.
- PCM chunks are format/time/size/generation validated and idempotent. Gaps or upload failures become `incomplete` rather than a false healthy result.
- AudioWorklet flushes the final partial chunk before stop, and stop waits for the upload chain.
- Process reopen marks an active recording `interrupted / incomplete` exactly once. Classroom deletion removes the audio directory and rejects late writes.
- Shared timeline records recording lifecycle or health transitions only; it contains no PCM, base64, SDP or ICE payloads.

## Browser evidence

- Headed HTTP teacher page: audio control disabled with “当前是 HTTP 开发入口 · 音频需受信任 HTTPS”. Screenshot: `docs/reviews/education-unit5-teacher-http.png`.
- Headed student page: clearly states it only receives teacher audio and will not request microphone/camera; its HTTP audio button is disabled with the same trusted-HTTPS requirement. Screenshot: `docs/reviews/education-unit5-student-join.png`.
- HTTPS launcher, teacher page, static assets, health endpoint and classroom API respond from one origin. Automated browser navigation stopped at `ERR_CERT_AUTHORITY_INVALID`, as expected until the locally generated certificate is explicitly trusted in macOS Keychain. Real microphone permission, acoustic playback and LAN P95 remain a human acceptance item after trust installation.

## Verification

- Focused audio/client/store/service/handler/static gate: 6 files / 40 tests passed; TypeScript, Biome and production build passed.
- Demo full regression: 109 files / 664 tests passed.
- Root SDK regression: 14 files / 97 tests passed.
- Root TypeScript check, Biome (`440` files, zero warnings), production build and Obsidian plugin packaging passed.
- `git diff --check` passed. Final response-path review found no debug logging and confirmed errors expose stable error codes only, not PCM/base64, SDP/ICE, bearer credentials or nicknames.

## Remaining Phase 3 work

Unit 6 adds the local-first transcription provider, provisional/final/corrected subtitles and explicit `audio_with_subtitles / subtitles_only / textbook_board_only` degradation modes. Unit 5 does not add video, student capture, TURN or public remote-class infrastructure.
