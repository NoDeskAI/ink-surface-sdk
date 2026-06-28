import type { OfflineDocumentOpenResult } from '../../offline-store/src/index.js';
import type { RuntimeAnnotation, RuntimeSyncEvent } from '../../runtime-schema/src/index.js';

export const NATIVE_BRIDGE_PROTOCOL_VERSION = 'inksurface.native_bridge.v1' as const;

export type NativeBridgeMutation =
  | {
      operation: 'block.update';
      doc_id: string;
      block_id: string;
      content: string;
    }
  | {
      operation: 'annotation.add';
      doc_id: string;
      block_id: string;
      annotation: Partial<RuntimeAnnotation>;
    }
  | {
      operation: 'annotation.update';
      doc_id: string;
      ko_id: string;
      patch: Record<string, unknown>;
    };

export type NativeBridgeRequest =
  | {
      protocol_version: typeof NATIVE_BRIDGE_PROTOCOL_VERSION;
      request_id: string;
      type: 'document.snapshot.get';
      doc_id: string;
    }
  | {
      protocol_version: typeof NATIVE_BRIDGE_PROTOCOL_VERSION;
      request_id: string;
      type: 'mutation.apply';
      mutation: NativeBridgeMutation;
    }
  | {
      protocol_version: typeof NATIVE_BRIDGE_PROTOCOL_VERSION;
      request_id: string;
      type: 'asset.get';
      doc_id: string;
      asset_id: string;
    }
  | {
      protocol_version: typeof NATIVE_BRIDGE_PROTOCOL_VERSION;
      request_id: string;
      type: 'sync.status.get';
      doc_id?: string;
    };

export interface NativeBridgeDocumentSnapshotPayload {
  doc_id: string;
  open_state: OfflineDocumentOpenResult;
  runtime_snapshot?: unknown;
  pending_events?: RuntimeSyncEvent[];
}

export interface NativeBridgeResponse<TPayload = unknown> {
  protocol_version: typeof NATIVE_BRIDGE_PROTOCOL_VERSION;
  request_id: string;
  ok: boolean;
  payload?: TPayload;
  error?: {
    code: 'unsupported_protocol' | 'invalid_request' | 'not_found' | 'mutation_rejected' | 'offline_asset_missing' | 'internal_error';
    message: string;
  };
}

export interface NativeBridgeValidationIssue {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, issues: NativeBridgeValidationIssue[]): void {
  if (typeof value[key] !== 'string' || value[key] === '') issues.push({ path: key, message: 'must be a non-empty string' });
}

function validateMutation(value: unknown, issues: NativeBridgeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: 'mutation', message: 'must be an object' });
    return;
  }
  requireString(value, 'operation', issues);
  requireString(value, 'doc_id', issues);
  if (value.operation === 'block.update') {
    requireString(value, 'block_id', issues);
    requireString(value, 'content', issues);
  } else if (value.operation === 'annotation.add') {
    requireString(value, 'block_id', issues);
    if (!isRecord(value.annotation)) issues.push({ path: 'mutation.annotation', message: 'must be an object' });
  } else if (value.operation === 'annotation.update') {
    requireString(value, 'ko_id', issues);
    if (!isRecord(value.patch)) issues.push({ path: 'mutation.patch', message: 'must be an object' });
  } else {
    issues.push({ path: 'mutation.operation', message: 'must be a supported mutation operation' });
  }
}

export function validateNativeBridgeRequest(value: unknown): NativeBridgeValidationIssue[] {
  const issues: NativeBridgeValidationIssue[] = [];
  if (!isRecord(value)) return [{ path: '', message: 'must be an object' }];
  if (value.protocol_version !== NATIVE_BRIDGE_PROTOCOL_VERSION) {
    issues.push({ path: 'protocol_version', message: `must be ${NATIVE_BRIDGE_PROTOCOL_VERSION}` });
  }
  requireString(value, 'request_id', issues);
  requireString(value, 'type', issues);

  if (value.type === 'document.snapshot.get') {
    requireString(value, 'doc_id', issues);
  } else if (value.type === 'mutation.apply') {
    validateMutation(value.mutation, issues);
  } else if (value.type === 'asset.get') {
    requireString(value, 'doc_id', issues);
    requireString(value, 'asset_id', issues);
  } else if (value.type !== 'sync.status.get') {
    issues.push({ path: 'type', message: 'must be a supported bridge request type' });
  }

  return issues;
}

export function isNativeBridgeRequest(value: unknown): value is NativeBridgeRequest {
  return validateNativeBridgeRequest(value).length === 0;
}

export function bridgeSuccess<TPayload>(request: NativeBridgeRequest, payload: TPayload): NativeBridgeResponse<TPayload> {
  return {
    protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
    request_id: request.request_id,
    ok: true,
    payload,
  };
}

export function bridgeError(
  requestId: string,
  code: NonNullable<NativeBridgeResponse['error']>['code'],
  message: string,
): NativeBridgeResponse {
  return {
    protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
    request_id: requestId,
    ok: false,
    error: { code, message },
  };
}
