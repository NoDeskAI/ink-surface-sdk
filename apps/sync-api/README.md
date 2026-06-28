# InkSurface Sync API Boundary

This directory documents the future production backend boundary for cross-device InkSurface runtime sync. It is a contract fixture, not a deployed service in this repository.

The backend owns:

- authenticated device registration
- append-only runtime event log
- per-device cursors
- per-event acknowledgements
- conflict records
- asset metadata and authorization
- cloud API adapter jobs

Clients still own local stores, caches, local file adapters, and immediate offline mutation behavior.
