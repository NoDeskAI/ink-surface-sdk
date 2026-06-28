# Security And Privacy Contract

- Every request requires authenticated device identity.
- Authorization is checked per document and per asset.
- Logs should include request ids, event ids, device ids, status, and timings, but not full document bodies, OCR text, raw strokes, or PDF bytes by default.
- Unsupported schema versions are rejected with structured errors before events are accepted.
- Revoked document access prevents future event pulls and asset downloads for that device.
- Production deployment must define encryption at rest, retention, deletion, and optional end-to-end encryption before real user content is synced.
