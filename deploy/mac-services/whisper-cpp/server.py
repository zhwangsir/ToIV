#!/usr/bin/env python3
"""OpenAI-compatible shim for whisper.cpp /inference server.

Listens on :9212 and forwards /v1/audio/transcriptions to a local
whisper-server instance running on :9213. The shim also manages the
whisper-server subprocess.
"""
import http.server
import socketserver
import subprocess
import sys
import time
import urllib.request
import urllib.error

WHISPER_BIN = "/Users/dgmt-studio02/toiv-whisper-cpp/whisper.cpp-repo/build/bin/whisper-server"
MODEL_PATH = "/Users/dgmt-studio02/toiv-whisper-cpp/models/ggml-large-v3-turbo.bin"
WHISPER_HOST = "127.0.0.1"
WHISPER_PORT = 9213
WHISPER_URL = f"http://{WHISPER_HOST}:{WHISPER_PORT}/inference"
LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 9212


def start_whisper_server():
    proc = subprocess.Popen(
        [
            WHISPER_BIN,
            "-m", MODEL_PATH,
            "--host", "0.0.0.0",
            "--port", str(WHISPER_PORT),
            "-l", "auto",
            "--threads", "8",
        ],
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    # Wait until healthy
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://{WHISPER_HOST}:{WHISPER_PORT}/health", timeout=2) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            pass
        if proc.poll() is not None:
            raise RuntimeError(f"whisper-server exited early with code {proc.returncode}")
        time.sleep(1)
    proc.terminate()
    raise RuntimeError("whisper-server did not become healthy in time")


class ShimHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {args[0]}\n")

    def send_response_body(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_post(self, target_url):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        req = urllib.request.Request(
            target_url,
            data=body,
            headers={"Content-Type": self.headers.get("Content-Type", "")},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                resp_body = resp.read()
                self.send_response_body(resp.status, resp_body, resp.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            err_body = e.read()
            self.send_response_body(e.code, err_body, e.headers.get("Content-Type", "application/json"))
        except Exception as e:
            self.send_response_body(502, f'{"error":"{e}"}'.encode())

    def do_GET(self):
        if self.path == "/health":
            self.send_response_body(200, b'{"status":"ok"}')
        else:
            self.send_response_body(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path == "/v1/audio/transcriptions":
            self.proxy_post(WHISPER_URL)
        else:
            self.send_response_body(404, b'{"error":"not found"}')


if __name__ == "__main__":
    print("Starting whisper-server subprocess...", flush=True)
    whisper_proc = start_whisper_server()
    print(f"whisper-server ready (pid {whisper_proc.pid}). Starting OpenAI shim...", flush=True)
    try:
        with socketserver.ThreadingTCPServer((LISTEN_HOST, LISTEN_PORT), ShimHandler) as httpd:
            print(f"OpenAI shim listening on {LISTEN_HOST}:{LISTEN_PORT} -> {WHISPER_URL}", flush=True)
            httpd.serve_forever()
    finally:
        whisper_proc.terminate()
        try:
            whisper_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            whisper_proc.kill()
