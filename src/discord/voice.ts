import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { log } from "../log.js";
import type { SpeakRequest } from "../coach/engine.js";
import type { TtsChain, TtsResult } from "../tts/index.js";

interface QueuedLine extends SpeakRequest {
  enqueuedAt: number;
}

/** Hard ceiling on one TTS synthesis, so a hung provider can never stall the queue. */
const SYNTH_DEADLINE_MS = 12_000;

/**
 * One persistent voice connection + one AudioPlayer (joining costs a full
 * handshake plus a DAVE/MLS group join, so never rejoin per line). Lines go
 * through a small priority queue; anything past its freshness window is
 * dropped — a late coaching line is worse than no line.
 */
export class VoiceCoach {
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer;
  private queue: QueuedLine[] = [];
  private synthesizing = false;
  /** Bumped on every join/leave so in-flight synths from old sessions get discarded. */
  private session = 0;

  constructor(private readonly tts: TtsChain) {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.player.on(AudioPlayerStatus.Idle, () => this.pump());
    this.player.on("error", (err) => {
      log.error("voice", "Audio player error", err);
      this.pump();
    });
  }

  get connected(): boolean {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    this.leave();
    const session = this.session;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true, // the coach speaks but never listens
    });

    // An unhandled 'error' event on an EventEmitter crashes the process.
    connection.on("error", (err) => log.error("voice", "Voice connection error", err));

    // Standard resilience pattern: a Disconnected state is often a region move /
    // channel move — give it 5s to recover before tearing down.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // The connection may already have been destroyed (e.g. /coach leave or a
        // re-join during the grace window) — destroy() throws on a destroyed connection.
        this.safeDestroy(connection);
        if (this.connection === connection) {
          log.warn("voice", "Voice connection lost — destroyed");
          this.connection = null;
        }
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.safeDestroy(connection);
      throw new Error("Timed out connecting to the voice channel (20s)");
    }

    connection.subscribe(this.player);
    this.connection = connection;
    log.info("voice", `Joined voice channel "${channel.name}" (session ${session})`);
  }

  leave(): void {
    this.session++;
    if (this.connection) {
      this.safeDestroy(this.connection);
      this.connection = null;
    }
    this.queue = [];
    this.player.stop(true);
  }

  /** Queue a line. Drops it silently if the bot isn't in a voice channel. */
  say(req: SpeakRequest): void {
    if (!this.connection) return;
    this.queue.push({ ...req, enqueuedAt: Date.now() });
    // Highest priority first; FIFO within the same priority.
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    if (this.queue.length > 4) {
      const dropped = this.queue.pop();
      if (dropped) log.info("voice", `Queue full — dropped: "${dropped.text.slice(0, 40)}..."`);
    }
    // Deferred so a same-tick batch of lines is fully queued before the first one
    // grabs the idle player — order is then decided by the priority sort above,
    // not by tracker emission order (e.g. the MVP callout beats the round score).
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    if (this.synthesizing) return;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return;
    if (!this.connection) return;

    // Discard stale lines — freshness is anchored to the game moment (eventAt),
    // not to when the line reached the queue, so slow LLM/TTS time counts too.
    const now = Date.now();
    this.queue = this.queue.filter((line) => {
      const fresh = now - line.eventAt <= line.maxAgeMs;
      if (!fresh) log.info("voice", `Dropped stale line: "${line.text.slice(0, 40)}..."`);
      return fresh;
    });

    const next = this.queue.shift();
    if (!next) return;

    const session = this.session;
    this.synthesizing = true;
    this.synthWithDeadline(next.text)
      .then(({ stream, inputType }) => {
        this.synthesizing = false;
        // Late stream errors must never become uncaught exceptions.
        stream.on("error", (err) => log.warn("voice", `TTS stream error: ${err.message}`));
        if (session !== this.session || !this.connection) {
          stream.destroy(); // session ended/changed while synthesizing — discard, don't replay
          return;
        }
        log.info("voice", `Speaking [${next.category}] ${Date.now() - next.eventAt}ms after event: ${next.text}`);
        this.player.play(createAudioResource(stream, { inputType }));
      })
      .catch((err) => {
        this.synthesizing = false;
        log.error("voice", `TTS failed for line "${next.text.slice(0, 40)}..."`, err);
        this.pump();
      });
  }

  /** TTS with a hard deadline; a result arriving after the deadline is disposed of. */
  private synthWithDeadline(text: string): Promise<TtsResult> {
    return new Promise<TtsResult>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`TTS deadline exceeded (${SYNTH_DEADLINE_MS}ms)`));
      }, SYNTH_DEADLINE_MS);

      this.tts.synth(text).then(
        (result) => {
          clearTimeout(timer);
          if (timedOut) {
            result.stream.on("error", () => {});
            result.stream.destroy();
          } else {
            resolve(result);
          }
        },
        (err) => {
          clearTimeout(timer);
          if (!timedOut) reject(err);
        },
      );
    });
  }

  private safeDestroy(connection: VoiceConnection): void {
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
    try {
      connection.destroy();
    } catch (err) {
      log.warn("voice", `Connection destroy raced: ${err instanceof Error ? err.message : err}`);
    }
  }
}
