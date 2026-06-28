# Offline State Matrix

| Local State | Open Behavior |
|---|---|
| App shell bundled, metadata cached, surface cached, assets cached | Open fully offline. Reading and local mutations are enabled. |
| App shell bundled, metadata cached, surface cached, large asset missing | Open in partial state. Reading, notes, and local mutations stay enabled; the missing asset shows a recoverable state. |
| App shell bundled, metadata cached, surface missing | Do not open the document surface. Show download-required state. |
| Pending local mutations exist | Never evict the document or outbox. Render local state and sync later. |
| Cached runtime schema is newer than host support | Enter migration-required state before applying any mutation. |
