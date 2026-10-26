# Keeps yt-dlp loaded between lookups and downloads for Tube2U[PnP] (src/ytdlpWorker.js).
#
# Starting Python and importing yt-dlp's ~1800 extractors costs about a second per run on a
# small machine, every time a track is resolved or downloaded. This process does it once.
#
# Protocol: one JSON request per line on stdin, one JSON reply per line on file descriptor 3.
# yt-dlp itself may print to stdout/stderr; fd 3 is ours alone, so nothing can corrupt replies.
#   {"id": 1, "op": "ping"}  -> {"id": 1, "ok": true, "result": {"version": "...", "fastJsc": bool}}
#   {"id": 2, "op": "resolve", "args": [...], "url": "..."}  -> result: the info JSON (as --dump-json prints it)
#   {"id": 3, "op": "download", "args": [...], "infoFile": "..."} -> result: null
#   on failure: {"id": n, "ok": false, "error": "<yt-dlp's message>"}
# "args" are yt-dlp command-line options, parsed by yt-dlp itself, so they mean exactly what
# they mean on the command line (YTDLP_EXTRA_ARGS included).

import json
import os
import sys

import yt_dlp

import ytdlp_jsc  # next to this script

try:
    fast_jsc = ytdlp_jsc.install()
except Exception as err:  # an optimisation: never a reason not to start
    print(f'preprocessed player cache unavailable: {err}', file=sys.stderr, flush=True)
    fast_jsc = False
replies = os.fdopen(3, 'w', buffering=1, encoding='utf-8')


class Log:
    """yt-dlp's messages go to stderr (Node logs them at debug level); never to the reply channel."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    last_error = None

    def warning(self, msg):
        print(msg, file=sys.stderr, flush=True)

    def error(self, msg):
        Log.last_error = msg
        print(msg, file=sys.stderr, flush=True)


def make(args):
    opts = yt_dlp.parse_options(args).ydl_opts
    opts.update(quiet=True, noprogress=True, logger=Log())
    return yt_dlp.YoutubeDL(opts)


# One YoutubeDL per set of options, reused: it keeps YouTube's player code and solved
# challenges in memory. Downloads write to a new file each time, so they get a fresh one.
resolvers = {}


def handle(req):
    op = req.get('op')
    if op == 'ping':
        return {'version': yt_dlp.version.__version__, 'fastJsc': fast_jsc}
    if op == 'resolve':
        key = json.dumps(req['args'])
        ydl = resolvers.get(key)
        if ydl is None:
            if len(resolvers) >= 4:
                resolvers.pop(next(iter(resolvers))).close()
            ydl = resolvers[key] = make(req['args'])
        info = ydl.extract_info(req['url'], download=False)
        ydl.save_cookies()  # like the command line does on exit: YouTube rotates them
        return json.dumps(ydl.sanitize_info(info))
    if op == 'download':
        Log.last_error = None
        with make(req['args']) as ydl:
            # Reports a failed download in its return code, as the command line's exit status.
            if ydl.download_with_info_file(req['infoFile']):
                raise RuntimeError(Log.last_error or 'download failed')
        return None
    raise ValueError('unknown op %r' % op)


for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    try:
        reply = {'id': req.get('id'), 'ok': True, 'result': handle(req)}
    except BaseException as err:  # yt-dlp raises DownloadError, SystemExit on bad options, ...
        if isinstance(err, KeyboardInterrupt):
            raise
        reply = {'id': req.get('id'), 'ok': False, 'error': str(err) or type(err).__name__}
    replies.write(json.dumps(reply) + '\n')
