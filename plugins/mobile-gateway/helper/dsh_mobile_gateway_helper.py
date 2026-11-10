#!/usr/bin/env python3
# Managed by dsh-plugin-mobile-gateway
"""Root-only, deliberately narrow system helper for the mobile gateway."""

import argparse
import ipaddress
import json
import os
import pathlib
import re
import shutil
import socketserver
import subprocess
import sys


VERSION = 1
MARKER = "# Managed by dsh-plugin-mobile-gateway"
SOCKET_PATH = "/run/dsh-mobile-gateway/helper.sock"
CONFIG_DIR = pathlib.Path("/etc/dsh-mobile-gateway")
PUBLIC_URL_FILE = CONFIG_DIR / "public-url"
NGINX_CONFIG = pathlib.Path("/etc/nginx/conf.d/dsh-mobile-gateway.conf")
WEBROOT = pathlib.Path("/var/lib/dsh-mobile-gateway/acme")
CERTBOT_HOME = pathlib.Path("/opt/dsh-mobile-gateway/certbot")
CERTBOT = CERTBOT_HOME / "bin/certbot"


def run(args):
    subprocess.run(args, check=True)


def atomic_managed_write(target, content, mode=0o644):
    target = pathlib.Path(target)
    if target.exists() and not target.read_text(encoding="utf-8").startswith(MARKER):
        raise RuntimeError(f"refusing to overwrite unmanaged file: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, target)


def validate_public_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise ValueError("publicIp must be a valid IPv4 address") from error
    if address.version != 4 or not address.is_global:
        raise ValueError("publicIp must be a public IPv4 address")
    return str(address)


def validate_port(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 65535:
        raise ValueError("backendPort must be an integer between 1 and 65535")
    return value


def certificate_name(public_ip):
    return f"dsh-mobile-gateway-{public_ip.replace('.', '-')}"


def nginx_http_config(public_ip):
    return f"""{MARKER}
server {{
    listen 80;
    server_name {public_ip};

    location ^~ /.well-known/acme-challenge/ {{
        root {WEBROOT};
        default_type text/plain;
    }}

    location / {{ return 404; }}
}}
"""


def nginx_tls_config(public_ip, backend_port):
    live = f"/etc/letsencrypt/live/{certificate_name(public_ip)}"
    return nginx_http_config(public_ip) + f"""
server {{
    listen 443 ssl;
    server_name {public_ip};
    server_tokens off;
    access_log off;

    ssl_certificate {live}/fullchain.pem;
    ssl_certificate_key {live}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location = /ws/mobile {{
        if ($args != \"\") {{ return 404; }}
        proxy_pass http://127.0.0.1:{backend_port};
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:{backend_port};
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }}

    location / {{ return 404; }}
}}
"""


def current_status():
    public_url = None
    if PUBLIC_URL_FILE.exists():
        public_url = next((line.strip() for line in PUBLIC_URL_FILE.read_text(encoding="utf-8").splitlines()
                           if line.strip().startswith("wss://")), None)
    backend_port = None
    if NGINX_CONFIG.exists():
        match = re.search(r"proxy_pass http://127\.0\.0\.1:(\d+);", NGINX_CONFIG.read_text(encoding="utf-8"))
        if match:
            backend_port = int(match.group(1))
    return {
        "installed": True,
        "version": VERSION,
        "configured": bool(public_url and backend_port),
        "publicUrl": public_url,
        "backendPort": backend_port,
    }


def ensure_dependencies():
    if not shutil.which("nginx") or not CERTBOT.exists():
        raise RuntimeError("helper dependencies are missing; rerun init to repair the installation")


def configure(public_ip, backend_port):
    public_ip = validate_public_ip(public_ip)
    backend_port = validate_port(backend_port)
    previous = NGINX_CONFIG.read_bytes() if NGINX_CONFIG.exists() else None
    if previous is not None and not previous.decode("utf-8").startswith(MARKER):
        raise RuntimeError(f"refusing to overwrite unmanaged file: {NGINX_CONFIG}")

    ensure_dependencies()
    (WEBROOT / ".well-known/acme-challenge").mkdir(parents=True, exist_ok=True)
    try:
        atomic_managed_write(NGINX_CONFIG, nginx_http_config(public_ip))
        run(["nginx", "-t"])
        run(["systemctl", "enable", "--now", "nginx"])
        run(["systemctl", "reload", "nginx"])

        args = [
            str(CERTBOT), "certonly", "--non-interactive", "--agree-tos",
            "--preferred-profile", "shortlived", "--webroot", "--webroot-path", str(WEBROOT),
            "--ip-address", public_ip, "--cert-name", certificate_name(public_ip),
            "--keep-until-expiring", "--register-unsafely-without-email",
        ]
        run(args)
        atomic_managed_write(NGINX_CONFIG, nginx_tls_config(public_ip, backend_port))
        atomic_managed_write(PUBLIC_URL_FILE, f"{MARKER}\nwss://{public_ip}/ws/mobile\n")
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
    except Exception:
        if previous is None:
            NGINX_CONFIG.unlink(missing_ok=True)
        else:
            NGINX_CONFIG.write_bytes(previous)
        if shutil.which("nginx"):
            subprocess.run(["nginx", "-t"], check=False)
            subprocess.run(["systemctl", "reload", "nginx"], check=False)
        raise
    return current_status()


def dispatch(message):
    action = message.get("action")
    if action == "status":
        return current_status()
    if action == "configure":
        return configure(message.get("publicIp"), message.get("backendPort"))
    raise ValueError("unsupported helper action")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            raw = self.rfile.readline(65537)
            if not raw or len(raw) > 65536:
                raise ValueError("invalid helper request")
            message = json.loads(raw.decode("utf-8"))
            if not isinstance(message, dict):
                raise ValueError("helper request must be an object")
            response = {"ok": True, "result": dispatch(message)}
        except Exception as error:  # Return a typed error; never expose a traceback.
            response = {"ok": False, "error": str(error)}
        self.wfile.write((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))


class Server(socketserver.UnixStreamServer):
    allow_reuse_address = True


def serve(uid, socket_path):
    if os.geteuid() != 0:
        raise RuntimeError("helper must run as root")
    path = pathlib.Path(socket_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    with Server(str(path), Handler) as server:
        os.chown(path, uid, -1)
        os.chmod(path, 0o600)
        server.serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--socket", default=SOCKET_PATH)
    options = parser.parse_args()
    if options.uid < 1:
        raise ValueError("uid must identify a non-root user")
    serve(options.uid, options.socket)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"dsh-mobile-gateway-helper: {error}", file=sys.stderr)
        raise SystemExit(1)
