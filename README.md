# Syncast

Syncast 是一个自托管的小型直播协作服务。公网服务器只负责网页、房间信令和 ICE 协商，屏幕、系统声音及独立麦克风轨道通过 WebRTC 在成员间直接传输，不提供服务器媒体中继。

## 工作方式

1. 所有成员通过 HTTPS 连接公网信令服务并加入房间。
2. 浏览器交换 SDP 与 ICE 候选，依次尝试局域网直连和 STUN 公网打洞。
3. 客户端拒绝 TURN `relay` 候选；无法完成 P2P 打洞的成员对会连接失败。
4. 屏幕采用房主到观众的星型 P2P，语音采用成员间 mesh。

屏幕、标签页声音和浏览器支持的窗口专属音频来自 `getDisplayMedia`，麦克风来自独立的 `getUserMedia`，因此房主麦克风不会混入直播音轨。应用请求 `windowAudio: "window"` 并禁止整机音频：标签页和独立窗口音轨可以发送，整个屏幕模式只发送画面。选择器会尽量排除当前 Syncast 标签页。不要选择包含 Syncast 通话页面的浏览器窗口；游戏或独立播放器窗口是窗口音频的目标场景。单房间最多 12 人，公网日常使用建议不超过 8 人；更大房间应改用 SFU。

观众可以独立选择观看质量，不影响房间内其他人：

| 档位 | 目标规格 | 最高视频码率 |
|---|---|---:|
| 流畅 | 720p30 | 5 Mbps |
| 清晰 | 1080p30 | 10 Mbps |
| 高帧 | 1080p60 | 20 Mbps |
| 极清 | 1440p30 | 24 Mbps |

默认使用“高帧”档位，以 1080p60 和最高 20 Mbps 发送，不再提供无约束的自动档位。观众仍可主动选择其他固定档位，且只影响自己的连接。实际分辨率、帧率和可用码率仍受共享源、浏览器、房主上行及观看端网络限制；WebRTC 在网络拥塞时仍会降低发送速率以维持连接。

共享来源音频和麦克风采用不同的编码策略：标签页或窗口音频使用 48 kHz 立体声 Opus、音乐内容提示和最高 192 kbps 发送码率，并关闭语音降噪、自动增益与 DTX；麦克风继续使用回声消除、降噪和自动增益。窗口音频取决于操作系统和浏览器支持，不支持时自动退回仅共享画面；单声道源不会被强制扩展为真实立体声。

## 公网部署

准备一台有公网 IPv4 的 Linux 服务器、一个指向该服务器的域名，以及 Docker Compose。复制环境变量模板并填写真实值：

```bash
cp .env.example .env
```

`.env` 示例：

```dotenv
SYNCAST_DOMAIN=syncast.example.com
RTC_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
```

启动服务：

```bash
docker compose --env-file .env -f compose.public.yaml up -d --build
```

公网入口位于 `https://<SYNCAST_DOMAIN>/Syncast/`，健康检查位于
`https://<SYNCAST_DOMAIN>/Syncast/api/health`。路径区分大小写，末尾的 `/` 不可省略；
访问 `/Syncast` 时 Caddy 会自动跳转到规范地址。

需要在云防火墙和系统防火墙开放：

| 端口 | 协议 | 用途 |
|---|---|---|
| 80 | TCP | Caddy 申请证书及 HTTPS 跳转 |
| 443 | TCP、UDP | HTTPS 和 HTTP/3 信令 |

Caddy 自动申请 HTTPS 证书。STUN 使用外部公共服务，只发现参与者的公网候选地址，不转发媒体。服务端不会下发 TURN 地址，客户端也会丢弃 `relay` 候选，因此 NAT 穿透失败时不会占用服务器媒体带宽，但对应成员将无法建立媒体连接。

## 局域网启动

不需要第三方 Python 依赖：

```bash
python3 server.py
```

默认地址为 `https://localhost:8443`。其他设备可访问 `https://<主机局域网 IP>:8443`，首次打开需要接受本地自签名证书。未配置 `RTC_STUN_URLS` 时，浏览器只使用本地 ICE 候选。

仅限本机调试时可以关闭 TLS：

```bash
python3 server.py --host 127.0.0.1 --port 8080 --http
```

## 手动配置 ICE

不使用 Compose 时可设置：

```bash
export RTC_STUN_URLS='stun:rtc.example.com:3478'
python3 server.py
```

即使环境中存在旧的 `RTC_TURN_URLS` 或 TURN 凭据，服务端也会忽略它们。

## 测试

```bash
python3 -m unittest discover -s tests -v
node tests/media.test.js
node --check static/app.js
docker compose --env-file .env -f compose.public.yaml config --quiet
```
