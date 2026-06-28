# Adapter Contracts

`packages/adapter-contracts` makes adapter placement explicit.

Client-local adapters need user device permissions or local files, such as Obsidian vaults, local PDFs, iOS Files, Android SAF, and desktop folders. Cloud API adapters can run on the backend, such as Notion-style or Readwise-style integrations. Hybrid adapters declare which operations belong to each side.

Public SDK consumers should import it from the root package subpath:

```ts
import { OBSIDIAN_FS_ADAPTER_AUTHORITY } from 'ink-surface-sdk/adapter-contracts';
```
