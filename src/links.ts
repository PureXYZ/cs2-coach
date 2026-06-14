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

  constructor(private readonly stateFile = STATE_FILE) {
    const saved = loadJsonState<StoredLinks>(this.stateFile, "links", (raw) => {
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

  /** Every pairing on file, newest-linked first — a read-only snapshot for the
   *  owner-only `/coachadmin links` view. The SteamID64 is the canonical key. */
  list(): Array<{ steam64: string; discordId: string; steamName?: string; linkedAt: number }> {
    return [...this.bySteam.entries()]
      .map(([steam64, rec]) => ({ steam64, ...rec }))
      .sort((a, b) => b.linkedAt - a.linkedAt);
  }

  /**
   * Remove a single SteamID64 pairing (owner-only `/coachadmin link remove`). Returns
   * whether a pairing existed. Repairs the reverse map: byDiscord holds ONE steam64 per
   * Discord id, so if it pointed at the removed account, re-point it to the newest OTHER
   * account still linked to that same Discord user (an alt) — or drop the entry when none
   * remains. Persists only when something changed. (record() never deletes, so this and
   * removeAllForDiscord below are the only paths that prune the reverse map.)
   */
  remove(steam64: string): boolean {
    const rec = this.bySteam.get(steam64);
    if (!rec) return false;
    this.bySteam.delete(steam64);
    if (this.byDiscord.get(rec.discordId) === steam64) {
      let survivor: { steam64: string; linkedAt: number } | undefined;
      for (const [sid, r] of this.bySteam) {
        if (r.discordId !== rec.discordId) continue;
        if (!survivor || r.linkedAt > survivor.linkedAt) survivor = { steam64: sid, linkedAt: r.linkedAt };
      }
      if (survivor) this.byDiscord.set(rec.discordId, survivor.steam64);
      else this.byDiscord.delete(rec.discordId);
    }
    this.persist();
    return true;
  }

  /** Remove EVERY pairing for a Discord user (their main + any alt SteamID64s), and
   *  drop the reverse-map entry. Returns how many were removed. Owner-only
   *  `/coachadmin link remove <user>`. Persists only when something changed. */
  removeAllForDiscord(discordId: string): number {
    let removed = 0;
    for (const [sid, r] of [...this.bySteam]) {
      if (r.discordId !== discordId) continue;
      this.bySteam.delete(sid);
      removed++;
    }
    if (removed > 0) {
      this.byDiscord.delete(discordId);
      this.persist();
    }
    return removed;
  }

  private persist(): void {
    const obj: StoredLinks = {};
    for (const [steam64, rec] of this.bySteam) obj[steam64] = rec;
    saveJsonState(this.stateFile, "links", obj);
  }
}
