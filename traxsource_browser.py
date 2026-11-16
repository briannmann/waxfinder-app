"""One ordinary, dedicated Chrome window for public Traxsource searches.

Uses Chrome's local DevTools pipe, not a listening port or personal browser
profile. No fingerprint changes, challenge solving, logins, or cookie exports.
"""
import atexit
import json
import os
from pathlib import Path
import select
import subprocess
import time
import urllib.parse


PROFILE = Path.home() / 'Library/Application Support/Waxfinder/Traxsource Browser'


class BrowserError(RuntimeError):
    pass


class ProtocolError(BrowserError):
    pass


class SearchBrowser:
    def __init__(self, chrome, profile=PROFILE):
        self.chrome = chrome
        self.profile = profile
        self.process = None
        self.buffer = b''
        self.sequence = 0
        self.session = None
        self.last_search = 0.
        atexit.register(self.close)

    def _call(self, method, params=None, session=None, timeout=10):
        p = self.process
        if p is None or p.poll() is not None:
            raise BrowserError('Traxsource search browser is closed')
        self.sequence += 1
        message = {'id': self.sequence, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        try:
            p.stdin.write(json.dumps(message).encode() + b'\0')
            p.stdin.flush()
        except OSError as exc:
            raise BrowserError('Traxsource search browser disconnected') from exc
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while b'\0' in self.buffer:
                packet, self.buffer = self.buffer.split(b'\0', 1)
                if not packet:
                    continue
                try:
                    reply = json.loads(packet)
                except ValueError as exc:
                    raise BrowserError('Traxsource search browser returned invalid data') from exc
                if reply.get('id') != message['id']:
                    continue  # Page events/late replies do not complete this command.
                if 'error' in reply:
                    raise ProtocolError('Traxsource search browser command failed')
                return reply.get('result', {})
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select([p.stdout], [], [], remaining)
            if not readable:
                break
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk:
                raise BrowserError('Traxsource search browser disconnected')
            self.buffer += chunk
            if len(self.buffer) > 16 * 1024 * 1024:
                raise BrowserError('Traxsource search page is too large')
        raise BrowserError('Traxsource search browser timed out')

    def _start(self):
        self.close()
        self.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.profile.chmod(0o700)
        # Chrome reads DevTools from fd3 and writes NUL-delimited JSON to fd4.
        # The fixed wrapper maps our stdin/stdout pipes without preexec_fn in
        # this threaded app. All executable paths/arguments are separate argv.
        args = ['/bin/zsh', '-c', 'exec 3<&0 4>&1; exec "$@"', 'waxfinder-browser',
                str(self.chrome), '--remote-debugging-pipe',
                '--user-data-dir=' + str(self.profile), '--no-first-run',
                '--no-default-browser-check', '--disable-background-networking',
                '--mute-audio', '--new-window', 'about:blank']
        try:
            self.process = subprocess.Popen(args, stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                            bufsize=0, start_new_session=True)
            targets = self._call('Target.getTargets', timeout=15).get('targetInfos', [])
            target = next((t['targetId'] for t in targets if t.get('type') == 'page'), None)
            if not target:
                target = self._call('Target.createTarget', {'url': 'about:blank'})['targetId']
            self.session = self._call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
            self._call('Page.enable', session=self.session)
        except (OSError, KeyError, BrowserError) as exc:
            self.close()
            raise BrowserError('Traxsource search browser could not start') from exc

    def html(self, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != 'www.traxsource.com' or parsed.path != '/search':
            raise ValueError('Only public Traxsource search pages are allowed')
        if self.process is None or self.process.poll() is not None:
            self._start()
        self.last_search = time.monotonic()
        navigation = self._call('Page.navigate', {'url': url}, session=self.session)
        if navigation.get('errorText'):
            raise BrowserError('Traxsource search page could not load')
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            try:
                page = self.snapshot()
            except (KeyError, ValueError, ProtocolError):
                page = {}
            # Never return the previous track's page during a navigation.
            if page.get('url') == url and page.get('ready') == 'complete':
                return page['html']
            time.sleep(.05)  # Local page readiness only; no extra website request.
        raise BrowserError('Traxsource search page timed out')

    def snapshot(self):
        """Read our existing search tab only; this does not load a website."""
        result = self._call('Runtime.evaluate', {
            'expression': "JSON.stringify(location.origin==='https://www.traxsource.com'&&location.pathname==='/search'?{url:location.href,ready:document.readyState,html:document.documentElement.outerHTML}:{})",
            'returnByValue': True,
        }, session=self.session)
        return json.loads(result['result']['value'])

    def close(self):
        p, self.process = self.process, None
        self.session = None
        self.buffer = b''
        if p is None:
            return
        for stream in (p.stdin, p.stdout, p.stderr):
            if stream:
                try:
                    stream.close()
                except OSError:
                    pass
        # Closing the private DevTools pipe normally closes our Chrome process.
        # Never touch a Chrome process/profile that was not started by this object.
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            p.terminate()
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
