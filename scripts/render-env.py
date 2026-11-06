"""Render Actions Secrets to protected deployment files without logging values."""
import os
from pathlib import Path

def write(name, entries):
    lines = []
    for key, value in entries.items():
        if any(char in value for char in '\n\r\x00'):
            raise SystemExit(f'Invalid multiline environment variable: {key}')
        lines.append(f'{key}={value}')
    path = Path(name)
    path.write_text('\n'.join(lines) + '\n')
    path.chmod(0o600)

if not os.environ.get('WEBHOOK_URL', '').startswith('https://'):
    raise SystemExit('WEBHOOK_URL must be an HTTPS URL')

write('.env.production', {
    'NODE_ENV': 'production', 'BOT_MODE': 'webhook', 'PORT': '3000',
    'EXPECTED_DATABASE': 'telegram_metadata', 'DATABASE_POOL_MAX': '3',
    'WEBHOOK_URL': os.environ['WEBHOOK_URL'],
    'JAVINFO_BASE_URL': 'https://api.javinfo.dev',
    **{key: os.environ[key] for key in ['DATABASE_URL', 'BOT_TOKEN', 'JAVINFO_API_KEY', 'WEBHOOK_SECRET', 'ADMIN_TELEGRAM_ID']},
})
write('.env.migration', {'DATABASE_URL': os.environ['MIGRATION_DATABASE_URL']})
