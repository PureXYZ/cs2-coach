import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.js";

const STORE_FILE = process.env.GOAL_STORE_FILE ?? "state/goal.json";

/**
 * The one focus the player asked to be held to this session — set via /coach
 * goal (or /focus) and read back into the LLM prompt at the right moments. Tiny
 * and robust by design: a corrupt or missing file just means "no goal", never a
 * crash, mirroring SessionStore's fs discipline (state/ is a Docker volume on
 * the hosted deploy, so the goal survives restarts).
 */
export class GoalStore {
  private goal: string | undefined;

  constructor(private readonly file = STORE_FILE) {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (parsed && typeof parsed === "object" && typeof parsed.goal === "string") this.goal = parsed.goal;
      }
    } catch (err) {
      log.warn("goal", `Could not read ${this.file} — no goal set (${err instanceof Error ? err.message : err})`);
      this.goal = undefined;
    }
  }

  get(): string | undefined {
    return this.goal;
  }

  set(goal: string | undefined): void {
    this.goal = goal;
    // Empty string clears too — the bot already normalises "" to undefined, but be defensive.
    const payload = goal ? { goal, setAt: new Date().toISOString() } : {};
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      log.warn("goal", `Could not persist goal: ${err instanceof Error ? err.message : err}`);
    }
  }
}
