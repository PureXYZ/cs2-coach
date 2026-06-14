/**
 * Text normalization applied to every line just before TTS.
 *
 * CS2 bombsites and tactical callouts are written with bare capital letters —
 * "A site", "B Long", "hit A", "A or B". ElevenLabs (and Deepgram) frequently
 * read a lone "A" as the indefinite article ("uh site") instead of the letter
 * ("ay site"), and it's nondeterministic: the same line is right one round and
 * wrong the next. Spelling the letters out ("Ay", "Bee") forces the letter
 * reading on every provider, since multilingual_v2 has no reliable SSML/say-as.
 *
 * The one thing we must NOT touch is a genuine article "A" at the start of a
 * sentence ("A full buy.", "A couple of them stacked up."). A capitalized
 * article only ever appears sentence-initially, so a mid-sentence capital A/B is
 * always a callout or label and converts unconditionally; a sentence-initial "A"
 * converts only when a bombsite cue follows it ("A site", "A Main", "A's").
 */

const SPOKEN_LETTER: Record<"A" | "B", string> = { A: "Ay", B: "Bee" };

// A word that marks a sentence-initial capital "A" as the bombsite rather than
// the article. Tested against the text immediately after the "A".
const A_BOMBSITE_CUE =
  /^(?:site|main|long|short|side|ramp|apps|apartments?|halls?|lane|stairs|connector|cat|default|plat|box|window|tunnels?|'s\b)/i;

/** Start of the line, or right after sentence-ending punctuation. */
function startsSentence(before: string): boolean {
  return /(?:^|[.!?]["')\]]?)\s*$/.test(before);
}

export function normalizeForSpeech(text: string): string {
  // "A or B" / "A and B" — an explicit two-site enumeration; both are letters.
  let out = text.replace(
    /\bA( (?:or|and) )B\b/g,
    `${SPOKEN_LETTER.A}$1${SPOKEN_LETTER.B}`,
  );
  // Every other lone capital A or B (apostrophe and punctuation count as boundaries,
  // so "A's"/"B's" match but "AWP"/"ADR" don't).
  out = out.replace(
    /(^|[^\p{L}])([AB])(?![\p{L}])/gu,
    (match, pre, letter, offset, full) => {
      if (letter === "B") return `${pre}${SPOKEN_LETTER.B}`;
      const before = full.slice(0, offset) + pre;
      if (startsSentence(before)) {
        const after = full.slice(offset + match.length).replace(/^\s+/, "");
        if (!A_BOMBSITE_CUE.test(after)) return match; // leave the article alone
      }
      return `${pre}${SPOKEN_LETTER.A}`;
    },
  );
  return out;
}
