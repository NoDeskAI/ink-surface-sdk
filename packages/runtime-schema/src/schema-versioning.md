# Runtime Schema Versioning

Runtime records use explicit `schema_version` strings. Hosts must reject or quarantine records whose schema version is newer than the host can migrate.

Current MVP versions:

```text
inkloop.runtime_sync_event.v1
inkloop.surface_object.v1
```

Supported runtime sync operations in `inkloop.runtime_sync_event.v1`:

- `runtime.bootstrap` cold-starts a host with a full runtime snapshot.
- `block.update` patches editable block text.
- `annotation.add`, `annotation.update`, and `annotation.delete` mutate annotation state.
- `knowledge.update` applies controlled KnowledgeObject field edits from projection hosts such as Obsidian.
- `canvas.node.add` and `canvas.node.delete` mutate free canvas objects.
- `progress.update` persists reading progress.
- `source.rename` preserves stable document identity while updating source path metadata.

`origin.device_id` is optional for backward-compatible local events but required when present. Hosts should include it for new runtime sync events so inboxes can suppress echo and diagnose duplicate delivery.

Forward-compatible fields may be preserved as unknown object keys. Breaking changes require a new schema version and a migration path before local mutations are applied.
