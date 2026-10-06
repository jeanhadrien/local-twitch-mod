# Twitch setup — Client ID & Client Secret

How to create the Twitch application credentials this bot needs to read chat
and delete messages. Takes ~5 minutes.

> **Log in with the right account.** Do these steps logged in as the Twitch
> account the bot will act as. That account must be a **moderator** (or the
> broadcaster) of the channel you want to moderate — otherwise deletes will
> fail with a 403.

## 1. Open the Twitch developer console

Go to <https://dev.twitch.tv/console> and log in if asked.

## 2. Register an application

1. Click **Applications → Register Your Application**.
2. Fill in:
   - **Name:** anything, e.g. `klawz-chat-mod-local`
   - **OAuth Redirect URLs:** `http://localhost:3000/auth/callback`
     - Must match exactly, including the port. If you run the bot on a
       different port (`PORT=...`), use that port here instead.
   - **Category:** `Chat Bot` (or closest match)
   - **Client Type:** `Confidential`
3. Click **Create**.

## 3. Copy the Client ID, generate the Secret

1. Click **Manage** on your new application.
2. Copy the **Client ID**.
3. Under **Client Secret**, click **New Secret** and copy it immediately —
   Twitch shows it **only once**. If you lose it, you can generate a new one
   (the old one stops working).

## 4. Wire it into the bot

1. Open the bot UI at `http://localhost:3000` → **Setup** tab.
2. Paste **Client ID** and **Client Secret**, set your **channel name**
   (without `#`), and click **Save**.
3. Click **Twitch login**, authorize the requested scopes, and confirm the
   Setup page shows you as logged in.

## Scopes the bot requests (and why)

| Scope | Used for |
|---|---|
| `chat:read` | Reading live chat |
| `chat:edit` | Chat identity via IRC |
| `moderator:manage:chat_messages` | **Deleting** messages (MVP enforcement) |
| `moderator:manage:banned_users` | Timeouts/bans (stubbed in MVP, requested now so you don't re-auth later) |

## Troubleshooting

- **`redirect_mismatch` during login:** the redirect URL in the Twitch console
  doesn't exactly match `http://localhost:<port>/auth/callback`. Fix it in
  the console (step 2) — no code change needed.
- **Deletes fail / 403:** the logged-in account is not a moderator of the
  target channel. Make it a mod (`/mod <username>` in the channel as the
  broadcaster), then log in again.
- **Lost the Client Secret:** console → Manage → **New Secret**, then update
  it in the Setup page. The previous secret is invalidated.
- **Login expires:** tokens eventually expire — click **Twitch login** again
  to re-authorize.
