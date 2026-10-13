// Output formats, from "least work" to "most compatible".
//
//  direct  proxy YouTube's stream as-is (fragmented DASH M4A). Native seeking.
//  mp4     remux (no re-encode) into a regular, non-fragmented MP4 with the index
//          at the front. Lossless, a few % CPU. Native seeking. Needs the whole
//          track downloaded first (~1-3 s for a song), cached on disk.
//  adts    remux the AAC audio into a raw ADTS stream - what internet radios play.
//          Lossless, streams immediately. Seeking restarts the stream at the offset.
//  flac    decode the AAC and store it as FLAC. FLAC is lossless, so the only step is
//          the decode to 16/24-bit PCM that any AAC player does anyway - no second
//          lossy encode like MP3. Built as a file like mp4, so seeking is native.
//  mp3     re-encode to MP3. Works everywhere, lossy. Seeking restarts the stream.

export const FORMATS = {
  direct: { mime: null, ext: null, seekable: true, lossless: true },
  mp4: { mime: 'audio/mp4', ext: 'm4a', seekable: true, lossless: true },
  adts: { mime: 'audio/aac', ext: 'aac', seekable: false, lossless: true },
  flac: { mime: 'audio/flac', ext: 'flac', seekable: true, lossless: true },
  mp3: { mime: 'audio/mpeg', ext: 'mp3', seekable: false, lossless: false },
};

/** Order tried by auto-detection. */
export const FALLBACK_CHAIN = ['direct', 'mp4', 'adts', 'flac', 'mp3'];

/** Formats built as a complete file in the cache (served with byte ranges). */
export const FILE_FORMATS = ['mp4', 'flac'];

/** MIME types a renderer might list for each format (besides the canonical one). */
export const MIME_ALIASES = {
  'audio/mp4': ['audio/m4a', 'audio/x-m4a', 'audio/mp4a-latm'],
  'audio/aac': ['audio/aacp', 'audio/x-aac', 'audio/aac-adts', 'audio/vnd.dlna.adts', 'audio/mp4a-latm'],
  'audio/mpeg': ['audio/mp3', 'audio/x-mpeg'],
  'audio/flac': ['audio/x-flac'],
};

/** DLNA.ORG_PN profile hints help some renderers (Sony, Samsung) accept the stream. */
export function dlnaFeatures(format) {
  const pn = { mp4: 'DLNA.ORG_PN=AAC_ISO_320;', adts: 'DLNA.ORG_PN=AAC_ADTS_320;', mp3: 'DLNA.ORG_PN=MP3;' }[format] ?? '';
  const seekable = FORMATS[format].seekable;
  // (No DLNA profile name exists for FLAC; renderers go by the MIME type.)
  return `${pn}DLNA.ORG_OP=${seekable ? '01' : '00'};DLNA.ORG_CI=${format === 'direct' ? 0 : 1};`
    + 'DLNA.ORG_FLAGS=01700000000000000000000000000000';
}

export function mimeOf(format, sourceMime) {
  return FORMATS[format].mime ?? sourceMime;
}
