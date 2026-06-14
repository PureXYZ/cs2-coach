import { loadJsonState, saveJsonState } from "./json-state.js";

/**
 * Maps a player's in-game SteamID64 to the Discord user who installed their GSI
 * cfg. The pairing arrives for free: `/coach setup` bakes the invoker's Discord id
 * into the cfg's auth block (src/gsi/cfg.ts), CS2 echoes EVERY auth key back in
 * every payload, and the GSI server reads it alongside provider.steamid (the
 * in-game identity). index.ts feeds both into record() on each payload.
 *
 * Persisted like the other small bits of cross-restart state (a JSON file under
 * state/, a Docker volume on the hosted deploy) — see json-state.ts. The store is
 * the authoritative steam64 -> Discord direction; the reverse map is a best-effort
 * "the Discord user's most-recently-seen Steam account" (an alt account just adds
 * another forward entry).
 *
 * NOTE: the Discord id is SELF-ASSERTED — anyone who can edit their own cfg could
 * claim any id. It's fine as a convenience pairing (the cfg is private to each
 * friend), but it is NOT cryptographic proof of Discord account ownership; don't
 * gate anything security-sensitive on it.
 */

// Discord snowflakes are 17–20 digit numeric strings. A feed POSTing anything else
// under auth.discordId (a griefer on the shared token, a hand-edited cfg) is ignored.
export const DISCORD_ID_RE = /^\d{17,20}$/;

const STATE_FILE = process.env.LINKS_STATE_FILE ?? "state/links.json";

export interface SteamDiscordLink {
  /** The Discord user id this Steam account is paired to. */
  discordId: string;
  /** Steam persona name last seen on this feed's own-player block — for readable
   *  logs/status only; the SteamID64 is the canonical key (personas change). */
  steamName?: string;
  /** Epoch ms the pairing was first recorded, or last changed to a new Discord id. */
  linkedAt: number;
}

/** Persisted shape: a plain object keyed by SteamID64. */
type StoredLinks = Record<string, SteamDiscordLink>;

export class LinkStore {
  private bySteam = new Map<string, SteamDiscordLink>();
  private byDiscord = new Map<string, string>(); // discordId -> steam64 (latest seen)

  constructor() {
    const saved = loadJsonState<StoredLinks>(STATE_FILE, "links", (raw) => {
      if (!raw || typeof raw !== "object") return null;
      const out: StoredLinks = {};
      for (const [steam64, v] of Object.entries(raw as Record<string, unknown>)) {
        const rec = v as Partial<SteamDiscordLink>;
        if (typeof rec?.discordId === "string" && typeof rec?.linkedAt === "number") {
          out[steam64] = {
            discordId: rec.discordId,
            steamName: typeof rec.steamName === "string" ? rec.steamName : undefined,
            linkedAt: rec.linkedAt,
          };
        }
      }
      return out;
    });
    if (saved) {
      for (const [steam64, rec] of Object.entries(saved)) {
        this.bySteam.set(steam64, rec);
        this.byDiscord.set(rec.discordId, steam64);
      }
    }
  }

  /**
   * Record (or refresh) a SteamID64 <-> Discord-id pairing observed in a payload's
   * auth block. Persists to disk ONLY when something actually changed — the game
   * POSTs ~10x/second and this runs on every payload, so a no-op rewrite each time
   * would thrash the volume. Returns true when a write happened (a new/changed
   * pairing, or a refreshed Steam name) — the caller logs that as a one-off line.
   */
  record(steam64: string, discordId: string, steamName?: string): boolean {
    const existing = this.bySteam.get(steam64);
    const pairingChanged = !existing || existing.discordId !== discordId;
    const nameChanged = steamName !== undefined && existing?.steamName !== steamName;
    // Keep the reverse pointer current even on a no-op (cheap, in-memory only).
    this.byDiscord.set(discordId, steam64);
    if (!pairingChanged && !nameChanged) return false;

    const rec: SteamDiscordLink = {
      discordId,
      steamName: steamName ?? existing?.steamName,
      // Stamp the time only when the pairing itself is new/changed; a pure name
      // refresh keeps the original link time.
      linkedAt: pairingChanged ? Date.now() : existing!.linkedAt,
    };
    this.bySteam.set(steam64, rec);
    this.persist();
    return true;
  }

  /** The Discord user paired to this in-game SteamID64, if known. */
  discordIdFor(steam64: string): string | undefined {
    return this.bySteam.get(steam64)?.discordId;
  }

  /** The most-recently-seen Steam account for a Discord user, if known. */
  steam64For(discordId: string): string | undefined {
    return this.byDiscord.get(discordId);
  }

  /** Full link record for a SteamID64 (Discord id + cached persona + link time). */
  linkFor(steam64: string): SteamDiscordLink | undefined {
    return this.bySteam.get(steam64);
  }

  /** How many Steam<->Discord pairings are on file. */
  get size(): number {
    return this.bySteam.size;
  }

  private persist(): void {
    const obj: StoredLinks = {};
    for (const [steam64, rec] of this.bySteam) obj[steam64] = rec;
    saveJsonState(STATE_FILE, "links", obj);
  }
}
