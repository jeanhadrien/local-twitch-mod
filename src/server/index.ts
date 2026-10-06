// Express backend: API + static frontend + live pipeline wiring.
import cors from "cors";
import express from "express";
import * as path from "path";
import { handleLiveMessage } from "./routes";
import { registerRoutes } from "./routes";
import { getSecrets, getSettings, seedIfMissing } from "./store";
import { chatStatus, connectChat } from "./twitch";

const PORT = Number(process.env.PORT ?? 3000);

seedIfMissing();

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

registerRoutes(app);

// Serve the Vite frontend build (if present) + SPA fallback.
const webDist = path.join(process.cwd(), "dist");
app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(200).send("klawz-chat-ai API running — build the web UI with `npm run build:web`.");
  });
});

app.listen(PORT, () => {
  console.log(`Mod bot listening on http://localhost:${PORT} (dryRun=${getSettings().dryRun})`);
  void autoConnect();
});

// Best-effort auto-join on boot when channel + token are already stored.
async function autoConnect(): Promise<void> {
  try {
    const settings = getSettings();
    const secrets = getSecrets();
    if (!settings.channel || !secrets.twitch?.accessToken || !secrets.twitch?.login) {
      console.log("Auto-connect skipped: set channel + Twitch login first (Setup page).");
      return;
    }
    if (chatStatus().connected) return;
    await connectChat({
      channel: settings.channel,
      onMessage: (msg) => void handleLiveMessage(msg.user, msg.text, msg.msgId, msg.userId),
      token: secrets.twitch.accessToken,
      username: secrets.twitch.login,
    });
    console.log(`Joined #${settings.channel} as ${secrets.twitch.login}`);
  } catch (err) {
    console.warn("Auto-connect failed:", err instanceof Error ? err.message : err);
  }
}
