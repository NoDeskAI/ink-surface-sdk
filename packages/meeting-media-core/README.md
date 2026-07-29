# Meeting Media Core

`@inksurface/meeting-media-core` contains the platform-neutral contracts and pure state transitions for InkLoop meeting capture.

It owns:

- meeting session lifecycle and auditable immediate stop after a confirmed platform end signal;
- immutable Mic / Remote audio chunk identity;
- persisted delivery state, acknowledgement validation, and ordered resume queues;
- sealed per-track sequence manifests so the server can derive internal gaps instead of trusting a caller-supplied missing list;
- stable provisional utterance revisions and formal/partial transcript convergence.

It does not own macOS or Windows capture APIs, filesystem writes, network transports, ASR vendor SDKs, AEC implementations, or product UI. Platform adapters and cloud services consume these contracts.

Weak observations such as window blur, application backgrounding, silence, or network loss are not valid confirmed meeting-end signals.
