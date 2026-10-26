# Stand-in for yt-dlp's disk cache: a dict, so tests can see what reached "disk".
class Cache:
    disk = {}

    def __init__(self, ydl=None):
        pass

    def load(self, section, key, dtype='json', default=None, *, min_ver=None):
        return Cache.disk.get((section, key), default)

    def store(self, section, key, data, dtype='json'):
        Cache.disk[(section, key)] = data
