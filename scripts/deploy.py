"""Deploy script - pull, build, restart, and fix panel NGINX config."""

import paramiko
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("65.21.144.139", username="root", password="TwFsMXnfwXMm")


def run(cmd, timeout=120):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip():
        print(out)
    if err.strip():
        print(err)
    return out, err


# 1. Git pull
run("cd /opt/panel && git fetch origin main && git reset --hard origin/main")

# 2. Go build
run(
    "cd /opt/panel/backend && CGO_ENABLED=0 /usr/local/go/bin/go build -o /opt/panel/backend/panel-server ."
)

# 3. Frontend build
run("cd /opt/panel/frontend && npm run build 2>&1 | tail -5")

# 4. Make scripts executable
run("chmod +x /opt/panel/scripts/*.sh")

# 5. Fix the panel's own NGINX config (X-Forwarded-Proto)
run(
    "sed -i 's/X-Forwarded-Proto \\$scheme/X-Forwarded-Proto https/' /etc/nginx/sites-available/panel"
)
run("grep X-Forwarded-Proto /etc/nginx/sites-available/panel")

# 6. Test and reload NGINX
run('nginx -t 2>&1 && systemctl reload nginx && echo "NGINX reloaded"')

# 7. Restart panel backend
run("pm2 restart panel-backend")

# 8. Flush rate limits
run('redis-cli KEYS "rate_limit*" | xargs -r redis-cli DEL')

print("\n=== Deploy complete ===")
ssh.close()
