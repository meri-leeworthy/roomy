export interface SessionData {
  did: string;
  accessToken: string;
  refreshToken: string;
  handle: string;
  expiresAt: string;
  passphrase?: string;
}

export interface OAuthConfig {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: [string, ...string[]];
  scope: string;
  handleResolver: string;
}

export interface MessageOptions {
  threadId?: string;
  replyTo?: string;
  embeds?: Array<{ type: 'imageUrl'; url: string }>;
}