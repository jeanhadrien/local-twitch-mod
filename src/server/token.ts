// Twitch OAuth token lifecycle.
// Authorization Code flow access tokens live ~4h; refresh tokens (for
// confidential clients) don't expire and are single-use, so every refresh
// rotates the pair — the new access + refresh tokens are persisted immediately.
import { getSecrets, getSettings, patchSecrets } from "./store";

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/** Refresh proactively once the access token has less than this left. */
const EXPIRY_SKEW_MS = 5 * 60_000;

let refreshInFlight: Promise<string> | null = null;

async function doRefresh(): Promise<string> {
  const settings = getSettings();
  const secrets = getSecrets();
  const clientId = settings.twitch.clientId;
  const clientSecret = secrets.twitch?.clientSecret ?? "";
  const refreshToken = secrets.twitch?.refreshToken ?? "";
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error(
      "cannot refresh Twitch token: client id, client secret, or refresh token missing",
    );
  const res = await fetch(TWITCH_TOKEN_URL, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // no/invalid body — status alone is enough
    }
    throw new Error(`Twitch token refresh failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!json.access_token) throw new Error("Twitch token refresh returned no access_token");
  patchSecrets({
    twitch: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      ...(typeof json.expires_in === "number"
        ? { accessTokenExpiresAt: Date.now() + json.expires_in * 1000 }
        : {}),
    },
  });
  return json.access_token;
}

/**
 * Exchange the stored refresh token for a new access token and persist the
 * rotated pair. Concurrent callers share one in-flight request. Throws when
 * credentials are missing or Twitch rejects the refresh (re-login required).
 */
export async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * True when the stored access token is within `skewMs` of expiring. An unknown
 * expiry returns false — reactive 401 handling covers legacy tokens.
 */
export function isAccessTokenExpiring(skewMs = EXPIRY_SKEW_MS): boolean {
  const exp = getSecrets().twitch?.accessTokenExpiresAt;
  if (typeof exp !== "number") return false;
  return Date.now() >= exp - skewMs;
}

/**
 * The stored access token, refreshed first when it is about to expire. Throws
 * when no token is stored. Safe to call per-message: the common path is a
 * single numeric comparison with no network call.
 */
export async function getFreshAccessToken(): Promise<string> {
  const token = getSecrets().twitch?.accessToken ?? "";
  if (!token) throw new Error("no Twitch access token stored");
  if (!isAccessTokenExpiring()) return token;
  return refreshAccessToken();
}
