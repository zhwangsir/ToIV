"""端到端验证数字人 WebRTC 链路(模拟浏览器,host candidate 不走 mDNS)。

依赖: pip install aiortc(独立 venv,非项目依赖)。
流程: 登录 core → 建会话 → start → ice-config → aiortc offer/answer → 等媒体轨。
用法: python webrtc_e2e_test.py
"""
import asyncio
import json
import sys
import urllib.request

from aiortc import RTCIceServer, RTCPeerConnection, RTCSessionDescription, RTCConfiguration

API = "http://192.168.71.47:8090"


def http(method, url, body=None, token=None, timeout=30):
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return json.loads(r.read())


async def main() -> int:
    relay_only = "--relay" in sys.argv
    token = http("POST", f"{API}/api/auth/login",
                 {"email": "admin", "password": "admin123"})["token"]
    sess = http("POST", f"{API}/api/opentalking/sessions", {
        "avatar_id": "anchor", "model": "quicktalk",
        "tts_provider": "indextts", "stt_provider": "sensevoice",
        "agent_enabled": True, "user_id": "toiv-user"}, token)
    sid = sess["session_id"]
    print("session:", sid)
    st = http("POST", f"{API}/api/opentalking/sessions/{sid}/start", {}, token)
    print("start:", st)

    ice = http("GET", f"{API}/api/opentalking/sessions/webrtc/ice-config", None, token)
    print("ice-config:", ice)
    servers = [RTCIceServer(urls=s["urls"],
                            username=s.get("username"),
                            credential=s.get("credential"))
               for s in ice.get("iceServers", [])]
    pc = RTCPeerConnection(RTCConfiguration(iceServers=servers))
    got_tracks = []
    conn_state = {"state": "new"}

    @pc.on("track")
    def on_track(track):
        got_tracks.append(track.kind)
        print("TRACK:", track.kind)

    @pc.on("connectionstatechange")
    async def on_state():
        conn_state["state"] = pc.connectionState
        print("state:", pc.connectionState)

    pc.addTransceiver("video", direction="recvonly")
    pc.addTransceiver("audio", direction="recvonly")
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    # 等待 ICE gathering 完成(host 候选,无 mDNS 混淆)
    while pc.iceGatheringState != "complete":
        await asyncio.sleep(0.2)
    answer = http("POST", f"{API}/api/opentalking/sessions/{sid}/webrtc/offer", {
        "sdp": pc.localDescription.sdp, "type": "offer"}, token, timeout=60)
    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"],
                                                        type=answer["type"]))

    deadline = asyncio.get_event_loop().time() + 25
    while asyncio.get_event_loop().time() < deadline:
        if pc.connectionState in ("connected", "failed", "closed"):
            break
        await asyncio.sleep(0.5)

    ok = pc.connectionState == "connected"
    if ok:
        # 触发一句 TTS,等音频帧
        http("POST", f"{API}/api/opentalking/sessions/{sid}/speak",
             {"text": "你好"}, token)
        await asyncio.sleep(8)
    print("RESULT:", "CONNECTED" if ok else f"FAILED state={pc.connectionState}",
          "tracks:", got_tracks)
    try:
        http("POST", f"{API}/api/opentalking/sessions/{sid}/interrupt", {}, token)
    except Exception:
        pass
    await pc.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
