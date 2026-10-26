# Faster YouTube JS challenge solving for the yt-dlp worker (src/ytdlp_worker.py).
#
# For every lookup, yt-dlp starts node and hands it the whole YouTube player (~3 MB of
# JavaScript) to parse and preprocess before it can solve the "n"/signature challenges: about
# 1-2.5 s per track on a small machine, the largest part of a lookup. yt-dlp can reuse the
# preprocessed player instead (a few hundred ms per solve), but keeps that switched off
# because it would store it on disk: several MB per player version, never cleaned up. In a
# process that stays loaded it can live in memory, so we switch it on and keep the stored
# players there (the last two versions; YouTube changes the player every few days).
#
# yt-dlp's own code still does all the work, in its sandboxed node process, which still exits
# after each solve (a node that stays running keeps growing: 100+ MB). Only where the
# preprocessed player is kept changes. This uses yt-dlp internals, so it checks they're there
# and otherwise leaves yt-dlp as it is.

import sys

KEEP = 2


def install(log=lambda msg: print(msg, file=sys.stderr, flush=True)):
    """Returns True if yt-dlp now reuses preprocessed players."""
    try:
        from yt_dlp.cache import Cache
        from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
    except ImportError as err:
        log(f'preprocessed player cache unavailable: {err}')
        return False
    section = getattr(EJSBaseJCP, '_CACHE_SECTION', None)
    if not section or not hasattr(EJSBaseJCP, '_ENABLE_PREPROCESSED_PLAYER_CACHE') \
            or not callable(getattr(Cache, 'load', None)) or not callable(getattr(Cache, 'store', None)):
        log('preprocessed player cache unavailable: this yt-dlp version works differently')
        return False

    players = {}  # 'player:<url>' -> preprocessed player, oldest first
    load, store = Cache.load, Cache.store

    def is_player(sec, key):
        return sec == section and isinstance(key, str) and key.startswith('player:')

    def memory_load(self, sec, key, *args, **kwargs):
        if is_player(sec, key):
            return players.get(key)
        return load(self, sec, key, *args, **kwargs)

    def memory_store(self, sec, key, data, *args, **kwargs):
        if not is_player(sec, key):
            return store(self, sec, key, data, *args, **kwargs)
        players.pop(key, None)
        if data is not None:
            players[key] = data
            while len(players) > KEEP:
                players.pop(next(iter(players)))
        return None

    Cache.load, Cache.store = memory_load, memory_store
    EJSBaseJCP._ENABLE_PREPROCESSED_PLAYER_CACHE = True
    return True
