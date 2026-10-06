// SSE fan-out hub for the Live page (chat messages + verdicts).
import type { Response } from "express";

const clients = new Set<Response>();

export function sseSubscribe(res: Response): () => void {
  clients.add(res);
  return () => {
    clients.delete(res);
  };
}

export function broadcast(type: string, data: unknown): void {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// Keep proxies / EventSource connections alive.
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(": ping\n\n");
    } catch {
      clients.delete(res);
    }
  }
}, 25000).unref();
