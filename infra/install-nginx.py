"""Run via sudo python3 on Ubuntu-3; add only this project's exact TLS route."""
from pathlib import Path
import datetime
import subprocess

path = Path('/etc/nginx/sites-available/personal-site')
original = path.read_text()
marker = 'location = /bots/telegram-metadata/webhook'
if marker not in original:
    anchor = 'server {\n    server_name gelatoni.uk www.gelatoni.uk;'
    if original.count(anchor) != 1:
        raise SystemExit('Expected exactly one existing TLS server block')
    route = '''
    location = /bots/telegram-metadata/webhook {
        client_max_body_size 1m;
        proxy_pass http://127.0.0.1:3051;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 15s;
    }
'''
    backup = path.with_name('personal-site.before-metadata-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.write_text(original)
    path.write_text(original.replace(anchor, anchor + '\n' + route))
    result = subprocess.run(['nginx', '-t'], capture_output=True)
    if result.returncode:
        path.write_text(original)
        raise SystemExit('Nginx validation failed; restored original config')
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
print('Metadata webhook route configured')
