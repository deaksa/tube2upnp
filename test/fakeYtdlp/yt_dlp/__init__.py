# A stand-in for the yt_dlp package, so the worker (src/ytdlp_worker.py) can be tested
# without YouTube. The video ID in the URL picks the behaviour.
import json
import os
import sys
import time

from . import version  # noqa: F401  (the worker reads yt_dlp.version.__version__)


class _Parsed:
    def __init__(self, args):
        self.ydl_opts = {'args': args, 'logger': None}


def parse_options(args):
    if '--bad-option' in args:
        sys.exit(2)
    return _Parsed(args)


class YoutubeDL:
    def __init__(self, opts):
        self.args = opts['args']
        self.logger = opts['logger']

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        pass

    def save_cookies(self):
        pass

    def sanitize_info(self, info):
        return info

    def extract_info(self, url, download=False):
        vid = url.rsplit('=', 1)[-1]
        if vid == 'unavailable':
            raise Exception('ERROR: [youtube] unavailable: Video unavailable')
        if vid == 'ignoredxxxx':
            # The command line's ignoreerrors: yt-dlp logs the error and returns nothing.
            self.logger.error('ERROR: [youtube] ignoredxxxx: Video unavailable. This video is not available')
            return None
        if vid == 'crashcrashx':
            os._exit(3)
        if vid == 'hanghanghan':
            time.sleep(60)
        print('noise on stdout', flush=True)  # must not disturb the replies
        return {'id': vid, 'url': 'https://r1.googlevideo.com/videoplayback?expire=9999999999',
                'ext': 'm4a', 'title': 'Worker ' + vid, 'format_id': '140', 'pid': os.getpid(),
                'args': self.args}

    def download_with_info_file(self, path):
        with open(path) as f:
            info = json.load(f)
        if info.get('id') == 'forbiddenxx':
            # Like yt-dlp: the error goes to the logger, the failure only into the return code.
            self.logger.error('ERROR: unable to download video data: HTTP Error 403: Forbidden')
            return 1
        with open(self.args[self.args.index('-o') + 1], 'w') as f:
            f.write('audio of ' + info['id'] + ' as ' + self.args[self.args.index('-f') + 1])
        return 0
