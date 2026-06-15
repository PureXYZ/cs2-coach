/**
 * One-off latency benchmark for the coach's LLM tiers: `npx tsx scripts/bench-llm.ts`
 * Replays a realistic freezetime request against candidate model/effort configs.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { ECONOMY_CHEATSHEET, DECISION_PRINCIPLES, mapBriefing } from "../src/coach/knowledge.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const system =
  `You are "Coach" — a dry, sarcastic, perpetually unimpressed Counter-Strike 2 coach. Reply with ONE spoken coaching line, max 28 words, no preamble, no markdown.\n\n` +
  ECONOMY_CHEATSHEET +
  "\n\n" +
  DECISION_PRINCIPLES +
  mapBriefing("de_mirage");

const user = `Game state snapshot: {"map":"de_mirage","side":"T","round":7,"ourScore":3,"theirScore":3,"money":4300,"hp":100,"armor":true,"weapons":["glock"],"roundKind":"normal","history":["L","L","W","W","L","L"],"playerIsSelf":true}
Moment: Freezetime / buy period, round 7. Give ONE buy call matched to the money and loss bonus, plus ONE concrete tactical idea for this map and side.`;

type Config = { label: string; model: string; effort?: "low" | "medium" | "high" };

const configs: Config[] = [
  { label: "opus-4-8 (current, effort default=high)", model: "claude-opus-4-8" },
  { label: "opus-4-8 + effort low", model: "claude-opus-4-8", effort: "low" },
  { label: "sonnet-4-6 + effort low", model: "claude-sonnet-4-6", effort: "low" },
  { label: "haiku-4-5 (current fast tier)", model: "claude-haiku-4-5" },
];

const RUNS = 3;

for (const cfg of configs) {
  const times: number[] = [];
  let sample = "";
  for (let i = 0; i < RUNS; i++) {
    const started = Date.now();
    const res = await client.messages.create({
      model: cfg.model,
      max_tokens: 150,
      ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    times.push(Date.now() - started);
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    if (i === 0) sample = text;
  }
  times.sort((a, b) => a - b);
  console.log(`${cfg.label}\n  runs: ${times.join(", ")} ms (median ${times[Math.floor(times.length / 2)]})\n  line: ${sample}\n`);
}
