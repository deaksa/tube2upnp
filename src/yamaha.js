// Yamaha Extended Control (YXC), the HTTP JSON API of MusicCast receivers and speakers.
//
// UPnP only sees a receiver's own DLNA playback (its "Server" input). When it plays its
// tuner, net radio, Spotify or an HDMI input, the renderer just reports STOPPED, and its
// RenderingControl volume may not follow the master volume. YXC knows the input, what
// is playing on it, the power state and the master volume in dB (as the display shows).

const TIMEOUT_MS = 3000;

/** The YXC base URL a device description announces (yamaha:X_yxcControlURL), on the device's own host. */
export function yxcBaseFrom(root, location) {
  let urlBase = null;
  let control = null;
  root.iter('*', (e) => {
    const tag = e.tag.split(':').pop();
    if (tag === 'X_URLBase' && !urlBase) urlBase = e.text?.trim() || null;
    if (tag === 'X_yxcControlURL' && !control) control = e.text?.trim() || null;
  });
  if (!control) return null;
  try {
    const url = new URL(control, urlBase || location);
    // The description comes from the network: only ever talk to the device itself.
    if (url.hostname !== new URL(location).hostname || !/^https?:$/.test(url.protocol)) return null;
    return url.toString().replace(/\/?$/, '/');
  } catch {
    return null;
  }
}

export class YamahaExtendedControl {
  constructor(baseUrl, fetchImpl = fetch) {
    this.base = baseUrl;
    this.fetch = fetchImpl;
  }

  async #get(path) {
    // No redirects: the base URL was checked to be on the device itself, a redirect could go anywhere.
    const res = await this.fetch(new URL(path, this.base), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`YXC ${path}: HTTP ${res.status}`);
    const body = await res.json();
    if (body?.response_code !== 0) throw new Error(`YXC ${path}: response_code ${body?.response_code}`);
    return body;
  }

  /** Does this device answer YXC? (For Yamaha devices whose description doesn't say.) */
  async works() {
    try {
      await this.#get('main/getStatus');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Power, input, master volume and what plays on the input.
   * @param {{withPlayInfo?: boolean}} opts - false: main zone only (cheap, for volume)
   */
  async status({ withPlayInfo = true } = {}) {
    const s = await this.#get('main/getStatus');
    const db = s.actual_volume?.mode === 'db' && Number.isFinite(s.actual_volume.value) ? s.actual_volume.value : null;
    const out = {
      power: s.power ?? null,
      input: s.input ?? null,
      inputText: s.input_text ?? s.input ?? null,
      volume: Number.isFinite(s.volume) && Number.isFinite(s.max_volume) && s.max_volume > 0
        ? { raw: s.volume, min: 0, max: s.max_volume, muted: Boolean(s.mute), db } : null,
      playing: null,
    };
    if (withPlayInfo && out.power === 'on' && out.input) out.playing = await this.#playInfo(out.input).catch(() => null);
    return out;
  }

  /** What plays on the input: tuner station, or the net/USB source's track. Null for HDMI, optical, ... */
  async #playInfo(input) {
    if (input === 'tuner') {
      const t = await this.#get('tuner/getPlayInfo');
      if (t.band === 'dab') {
        const d = t.dab ?? {};
        return { playback: 'play', title: d.service_label || d.ch_label || 'DAB', artist: d.dls || null };
      }
      const f = t.fm ?? t.am ?? {};
      const freq = t.band === 'am' ? `AM ${f.freq} kHz` : `FM ${(f.freq / 1000).toFixed(2)} MHz`;
      const rds = t.rds?.program_service?.trim();
      return { playback: 'play', title: rds || freq, artist: rds ? freq : (t.rds?.radio_text_a?.trim() || null) };
    }
    // Net radio, Spotify, AirPlay, Bluetooth, USB, the DLNA server input...: netusb, if it's on that input.
    const n = await this.#get('netusb/getPlayInfo');
    if (n.input !== input) return null;
    const art = this.#sameHost(n.albumart_url);
    // Net radio puts the station in "artist" and the stream's "Artist - Title" in "track".
    if (input === 'net_radio') {
      return { playback: n.playback ?? null, title: n.track || n.artist || null, artist: null,
        station: n.track ? n.artist || null : null, art };
    }
    const title = n.track || n.album || null;
    return { playback: n.playback ?? null, title, artist: n.artist || (n.track ? n.album || null : null), art };
  }

  /** A URL the device gave (cover art), resolved, and only if it's on the device itself. */
  #sameHost(path) {
    if (!path) return null;
    try {
      const url = new URL(path, this.base);
      return url.host === new URL(this.base).host && /^https?:$/.test(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }
}
