import {
  fetchFeishuBotWorkspaceMembers,
  fetchFeishuBotWorkspaces,
  type FeishuBotImEnv,
  type FeishuBotWorkspace,
  type FeishuBotWorkspaceMember,
} from './feishu-bot-im';

export interface FeishuTeamAccessOptions {
  env?: FeishuBotImEnv;
  userOpenId?: string | null;
  pageSize?: number;
}

export interface FeishuTeamAccessGroup {
  chat_id: string;
  name: string;
  chat_status: string;
  member_name?: string;
}

export interface FeishuTeamAccessResult {
  connected: boolean;
  configured: boolean;
  source: 'feishu_team_access';
  auth_mode: 'tenant_access_token';
  identity_connected: boolean;
  user_open_id?: string;
  groups: FeishuTeamAccessGroup[];
  accessible_chat_ids: string[];
  errors: Array<{ source: string; code: string; message: string; permission_url?: string; required_scope?: string }>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameOpenId(left: unknown, right: unknown): boolean {
  const a = text(left);
  const b = text(right);
  return !!a && !!b && a === b;
}

function memberForUser(members: FeishuBotWorkspaceMember[], userOpenId: string): FeishuBotWorkspaceMember | undefined {
  return members.find((member) => sameOpenId(member.open_id, userOpenId));
}

function groupFromWorkspace(workspace: FeishuBotWorkspace, member?: FeishuBotWorkspaceMember): FeishuTeamAccessGroup {
  return {
    chat_id: workspace.chat_id,
    name: workspace.name,
    chat_status: workspace.chat_status,
    ...(member?.name ? { member_name: member.name } : {}),
  };
}

export async function fetchFeishuTeamAccess(options: FeishuTeamAccessOptions = {}): Promise<FeishuTeamAccessResult> {
  const userOpenId = text(options.userOpenId);
  const errors: FeishuTeamAccessResult['errors'] = [];
  const workspaces = await fetchFeishuBotWorkspaces({ env: options.env, pageSize: options.pageSize });
  if (workspaces.error) {
    errors.push({
      source: 'bot_im',
      code: workspaces.error.code,
      message: workspaces.error.message,
      permission_url: workspaces.error.permission_url,
      required_scope: workspaces.error.required_scopes?.join(','),
    });
  }
  if (!userOpenId) {
    return {
      connected: !!workspaces.connected,
      configured: !!workspaces.configured,
      source: 'feishu_team_access',
      auth_mode: 'tenant_access_token',
      identity_connected: false,
      groups: [],
      accessible_chat_ids: [],
      errors,
    };
  }

  const groups: FeishuTeamAccessGroup[] = [];
  for (const workspace of workspaces.workspaces.filter((item) => item.chat_status === 'normal').slice(0, 50)) {
    const members = await fetchFeishuBotWorkspaceMembers(workspace.chat_id, { env: options.env, pageSize: 100 });
    if (members.error) {
      errors.push({
        source: 'bot_im_members',
        code: members.error.code,
        message: members.error.message,
        permission_url: members.error.permission_url,
        required_scope: members.error.required_scopes?.join(','),
      });
      continue;
    }
    const matched = memberForUser(members.members, userOpenId);
    if (matched) groups.push(groupFromWorkspace(workspace, matched));
  }

  return {
    connected: !!workspaces.connected,
    configured: !!workspaces.configured,
    source: 'feishu_team_access',
    auth_mode: 'tenant_access_token',
    identity_connected: true,
    user_open_id: userOpenId,
    groups,
    accessible_chat_ids: groups.map((group) => group.chat_id),
    errors,
  };
}
