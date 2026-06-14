import http from "node:http";
import { log } from "../log.js";
import type { GsiPayload } from "./types.js";

export interface GsiServerOptions {
  port: number;
  /** Shared secret from the cfg's auth block. Empty string disables the check. */
  token: string;
  onPayload: (payload: GsiPayload) => void;
}

export interface GsiServerHandle {
  server: http.Server;
  /** ms since the last authenticated payload, or null if none received yet. */
  lastPayloadAgeMs: () => number | null;
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * Receives CS2's GSI POSTs. The game holds back the next POST until the previous
 * one gets a 2XX, so we always respond 200 immediately and process asynchronously.
 */
export function startGsiServer(opts: GsiServerOptions): GsiServerHandle {
  let lastPayloadAt: number | null = null;
  let warnedBadToken = false;
  let warnedBadShape = false;

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          lastPayloadAgeMs: lastPayloadAt === null ? null : Date.now() - lastPayloadAt,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      // Respond before processing so the game can send the next update right away.
      res.writeHead(200).end();

      let payload: GsiPayload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        log.warn("gsi", "Received POST with invalid JSON — ignoring");
        return;
      }

      // Cheap runtime shape guard on the hot fields the rules read. JSON.parse is
      // assigned straight to a typed GsiPayload, so a malformed POST (round:"5")
      // would type-confuse downstream logic ("5" + 1 → "51"). Drop the frame if a
      // present field is the wrong type. We don't deep-walk weapons — weapon-name
      // safety lives in the tracker.
      if (
        (payload.map?.round !== undefined && typeof payload.map.round !== "number") ||
        (payload.player?.state?.health !== undefined && typeof payload.player.state.health !== "number") ||
        (payload.map?.team_ct?.score !== undefined && typeof payload.map.team_ct.score !== "number") ||
        (payload.map?.team_t?.score !== undefined && typeof payload.map.team_t.score !== "number")
      ) {
        if (!warnedBadShape) {
          warnedBadShape = true;
          log.warn(
            "gsi",
            "Received payload with malformed hot fields (wrong type for round/health/score) — dropping frame (warning shown once)",
          );
        }
        return;
      }

      if (opts.token && payload.auth?.token !== opts.token) {
        if (!warnedBadToken) {
          warnedBadToken = true;
          log.warn(
            "gsi",
            "Received payload with missing/wrong auth token — check that GSI_TOKEN matches the token in gamestate_integration_coach.cfg (warning shown once)",
          );
        }
        return;
      }

      lastPayloadAt = Date.now();
      setImmediate(() => {
        try {
          opts.onPayload(payload);
        } catch (err) {
          log.error("gsi", "Payload handler threw", err);
        }
      });
    });

    req.on("error", (err) => log.error("gsi", "Request error", err));
  });

  // listen() reports failures (e.g. EADDRINUSE) async via 'error' — without a
  // listener that's an uncaught exception with a raw stack trace.
  server.on("error", (err) => {
    log.error("gsi", `GSI server failed to listen on port ${opts.port} (is another instance running?)`, err);
    process.exit(1);
  });

  if (opts.token === "") {
    log.warn(
      "gsi",
      "GSI_TOKEN is empty — accepting UNAUTHENTICATED game state from any host on 0.0.0.0. Set GSI_TOKEN for a public/VPS deployment so only your CS2 client can post.",
    );
  }

  // Bind to all interfaces — the gaming PC POSTs to this coach over the network,
  // and the preferred deployment is a public/VPS host (not just the LAN).
  server.listen(opts.port, "0.0.0.0", () => {
    log.info("gsi", `Listening for CS2 game state on http://0.0.0.0:${opts.port}`);
  });

  return {
    server,
    lastPayloadAgeMs: () => (lastPayloadAt === null ? null : Date.now() - lastPayloadAt),
  };
}
