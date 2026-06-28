# Runtime Sync API Contract

## Push Events

`POST /v1/runtime/events:push`

Request:

```json
{
  "schema_version": "inkloop.runtime_sync_batch.v1",
  "device_id": "dev_123",
  "events": []
}
```

Response:

```json
{
  "schema_version": "inkloop.runtime_sync_ack_batch.v1",
  "acks": [
    {
      "event_id": "evt_123",
      "ok": true,
      "ack_id": "ack_123",
      "server_sequence": 42
    }
  ]
}
```

Push must be idempotent by `event_id`. Retrying the same batch must return the same ack or an equivalent dedupe result.

## Pull Events

`GET /v1/runtime/events:pull?device_id=dev_123&cursor=42&limit=50`

Response:

```json
{
  "schema_version": "inkloop.runtime_sync_pull.v1",
  "events": [],
  "next_cursor": "43",
  "has_more": false
}
```

The server returns events after the supplied device cursor in server order. Clients apply the returned events through their local inbox and persist `next_cursor` only after inbox application finishes without conflicts.

If any returned event conflicts with local state, the client must keep its previous cursor and create or surface a conflict record before retrying. This prevents a device from acknowledging unseen or unapplied server events.

## Asset Metadata

`GET /v1/runtime/assets/:asset_id`

Returns asset metadata, authorization state, cache class, content hash, and download URL when allowed.

## Conflict Records

`GET /v1/runtime/conflicts?doc_id=doc_123`

Returns conflicts that could not be applied automatically. Clients should not silently overwrite conflicting local changes.
