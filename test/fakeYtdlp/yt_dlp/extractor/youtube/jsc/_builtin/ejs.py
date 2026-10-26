# Stand-in for yt-dlp's JS challenge provider base: only what src/ytdlp_jsc.py looks at.
class EJSBaseJCP:
    _CACHE_SECTION = 'challenge-solver'
    _ENABLE_PREPROCESSED_PLAYER_CACHE = False
