"""Local Fables market reader. Python 3.9+, standard library only; no signing."""
import concurrent.futures as futures
import copy
import datetime as dt
import json
import math
import os
import re
import socket
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
SITE = 'https://www.fables.fi'
RPC = 'https://rpc.mainnet.chain.robinhood.com'
STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
LENS = '0xE44c0BAb43BdD47e7Ab40236bC183dCc77A9ED6c'
PORT = 8767
APP_ID = 'fables-local-planner'


def obj(value):
    return value if isinstance(value, dict) else {}


def nonnegative(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def normalize_market(key, value):
    """Validate each row, including old disk cache. A missing pool is not zero."""
    value = obj(value)
    if key == 'marks':
        raw = obj(value.get('data')).get('Pool')
        if not isinstance(raw, list): raise ValueError('价格接口暂未返回有效数据')
        rows, missing = [], 0
        for row in raw:
            row = obj(row)
            if not isinstance(row.get('id'), str): missing += 1; continue
            try: valid = int(row.get('sqrtPriceX96') or 0) > 0
            except (ValueError, TypeError): valid = False
            if valid: rows.append({'id':row['id'], 'sqrtPriceX96':str(row['sqrtPriceX96'])})
            else: missing += 1
        return {'data': {'Pool': rows}}, missing
    raw = value.get('pools')
    if not isinstance(raw, dict): raise ValueError('市场接口暂未返回有效池子列表')
    fields = ('tvlUsd',) if key == 'tvl' else ('volumeUsd', 'feesUsd')
    rows, missing = {}, 0
    for pool_id, row in raw.items():
        values = {field: obj(row).get(field) if nonnegative(obj(row).get(field)) else None for field in fields}
        if any(v is None for v in values.values()): missing += 1
        rows[pool_id.lower()] = values
    return {'pools':rows}, missing


def fetch(url, payload=None):
    headers = {'User-Agent': 'Mozilla/5.0 FablesLocalPlanner/1.0', 'Accept': 'application/json,text/html,*/*'}
    body = None if payload is None else json.dumps(payload).encode()
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        data = response.read(4_000_001)
    if len(data) > 4_000_000:
        raise ValueError('Response too large')
    return data.decode('utf-8')


class Literal:
    """Parse data literals only, NEVER execute downloaded JavaScript."""
    def __init__(self, text, resolve):
        self.text, self.i, self.resolve = text, 0, resolve

    def read(self):
        s = self.text
        while self.i < len(s) and s[self.i].isspace():
            self.i += 1
        c = s[self.i]
        if c == '"':
            value, length = json.JSONDecoder().raw_decode(s[self.i:])
            self.i += length
            return value
        if c in '[{':
            self.i += 1
            out = [] if c == '[' else {}
            closing = ']' if c == '[' else '}'
            while True:
                while s[self.i].isspace(): self.i += 1
                if s[self.i] == closing:
                    self.i += 1
                    return out
                if c == '{':
                    if s[self.i] == '"': key = self.read()
                    else:
                        m = re.match(r'[\w$]+', s[self.i:])
                        if not m: raise ValueError('Invalid key')
                        key = m.group(); self.i += len(key)
                    if s[self.i] != ':': raise ValueError('Expected colon')
                    self.i += 1
                    out[key] = self.read()
                else: out.append(self.read())
                while s[self.i].isspace(): self.i += 1
                if s[self.i] == ',': self.i += 1
                elif s[self.i] != closing: raise ValueError('Unsupported expression')
        if s[self.i:self.i+2] in ('!0', '!1'):
            self.i += 2
            return s[self.i-1] == '0'
        m = re.match(r'-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?n?', s[self.i:], re.I)
        if m:
            v = m.group(); self.i += len(v)
            return int(v[:-1]) if v.endswith('n') else float(v) if '.' in v or 'e' in v.lower() else int(v)
        m = re.match(r'[\w$]+(?:\.[\w$]+)*', s[self.i:])
        if not m: raise ValueError('Unsupported literal')
        self.i += len(m.group())
        return self.resolve(m.group())


def parse_catalog(source):
    known = {'true': True, 'false': False, 'null': None}
    pending = set()
    def resolve(name):
        if '.' in name:
            root, *keys = name.split('.')
            v = resolve(root)
            for key in keys: v = v[key]
            return v
        if name in known: return known[name]
        if name in pending: raise ValueError('Cyclic alias')
        pending.add(name)
        try:
            for m in re.finditer(r'(?<![\w.$])' + re.escape(name) + r'=', source):
                try:
                    v = Literal(source[m.end():], resolve).read()
                    known[name] = v
                    return v
                except (ValueError, KeyError, IndexError, TypeError): pass
            raise ValueError('Unrecognized catalog alias: ' + name)
        finally: pending.remove(name)
    m = re.search(r'=\[\{id:"0x[0-9a-fA-F]{64}"', source)
    if not m: raise ValueError('Pool registry changed; refusing to guess')
    pools = Literal(source[m.start()+1:], resolve).read()
    pools = [p for p in pools if p.get('launch') != 'later']
    for p in pools:
        if not re.fullmatch(r'0x[0-9a-fA-F]{64}', p['id']): raise ValueError('Invalid pool id')
        for key in ('base', 'quote'):
            t = p[key]
            if not re.fullmatch(r'0x[0-9a-fA-F]{40}', t['address']): raise ValueError('Invalid token')
            if not 0 <= t['decimals'] <= 36: raise ValueError('Invalid decimals')
            t['multiplier'] = str(t.get('uiMultiplier', 10**18))
        p.pop('seedPrice', None)  # Seed prices must never become live prices.
    reward = None
    m = re.search(r'Date.UTC\((\d{4}),(\d+),(\d+),(\d+)\),\w+=7\*864e5,\w+=(\[[^\]]+\])', source)
    if m:
        y, mo, d, h = map(int, m.groups()[:4])
        reward = {'start': dt.datetime(y, mo+1, d, h, tzinfo=dt.timezone.utc).timestamp(),
                  'weekly': Literal(m.group(5), resolve).read()}
    return {'pools': pools, 'rewards': reward}


class Cache:
    def __init__(self):
        self.values = {}
        self.lock = threading.RLock()
        self.keylocks = {}
        self.path = ROOT / 'data' / 'cache-v2.json'
        try:
            source = self.path if self.path.exists() else ROOT / 'data' / 'cache.json'
            raw = obj(json.loads(source.read_text('utf-8')))
            self.values = {k:v for k,v in raw.items() if isinstance(v,dict) and 'value' in v
                           and nonnegative(v.get('fetchedAt')) and nonnegative(v.get('attemptedAt'))}
        except (OSError, ValueError): pass

    def snapshot(self, key, ttl=30):
        with self.lock:
            result = copy.deepcopy(self.values.get(key, {'value':None,'fetchedAt':0,'attemptedAt':0,'error':'尚无本地缓存，正在等待联网更新'}))
        result['stale'] = bool(result.get('error')) or time.time()-result['fetchedAt'] > ttl*2
        return result

    def get(self, key, loader, ttl=30):
        with self.lock: lock = self.keylocks.setdefault(key, threading.Lock())
        with lock:
            old = self.values.get(key)
            retry_after = min(ttl, 30) if old and old.get('error') else ttl
            if old and time.time() - old['attemptedAt'] < retry_after:
                result = copy.deepcopy(old)
                result['stale'] = bool(result.get('error')) or time.time()-result['fetchedAt'] > ttl*2
                return result
            try:
                value = loader()
                result = {'value': value, 'fetchedAt': time.time(), 'attemptedAt': time.time(), 'error': None}
            except Exception as e:
                result = dict(old or {'value': None, 'fetchedAt': 0})
                result.update(attemptedAt=time.time(), error=type(e).__name__ + ': ' + str(e)[:200])
            with self.lock:
                self.values[key] = result
                try:
                    self.path.parent.mkdir(exist_ok=True)
                    tmp = self.path.with_suffix('.tmp')
                    tmp.write_text(json.dumps(self.values, ensure_ascii=False, allow_nan=False), 'utf-8')
                    tmp.replace(self.path)
                except (OSError, ValueError) as e:
                    print('Cache persistence unavailable:', str(e), flush=True)
            result = copy.deepcopy(result)
            result['stale'] = bool(result['error'])
            return result


CACHE = Cache()


def live_catalog():
    html = fetch(SITE + '/')
    match = re.search(r'src="(/assets/index-[^"]+\.js)"', html)
    if not match: raise ValueError('Cannot find official market catalog')
    return parse_catalog(fetch(SITE + match.group(1)))


def catalog(cached=False):
    c = CACHE.snapshot('catalog', 3600) if cached else CACHE.get('catalog', live_catalog, 3600)
    if not isinstance(obj(c['value']).get('pools'),list) or not c['value']['pools']:
        bootstrap = json.loads((ROOT / 'catalog.json').read_text('utf-8'))
        c['value'] = bootstrap['value']; c['fetchedAt'] = bootstrap['fetchedAt']; c['stale'] = True
    return c


def positive(v):
    return isinstance(v, (int, float)) and math.isfinite(v) and v > 0


def spot(p, sqrt):
    b, q = p['base'], p['quote']
    base0 = int(b['address'], 16) < int(q['address'], 16)
    t0, t1 = (b, q) if base0 else (q, b)
    raw = (int(sqrt)/2**96)**2 * 10**(t0['decimals']-t1['decimals'])
    value = raw * int(t1['multiplier'])/int(t0['multiplier'])
    return value if base0 else 1/value


def market(cached=False):
    paths = {'tvl': '/api/gw/PoolTvl', 'volume': '/api/gw/PoolVolume24h', 'marks': '/api/indexer?op=marks'}
    def grab(item):
        key, path = item
        def load():
            v = json.loads(fetch(SITE+path))
            normalize_market(key, v)
            return v
        result = CACHE.snapshot(key) if cached else CACHE.get(key, load)
        try:
            result['value'], result['missingRows'] = normalize_market(key, result['value'])
        except ValueError as e:
            result['value'] = {'data': {'Pool': []}} if key == 'marks' else {'pools':{}}
            result['error'] = str(e)
            result['stale'] = True
            result['missingRows'] = 0
        return key, result
    with futures.ThreadPoolExecutor(max_workers=4) as ex:
        catjob = ex.submit(catalog, cached)
        sources = dict(ex.map(grab, paths.items()))
        cat = catjob.result()
    sources['catalog'] = cat
    pools = copy.deepcopy(cat['value']['pools'])
    tvl = (sources['tvl']['value'] or {}).get('pools', {})
    volume = (sources['volume']['value'] or {}).get('pools', {})
    marks = {p['id'].lower(): p.get('sqrtPriceX96') for p in (sources['marks']['value'] or {}).get('data', {}).get('Pool', [])}
    # Match Fables' stablecoin valuation convention; no hardcoded market prices.
    usd = {}
    for p in pools:
        for t in (p['base'], p['quote']):
            if t['symbol'] == 'USDG' or t.get('pegUsd') == 1: usd[t['address'].lower()] = 1.0
        p['spot'] = None
        try:
            if int(marks.get(p['id'].lower()) or 0) > 0: p['spot'] = spot(p, marks[p['id'].lower()])
        except (ValueError, ZeroDivisionError, OverflowError): pass
    for _ in range(4):
        for p in pools:
            if not positive(p['spot']): continue
            b, q = p['base']['address'].lower(), p['quote']['address'].lower()
            if q in usd and b not in usd: usd[b] = p['spot']*usd[q]
            elif b in usd and q not in usd: usd[q] = usd[b]/p['spot']
    reward = obj(cat['value'].get('rewards'))
    if not nonnegative(reward.get('start')) or not isinstance(reward.get('weekly'),list): reward = None
    week = max(0, 1+int((time.time()-reward['start'])//604800)) if reward else None
    reward_weekly = reward['weekly'][week] if reward and week < len(reward['weekly']) else None
    eligible = [p for p in pools if p.get('creatorFee')]
    fees_list = [volume.get(p['id'].lower(), {}).get('feesUsd') for p in eligible]
    valid = all(nonnegative(v) for v in fees_list)
    total_fees = sum(fees_list) if valid else None
    creator_factor = reward_weekly*52/(total_fees*365) if reward_weekly is not None and positive(total_fees) else None
    for p in pools:
        k = p['id'].lower()
        p.update(tvl=tvl.get(k, {}).get('tvlUsd'), volume24h=volume.get(k, {}).get('volumeUsd'), fees24h=volume.get(k, {}).get('feesUsd'))
        p['baseUsd'] = usd.get(p['base']['address'].lower())
        p['quoteUsd'] = usd.get(p['quote']['address'].lower())
        p['swapApr'] = p['fees24h']*365/p['tvl']*100 if p['fees24h'] is not None and positive(p['tvl']) else None
        p['creatorFactor'] = creator_factor if p.get('creatorFee') else 0
        p['creatorApr'] = p['swapApr']*p['creatorFactor'] if p['swapApr'] is not None and p['creatorFactor'] is not None else None
        incentive = obj(p.get('incentive'))
        weekly = obj(incentive.get('weekly')).get(str(week))
        p['partnerDaily'] = weekly/7 if positive(weekly) and incentive.get('token') == 'USDG' else None if p.get('merkl') else 0
        p['partnerApr'] = p['partnerDaily']*365/p['tvl']*100 if p['partnerDaily'] is not None and positive(p['tvl']) else None
        p['knownApr'] = sum(p[x] or 0 for x in ('swapApr', 'creatorApr', 'partnerApr')) if p['swapApr'] is not None else None
        p['aprComplete'] = all(p[x] is not None for x in ('swapApr', 'creatorApr', 'partnerApr'))
    return {'pools': pools, 'sources': {k: {a: v.get(a) for a in ('fetchedAt', 'stale', 'error', 'missingRows')} for k, v in sources.items()},
            'servedAt': time.time(), 'week': week, 'rewardWeekEnds': reward['start']+week*604800 if reward else None,
            'chainId': 4663, 'stablecoinAssumption': 'USDG / pegged USD tokens = $1'}


def rpc(method, params):
    r = json.loads(fetch(RPC, {'jsonrpc':'2.0','id':1,'method':method,'params':params}))
    if r.get('error'): raise ValueError(str(r['error'])[:200])
    return r['result']


def state(pool_id):
    pools = catalog()['value']['pools']
    p = next((p for p in pools if p['id'].lower() == pool_id), None)
    if p is None: raise ValueError('Unknown pool')
    def load():
        if int(rpc('eth_chainId', []), 16) != 4663: raise ValueError('Unexpected RPC chain')
        block = rpc('eth_blockNumber', [])
        def call(address, data): return rpc('eth_call', [{'to':address,'data':'0x'+data}, block])
        addresses = [p['base']['address'], p['quote']['address']]
        calldata = '7dd39885' + format(32,'064x') + format(2,'064x') + ''.join(a[2:].lower().zfill(64) for a in addresses)
        with futures.ThreadPoolExecutor(max_workers=3) as ex:
            slot_job = ex.submit(call, STATE_VIEW, 'c815641c'+pool_id[2:])
            liq_job = ex.submit(call, STATE_VIEW, 'fa6793d5'+pool_id[2:])
            token_job = ex.submit(call, LENS, calldata)
            slot_hex = slot_job.result()[2:]
            if len(slot_hex) < 256: raise ValueError('Invalid state response')
            sqrt = int(slot_hex[:64],16)
            if sqrt <= 0: raise ValueError('Pool is uninitialized')
            liquidity = int(liq_job.result(),16)
            multipliers, multiplier_error = {}, None
            try:
                data = bytes.fromhex(token_job.result()[2:])
                def word(offset):
                    if offset < 0 or offset+32 > len(data): raise ValueError('Invalid lens response')
                    return int.from_bytes(data[offset:offset+32], 'big')
                arr = word(0)
                if word(arr) != 2: raise ValueError('Invalid token count')
                for i, address in enumerate(addresses):
                    start = arr+32+word(arr+32+i*32)
                    if word(start) != int(address,16): raise ValueError('Token order mismatch')
                    mult = word(start+5*32) if word(start+6*32) else 10**18
                    if mult <= 0: raise ValueError('Invalid multiplier')
                    multipliers[address.lower()] = str(mult)
            except Exception as e: multiplier_error = str(e)[:200]
        current = copy.deepcopy(p)
        for key in ('base', 'quote'):
            token = current[key]
            token['multiplier'] = multipliers.get(token['address'].lower(), token['multiplier'])
        tick = int(slot_hex[64:128],16)
        if tick >= 2**255: tick -= 2**256
        return {'sqrtPriceX96': str(sqrt), 'activeLiquidity': str(liquidity), 'tick': tick,
                'block': int(block,16), 'spot': spot(current,sqrt), 'multipliers': multipliers,
                'multiplierError': multiplier_error, 'rpc': RPC}
    return CACHE.get('state:'+pool_id, load, 20)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass
    def do_GET(self):
        if self.headers.get('Host') not in (f'127.0.0.1:{PORT}', f'localhost:{PORT}'):
            self.send_error(403); return
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'):
            self.send_error(403); return
        url = urlparse(self.path)
        try:
            if url.path == '/api/health':
                self.reply(json.dumps({'app':APP_ID,'version':2,'status':'ok'}).encode(), 'application/json')
            elif url.path == '/api/markets':
                cached = parse_qs(url.query).get('cached') == ['1']
                self.reply(json.dumps(market(cached=cached), ensure_ascii=False, allow_nan=False).encode(), 'application/json')
            elif url.path == '/api/state':
                pool_id = parse_qs(url.query).get('pool', [''])[0].lower()
                if not re.fullmatch(r'0x[0-9a-f]{64}', pool_id): raise ValueError('Invalid pool id')
                self.reply(json.dumps(state(pool_id), allow_nan=False).encode(), 'application/json')
            elif url.path in ('/', '/index.html', '/style.css', '/app.js', '/math.js'):
                name = 'index.html' if url.path == '/' else url.path[1:]
                mime = 'text/css' if name.endswith('.css') else 'text/javascript' if name.endswith('.js') else 'text/html'
                self.reply((ROOT/name).read_bytes(), mime)
            else: self.send_error(404)
        except Exception as e:
            traceback.print_exc()
            self.reply(json.dumps({'error':'本机数据处理暂时失败，请重试；详细原因已记录到本地日志。'}).encode(), 'application/json', 502)

    def reply(self, data, mime, status=200):
        self.send_response(status)
        self.send_header('Content-Type', mime+'; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers(); self.wfile.write(data)


class LocalServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can let two services bind the same port. Never enable it here.
    allow_reuse_address = False
    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == '__main__':
    print(f'Fables LP planner: http://127.0.0.1:{PORT}', flush=True)
    LocalServer(('127.0.0.1', PORT), Handler).serve_forever()
