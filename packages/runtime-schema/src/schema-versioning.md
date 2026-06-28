# Runtime Schema Versioning

Runtime records use explicit `schema_version` strings. Hosts must reject or quarantine records whose schema version is newer than the host can migrate.

Current MVP versions:

```text
inkloop.runtime_sync_event.v1
inkloop.surface_object.v1
```

Forward-compatible fields may be preserved as unknown object keys. Breaking changes require a new schema version and a migration path before local mutations are applied.
