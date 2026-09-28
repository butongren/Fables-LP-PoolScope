"""Start once, wait for health, then open the local page. No external packages."""
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
URL = 'http://127.0.0.1:8767'


def healthy():
    try:
        with urllib.request.urlopen(URL+'/api/health', timeout=1) as response:
            return json.load(response).get('app') == 'fables-local-planner'
    except (OSError, ValueError): return False


def ensure_running():
    if healthy(): return
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(('127.0.0.1',8767)) == 0:
            raise RuntimeError('8767 端口被其他服务占用，未重复启动。请先关闭占用程序。')
    logdir = ROOT/'data'
    logdir.mkdir(exist_ok=True)
    kwargs = {'cwd':str(ROOT), 'stdin':subprocess.DEVNULL, 'close_fds':True}
    if os.name == 'nt':
        kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else: kwargs['start_new_session'] = True
    with (logdir/'service-output.log').open('ab') as stdout, (logdir/'service-error.log').open('ab') as stderr:
        child = subprocess.Popen([sys.executable,'-X','utf8',str(ROOT/'server.py')],stdout=stdout,stderr=stderr,**kwargs)
    for _ in range(40):
        if healthy(): return
        if child.poll() is not None: break
        time.sleep(.25)
    if child.poll() is None: child.terminate()
    raise RuntimeError('启动失败：请检查 8767 端口是否被其他程序占用，详情见 data/service-error.log。')


if __name__ == '__main__':
    try:
        ensure_running()
        webbrowser.open(URL)
        print('已打开工具。服务在后台运行，关闭此启动窗口不影响使用。', flush=True)
    except Exception as e:
        print(str(e), flush=True)
        input('按回车退出…')
        raise SystemExit(1)
