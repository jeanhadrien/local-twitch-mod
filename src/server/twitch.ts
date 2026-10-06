// Twitch integration: OAuth login helpers + tmi.js chat ingest.
import { Client } from "tmi.js";

const TWITCH_AUTH = "https://id.twitch.tv/oauth2";

export function redirectUri(port: number): string {
  return `http://localhost:${port}/auth/callback`;
}

export function loginUrl(clientId: string, port: number): string {
  const q = new URLSearchParams({
    client_id: clientId,
    force_verify: "false",
    redirect_uri: redirectUri(port),
    response_type: "code",
    scope: [
      "chat:read",
      "chat:edit",
      "moderator:manage:chat_messages",
      "moderator:manage:banned_users",
      "moderator:manage:warnings",
    ].join(" "),
  });
  return `${TWITCH_AUTH}/authorize?${q}`;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  port: number,
): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetch(`${TWITCH_AUTH}/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(port),
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return (await res.json()) as { access_token: string; refresh_token?: string };
}

export async function getCurrentUser(
  accessToken: string,
  clientId: string,
): Promise<{ id: string; login: string }> {
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
  });
  if (!res.ok) throw new Error(`Helix /users failed (${res.status})`);
  const json = (await res.json()) as { data?: Array<{ id: string; login: string }> };
  const u = json.data?.[0];
  if (!u) throw new Error("Helix /users returned no user");
  return { id: u.id, login: u.login };
}

// --- Stream id tracking ---
// Every logged chat/verdict entry is scoped to a stream id: the real Twitch
// stream id when live, else one sticky `local-<ms>` id per chat session.

const HELIX_STREAMS = "https://api.twitch.tv/helix/streams";
const STREAM_ID_TTL_MS = 60_000;

let currentStreamId: string | null = null;
let streamIdFetchedAt = 0;
// Bumped on every (re)connect/teardown so in-flight lookups can't write into a new session.
let streamSession = 0;
let streamClientId = "";
let streamToken = "";
let streamChannel = "";

function localStreamId(): string {
  return `local-${Date.now()}`;
}

/** Current stream id (real Twitch id or local session id); null before any connect. */
export function getCurrentStreamId(): string | null {
  return currentStreamId;
}

/** Id for tagging a live message; mints a local id if this session has none yet. */
export function getStreamIdForMessage(): string {
  return currentStreamId ?? (currentStreamId = localStreamId());
}

/** Helix GET /streams → live stream id, or null (offline/any failure). Never throws. */
export async function fetchStreamId(
  clientId: string,
  token: string,
  channelLogin: string,
): Promise<string | null> {
  try {
    const q = new URLSearchParams({ user_login: normalizeChannel(channelLogin) });
    const res = await fetch(`${HELIX_STREAMS}?${q}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const id = json.data?.[0]?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Begin stream tracking for a successful chat connect: mint a local id now
 * (so entries are never null) and upgrade it to the real Helix id if live.
 * A reconnect bumps the session and mints a fresh local id.
 */
export function beginStreamSession(clientId: string, token: string, channel: string): void {
  streamSession++;
  streamClientId = clientId;
  streamToken = token;
  streamChannel = normalizeChannel(channel);
  currentStreamId = localStreamId();
  streamIdFetchedAt = Date.now();
  const session = streamSession;
  void fetchStreamId(clientId, token, streamChannel).then((real) => {
    if (session !== streamSession) return;
    if (real) currentStreamId = real;
    // No real id → keep the minted local id (sticky; never re-minted mid-session).
  });
}

/**
 * Refresh the cached id from Helix if the TTL elapsed. Fire-and-forget: callers
 * tag entries with the current (possibly stale) id meanwhile. Never mints a new
 * local id — only upgrades a local id to a real one.
 */
export function refreshStreamIdIfStale(): void {
  if (!streamChannel) return;
  if (Date.now() - streamIdFetchedAt < STREAM_ID_TTL_MS) return;
  streamIdFetchedAt = Date.now(); // claim the slot to avoid a fetch stampede
  const session = streamSession;
  void fetchStreamId(streamClientId, streamToken, streamChannel).then((real) => {
    if (session !== streamSession) return;
    if (real) currentStreamId = real;
  });
}

// --- Chat ingest (singleton tmi.js client) ---

export interface ChatMsg {
  user: string;
  userId: string;
  text: string;
  msgId: string;
}

type Handler = (msg: ChatMsg) => void;

let client: Client | null = null;
let connectedChannel = "";
let connected = false;
// Serialize (re)connects: concurrent "start" clicks must never create two live clients.
let connecting: Promise<void> | null = null;

function normalizeChannel(channel: string): string {
  return channel.replace(/^#/, "").toLowerCase();
}

export function chatStatus(): { connected: boolean; channel: string } {
  return { channel: connectedChannel, connected };
}

export async function connectChat(opts: {
  username: string;
  token: string;
  clientId: string;
  channel: string;
  onMessage: Handler;
}): Promise<void> {
  const channel = normalizeChannel(opts.channel);
  if (connecting) {
    // Another start is already in flight — wait for it, then reuse it.
    try {
      await connecting;
    } catch {
      // Earlier attempt failed; fall through and retry below.
    }
    if (connected && connectedChannel === channel) return;
  } else if (connected && connectedChannel === channel) {
    return; // Already joined — repeated Start is a no-op (re-click safe).
  }
  const run = (async () => {
    await disconnectChat();
    client = new Client({
      channels: [channel],
      connection: { reconnect: true, secure: true },
      identity: { password: `oauth:${opts.token}`, username: opts.username },
    });
    client.on("message", (_chan, tags, message, self) => {
      if (self) return;
      opts.onMessage({
        msgId: (tags["id"] as string) ?? `${Date.now()}`,
        text: message,
        user: tags["display-name"] ?? tags["username"] ?? "unknown",
        userId: (tags["user-id"] as string) ?? "",
      });
    });
    await client.connect();
    connected = true;
    connectedChannel = channel;
    beginStreamSession(opts.clientId, opts.token, channel);
  })();
  connecting = run;
  try {
    await run;
  } finally {
    if (connecting === run) connecting = null;
  }
}

export async function disconnectChat(): Promise<void> {
  if (client) {
    try {
      await client.disconnect();
    } catch {
      // ignore teardown errors
    }
  }
  client = null;
  connected = false;
  streamSession++;
  currentStreamId = null;
  streamChannel = "";
  streamIdFetchedAt = 0;
}
