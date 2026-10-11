/** Browser projection only; no credentials, worker state or execution scopes. */
export interface WebConversation {
  id: string;
  team: string;
  channel: string;
  thread: string | null;
  name: string;
  scope: "private" | "shared";
  audience: string;
  slackUrl: string;
}

export interface WebMessage {
  id: string;
  author: { id: string; name: string; june: boolean };
  origin: "Slack";
  timestamp: string;
  text: string;
  truncated: boolean;
  edited: boolean;
  replyCount: number;
  files: { id: string; name: string; type: string }[];
}

export interface WebConversationList {
  conversations: WebConversation[];
  next: number | null;
  observedAt: string;
  limited: boolean;
}

export interface WebTranscript {
  conversation: WebConversation;
  messages: WebMessage[];
  next: string | null;
  more: boolean;
  limited: boolean;
  observedAt: string;
}
