import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
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
import { findVoiceById, voices } from "../tts/voices.js";

interface QueuedLine extends SpeakRequest {
  enqueuedAt: number;
  /** Set when a later line superseded this one mid-synthesis — the queue filter
   *  can't reach a line that's already in the TTS provider's hands. */
  superseded?: boolean;
  /** Guards the onPlayed/onDropped callbacks to fire EXACTLY ONCE, however many
   *  drop paths a line passes through. */
  finalized?: boolean;
}

/** Hard ceiling on one TTS synthesis, so a hung provider can never stall the queue. */
const SYNTH_DEADLINE_MS = 12_000;

/** Log-safe view of a line's text — redacted lines (Leetify data, which must
 *  never be persisted, and the logs go to disk) show their length only. */
function preview(line: QueuedLine, max = 40): string {
  if (line.redactText) return `<${line.text.length} chars, redacted>`;
  return line.text.length > max ? `${line.text.slice(0, max)}...` : line.text;
}

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

  /**
   * @param volume Default playback gain for coach lines (COACH_VOLUME). 1 = source
   *   level, the zero-transcode fast path. Any other value — or any ElevenLabs voice
   *   with its own per-voice volume — enables inline volume per line; see makeResource
   *   for the tradeoff.
   */
  constructor(
    private readonly tts: TtsChain,
    // Not readonly: the owner can change the default gain live via /coachadmin set.
    // volumeFor reads it fresh per line, so a change applies to the next line.
    private volume = 1,
  ) {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    // Any non-unity gain (the default OR a per-voice override) routes the affected
    // lines through the ffmpeg-decode + opusscript-encode transcode path — note it once
    // at startup so the latency (and the ffmpeg dependency) is no surprise.
    const overrides = voices().filter((v) => v.volume !== undefined && v.volume !== 1);
    if (this.volume !== 1 || overrides.length > 0) {
      const detail =
        overrides.length > 0
          ? `default ${this.volume}; per-voice ${overrides.map((v) => `${v.label}=${v.volume}`).join(", ")}`
          : `${this.volume}`;
      log.info(
        "voice",
        `Coach playback gain (${detail}) — affected lines take the transcode path (ffmpeg decode + opusscript re-encode), small per-line latency`,
      );
    }
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

  /** The channel we're joined to (or half-joined to — set even before Ready), or
   *  null when there's no connection at all. Lets /coach join tell "already here"
   *  apart from "in a different channel" / "connection went stale", so it can skip
   *  the expensive leave()+rehandshake when it would be a no-op. */
  get connectedChannelId(): string | null {
    return this.connection?.joinConfig.channelId ?? null;
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
    // A song is an explicit play-this-now — drop every in-flight/prefetched/queued
    // coach line so none of it fires when the song ends (same clearing as
    // clearCoachLines, but WITHOUT player.stop(): the play() call below replaces
    // the current audio itself, and the song must keep playing).
    this.clearQueue();
    this.discardPrefetch();
    if (this.inFlight) this.inFlight.superseded = true;
    this.player.play(createAudioResource(stream, { inputType: StreamType.OggOpus }));
  }

  /**
   * Drop every queued, prefetched and in-flight coach line and cut off the one
   * currently speaking — /coach mute's "shut up NOW". A playing song survives
   * (silencing that is /coach stop-song's job).
   */
  clearCoachLines(): void {
    this.clearQueue();
    this.discardPrefetch();
    // A line mid-synthesis already left the queue — flag it so the post-synth
    // checkpoint discards the audio instead of speaking it.
    if (this.inFlight) this.inFlight.superseded = true;
    if (!this.songPlaying) this.player.stop(true);
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
          this.clearQueue();
          this.discardPrefetch();
          this.player.stop(true);
          // Reset synthesis flags too — a line mid-synthesis would otherwise leave
          // synthesizing=true forever, and the next session's pump() early-returns
          // on it (the session guard discards the orphaned in-flight stream anyway).
          this.synthesizing = false;
          this.inFlight = null;
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
    this.clearQueue();
    this.discardPrefetch();
    this.songPlaying = false;
    this.player.stop(true);
    // Reset synthesis flags too — a line mid-synthesis would otherwise leave
    // synthesizing=true forever, and the next session's pump() early-returns
    // on it (the session guard discards the orphaned in-flight stream anyway).
    this.synthesizing = false;
    this.inFlight = null;
  }

  /** Queue a line. Drops it silently if the bot isn't in a voice channel. */
  say(req: SpeakRequest): void {
    if (!this.connection) {
      // Never queued → still let the producer release any cooldown/reservation it
      // provisionally took, so a not-connected drop doesn't starve the next moment.
      req.onDropped?.();
      return;
    }
    // A superseding line makes queued lines in the listed categories old news
    // (the quad line replaces a still-waiting triple line, never follows it).
    if (req.supersedes?.length) {
      const obsolete = new Set(req.supersedes);
      this.queue = this.queue.filter((line) => {
        if (!obsolete.has(line.category)) return true;
        log.info("voice", `Superseded queued [${line.category}]: "${preview(line)}"`);
        this.finalize(line, false);
        return false;
      });
      if (this.prefetched && obsolete.has(this.prefetched.line.category)) {
        log.info("voice", `Superseded prefetched [${this.prefetched.line.category}]: "${preview(this.prefetched.line)}"`);
        this.discardPrefetch();
      }
      // A line mid-synthesis left the queue already — mark it so the post-synth
      // checkpoint drops it (otherwise a triple line synthesizing when the quad
      // arrives would still play, back-to-back with the quad line).
      if (this.inFlight && obsolete.has(this.inFlight.category)) {
        log.info("voice", `Superseded in-flight [${this.inFlight.category}]: "${preview(this.inFlight)}"`);
        this.inFlight.superseded = true;
      }
    }
    this.queue.push({ ...req, enqueuedAt: Date.now() });
    // Highest priority first; FIFO within the same priority.
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    if (this.queue.length > 4) {
      // Prefer to evict a line that's ALREADY dead (past its freshness window or
      // overtaken) over a fresh-but-lower-priority one — otherwise a burst could drop a
      // still-actionable call while keeping a soon-to-be-stale hype line. Only if none
      // is dead does the lowest-priority tail (last after the sort) go.
      const dropAt = Date.now();
      let idx = this.queue.findIndex((line) => this.lineDead(line, dropAt) !== null);
      if (idx === -1) idx = this.queue.length - 1;
      const [dropped] = this.queue.splice(idx, 1);
      if (dropped) {
        log.info("voice", `Queue full — dropped: "${preview(dropped)}"`);
        this.finalize(dropped, false);
      }
    }
    // Deferred so a same-tick batch of lines is fully queued before the first one
    // grabs the idle player — order is then decided by the priority sort above,
    // not by tracker emission order (e.g. the MVP callout beats the round score).
    queueMicrotask(() => this.pump());
  }

  /** Fire a line's play/drop callback exactly once. The engine uses these to commit
   *  the durable cooldown / anti-repeat memory at play time and to release a reserved
   *  cooldown when a line is dropped — so they must each fire at most once, and a line
   *  is either played OR dropped, never both. */
  private finalize(line: QueuedLine, played: boolean): void {
    if (line.finalized) return;
    line.finalized = true;
    try {
      if (played) line.onPlayed?.();
      else line.onDropped?.();
    } catch (err) {
      log.error("voice", `Line ${played ? "onPlayed" : "onDropped"} callback threw`, err);
    }
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
    this.finalize(this.prefetched.line, false); // never aired → release its reservation
    this.prefetched.result.stream.on("error", () => {});
    this.prefetched.result.stream.destroy();
    this.prefetched = null;
  }

  /** Drop every queued line as un-aired (firing each onDropped) and empty the queue. */
  private clearQueue(): void {
    for (const line of this.queue) this.finalize(line, false);
    this.queue = [];
  }

  private pump(): void {
    if (this.synthesizing) return;
    if (!this.connection) return;

    const now = Date.now();
    this.queue = this.queue.filter((line) => {
      const reason = this.lineDead(line, now);
      if (reason) {
        log.info("voice", `Dropped ${reason} line: "${preview(line)}"`);
        this.finalize(line, false);
      }
      return !reason;
    });
    if (this.prefetched) {
      const reason = this.lineDead(this.prefetched.line, now);
      if (reason) {
        log.info("voice", `Dropped ${reason} prefetched line: "${preview(this.prefetched.line)}"`);
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
    this.synthWithDeadline(next.text, next.voiceId)
      .then((result) => {
        this.synthesizing = false;
        this.inFlight = null;
        // Late stream errors must never become uncaught exceptions. And if the
        // erroring stream is the one staged in the prefetch slot (idle-guard
        // teardown or a genuine network drop while it waited behind a playing
        // line), drop it — otherwise pump() would later build an audio resource
        // on a destroyed stream and the line would vanish with no Idle/error
        // diagnostic tying it back to here.
        result.stream.on("error", (err) => {
          log.warn("voice", `TTS stream error: ${err.message}`);
          if (this.prefetched?.result.stream === result.stream) {
            log.info("voice", `Dropped errored prefetched line: "${preview(next)}"`);
            this.discardPrefetch();
          }
          // Advance the queue no matter which slot this stream was in: if it erred while
          // PLAYING and Discord.js doesn't surface a player-level 'error', pump() would
          // otherwise never re-run and the queue would stall. pump() guards on synthesizing.
          this.pump();
        });
        if (session !== this.session || !this.connection) {
          this.finalize(next, false); // session ended/changed → never aired
          result.stream.destroy(); // discard, don't replay
          // Re-arm regardless: a fresh session's lines may already be queued
          // behind this dead synth, and no other pump is scheduled for them.
          this.pump();
          return;
        }
        // The game kept moving during synthesis — drop a line whose moment
        // passed even though its audio is already paid for.
        const reason = this.lineDead(next, Date.now());
        if (reason) {
          log.info("voice", `Dropped ${reason} line after synth: "${preview(next)}"`);
          this.finalize(next, false);
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
        this.finalize(next, false); // every provider failed / deadline hit → never aired
        log.error("voice", `TTS failed for line "${preview(next)}"`, err);
        this.pump();
      });
  }

  /**
   * The playback gain for a line: the per-voice volume of the ElevenLabs voice that
   * actually synthesized it (when set), else the global COACH_VOLUME default. Keyed
   * off the synthesized voice id carried back in the TtsResult, so it's correct even
   * for a prefetched line and never applies an ElevenLabs voice's gain to a
   * Deepgram/Edge line (those leave voiceId unset).
   */
  private volumeFor(result: TtsResult): number {
    if (result.voiceId) {
      const volume = findVoiceById(result.voiceId)?.volume;
      if (volume !== undefined) return volume;
    }
    return this.volume;
  }

  /** Live default-gain change (owner /coachadmin set). Read fresh by volumeFor, so it
   *  applies to the next line. NOTE: any non-unity value routes lines through the ffmpeg
   *  transcode path (see makeResource) — fine on the hosted droplet (ffmpeg bundled). */
  setVolume(volume: number): void {
    this.volume = volume;
  }
  get currentVolume(): number {
    return this.volume;
  }

  /**
   * Build the Discord audio resource for a coach line, applying the resolved gain.
   * At unity volume (the default) this is the zero-transcode fast path: the
   * provider's pre-encoded Opus is demuxed straight to Discord — no codec runs.
   * A non-unity gain enables @discordjs/voice's inline volume, which works on PCM, so
   * the line is transcoded OggOpus →(ffmpeg)→ PCM → gain →(opusscript)→ Opus: ffmpeg
   * decodes, prism's VolumeTransformer applies the gain, opusscript re-encodes. ffmpeg is
   * bundled in the image for exactly this (see the Dockerfile) and opusscript ships as a
   * dependency; the per-line overhead is small — negligible next to the ~200-330 ms TTS
   * time-to-first-audio. Songs don't go through here, so they always play at source level.
   */
  private makeResource(stream: Readable, inputType: StreamType, volume: number) {
    if (volume === 1) return createAudioResource(stream, { inputType });
    const resource = createAudioResource(stream, { inputType, inlineVolume: true });
    resource.volume?.setVolume(volume);
    return resource;
  }

  private playLine(line: QueuedLine, result: TtsResult): void {
    log.info("voice", `Speaking [${line.category}] ${Date.now() - line.eventAt}ms after event: ${preview(line, 1_000)}`);
    this.finalize(line, true); // it is airing now → commit the engine's durable cooldown / anti-repeat
    this.player.play(this.makeResource(result.stream, result.inputType, this.volumeFor(result)));
    // Start synthesizing the next queued line while this one talks.
    queueMicrotask(() => this.pump());
  }

  /** TTS with a hard deadline; a result arriving after the deadline is disposed of. */
  private synthWithDeadline(text: string, voiceId?: string): Promise<TtsResult> {
    return new Promise<TtsResult>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`TTS deadline exceeded (${SYNTH_DEADLINE_MS}ms)`));
      }, SYNTH_DEADLINE_MS);

      this.tts.synth(text, voiceId ? { voiceId } : undefined).then(
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
