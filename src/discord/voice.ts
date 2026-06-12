import { createReadStream } from "node:fs";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
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
  /** Set when a later line superseded this one mid-synthesis — the queue filter
   *  can't reach a line that's already in the TTS provider's hands. */
  superseded?: boolean;
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
  /** The line currently at the TTS provider — reachable for supersession even though it left the queue. */
  private inFlight: QueuedLine | null = null;
  /** Audio synthesized ahead while another line plays — speaks the moment the player goes idle. */
  private prefetched: { line: QueuedLine; result: TtsResult } | null = null;
  /** Bumped on every join/leave so in-flight synths from old sessions get discarded. */
  private session = 0;
  /** True while a song file occupies the player — coach lines queue behind it
   *  (pump only plays on Idle) and whatever aged out by the end gets dropped. */
  private songPlaying = false;

  constructor(private readonly tts: TtsChain) {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.songPlaying = false;
      this.pump();
    });
    this.player.on("error", (err) => {
      log.error("voice", "Audio player error", err);
      this.songPlaying = false;
      this.pump();
    });
  }

  get connected(): boolean {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get songActive(): boolean {
    return this.songPlaying;
  }

  /** Play a local Ogg/Opus file immediately, cutting off any in-progress line. */
  playFile(filePath: string): void {
    if (!this.connection) throw new Error("Not in a voice channel");
    const stream = createReadStream(filePath);
    stream.on("error", (err) => log.error("voice", `Song stream error: ${err.message}`));
    this.songPlaying = true;
    log.info("voice", `Playing song file: ${filePath}`);
    this.player.play(createAudioResource(stream, { inputType: StreamType.OggOpus }));
  }

  /** Stop a playing song. Returns false when no song is active. */
  stopSong(): boolean {
    if (!this.songPlaying) return false;
    this.songPlaying = false;
    this.player.stop(true); // → Idle → pump resumes queued coach lines
    return true;
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
          // Full teardown, same as leave(): a held prefetch stream and queued
          // lines would otherwise linger until the next /coach join.
          this.queue = [];
          this.discardPrefetch();
          this.player.stop(true);
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
    this.discardPrefetch();
    this.songPlaying = false;
    this.player.stop(true);
  }

  /** Queue a line. Drops it silently if the bot isn't in a voice channel. */
  say(req: SpeakRequest): void {
    if (!this.connection) return;
    // A superseding line makes queued lines in the listed categories old news
    // (the quad line replaces a still-waiting triple line, never follows it).
    if (req.supersedes?.length) {
      const obsolete = new Set(req.supersedes);
      this.queue = this.queue.filter((line) => {
        if (!obsolete.has(line.category)) return true;
        log.info("voice", `Superseded queued [${line.category}]: "${line.text.slice(0, 40)}..."`);
        return false;
      });
      if (this.prefetched && obsolete.has(this.prefetched.line.category)) {
        log.info("voice", `Superseded prefetched [${this.prefetched.line.category}]: "${this.prefetched.line.text.slice(0, 40)}..."`);
        this.discardPrefetch();
      }
      // A line mid-synthesis left the queue already — mark it so the post-synth
      // checkpoint drops it (otherwise a triple line synthesizing when the quad
      // arrives would still play, back-to-back with the quad line).
      if (this.inFlight && obsolete.has(this.inFlight.category)) {
        log.info("voice", `Superseded in-flight [${this.inFlight.category}]: "${this.inFlight.text.slice(0, 40)}..."`);
        this.inFlight.superseded = true;
      }
    }
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

  /** Why a line must not be spoken anymore, or null while it's still good. */
  private lineDead(line: QueuedLine, now: number): string | null {
    if (line.superseded) return "superseded";
    // Freshness is anchored to the game moment (eventAt), not to when the line
    // reached the queue, so slow LLM/TTS time counts too.
    if (now - line.eventAt > line.maxAgeMs) return "stale";
    if (line.stillRelevant && !line.stillRelevant()) return "overtaken";
    return null;
  }

  private discardPrefetch(): void {
    if (!this.prefetched) return;
    this.prefetched.result.stream.on("error", () => {});
    this.prefetched.result.stream.destroy();
    this.prefetched = null;
  }

  private pump(): void {
    if (this.synthesizing) return;
    if (!this.connection) return;

    const now = Date.now();
    this.queue = this.queue.filter((line) => {
      const reason = this.lineDead(line, now);
      if (reason) log.info("voice", `Dropped ${reason} line: "${line.text.slice(0, 40)}..."`);
      return !reason;
    });
    if (this.prefetched) {
      const reason = this.lineDead(this.prefetched.line, now);
      if (reason) {
        log.info("voice", `Dropped ${reason} prefetched line: "${this.prefetched.line.text.slice(0, 40)}..."`);
        this.discardPrefetch();
      }
    }

    if (this.player.state.status === AudioPlayerStatus.Idle && this.prefetched) {
      // A strictly higher-priority arrival outranks the prefetched audio — eat
      // the wasted synthesis, but put the LINE back in the queue: it's still
      // fresh and relevant, only its audio is forfeit. It re-synthesizes later.
      if (this.queue.length > 0 && this.queue[0].priority > this.prefetched.line.priority) {
        const { line, result } = this.prefetched;
        this.prefetched = null;
        log.info("voice", `Prefetched [${line.category}] outranked by [${this.queue[0].category}] — re-queued`);
        result.stream.on("error", () => {});
        result.stream.destroy();
        this.queue.push(line);
        this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
      } else {
        const { line, result } = this.prefetched;
        this.prefetched = null;
        this.playLine(line, result);
        return;
      }
    }

    // One look-ahead only: with audio already held for the next slot, wait for
    // the player to go idle instead of synthesizing (and leaking) a third line.
    if (this.prefetched) return;

    const next = this.queue.shift();
    if (!next) return;

    const session = this.session;
    this.synthesizing = true;
    this.inFlight = next;
    this.synthWithDeadline(next.text)
      .then((result) => {
        this.synthesizing = false;
        this.inFlight = null;
        // Late stream errors must never become uncaught exceptions.
        result.stream.on("error", (err) => log.warn("voice", `TTS stream error: ${err.message}`));
        if (session !== this.session || !this.connection) {
          result.stream.destroy(); // session ended/changed while synthesizing — discard, don't replay
          // Re-arm regardless: a fresh session's lines may already be queued
          // behind this dead synth, and no other pump is scheduled for them.
          this.pump();
          return;
        }
        // The game kept moving during synthesis — drop a line whose moment
        // passed even though its audio is already paid for.
        const reason = this.lineDead(next, Date.now());
        if (reason) {
          log.info("voice", `Dropped ${reason} line after synth: "${next.text.slice(0, 40)}..."`);
          result.stream.destroy();
          this.pump();
          return;
        }
        if (this.player.state.status === AudioPlayerStatus.Idle) {
          this.playLine(next, result);
        } else {
          // Synthesized ahead while another line talks — hold the audio so it
          // starts the instant the player goes idle (saves ~1s per queued line).
          this.prefetched = { line: next, result };
        }
      })
      .catch((err) => {
        this.synthesizing = false;
        this.inFlight = null;
        log.error("voice", `TTS failed for line "${next.text.slice(0, 40)}..."`, err);
        this.pump();
      });
  }

  private playLine(line: QueuedLine, result: TtsResult): void {
    log.info("voice", `Speaking [${line.category}] ${Date.now() - line.eventAt}ms after event: ${line.text}`);
    this.player.play(createAudioResource(result.stream, { inputType: result.inputType }));
    // Start synthesizing the next queued line while this one talks.
    queueMicrotask(() => this.pump());
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
