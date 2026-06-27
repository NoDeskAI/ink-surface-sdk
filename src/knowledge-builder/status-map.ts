import type { KnowledgeStatus } from '../knowledge/knowledge-object';

export function mapOverlayStateToKnowledgeStatus(overlayState: string | undefined): KnowledgeStatus | null {
  switch (overlayState) {
    case 'shown':
      return 'export_ready';
    case 'accepted':
      return 'accepted';
    case 'edited':
      return 'edited';
    case 'dismissed':
      return 'dismissed';
    case 'folded':
      return null;
    default:
      return 'inbox';
  }
}
