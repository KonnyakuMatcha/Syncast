# Syncast

Syncast 是一个自托管的小型直播协作服务。公网服务器负责房间信令和 ICE 协商，屏幕、系统声音及独立麦克风轨道通过 WebRTC 在成员间直接传输；NAT 穿透失败时才回退到 TURN 中继。

## 工作方式

1. 所有成员通过 HTTPS 连接公网信令服务并加入房间。
2. 浏览器交换 SDP 与 ICE 候选，依次尝试局域网直连和 STUN 公网打洞。
3. 无法直连的成员对使用 TURN；媒体仍由 WebRTC 加密。
4. 屏幕采用房主到观众的星型 P2P，语音采用成员间 mesh。

屏幕和标签页声音来自 `getDisplayMedia`，麦克风来自独立的 `getUserMedia`，因此房主麦克风不会混入直播音轨。为防止通话声音经过系统总混音返回房间，只有浏览器标签页共享允许发送音频；窗口和整个屏幕模式只发送画面。选择器会尽量排除当前 Syncast 标签页。单房间最多 12 人，公网日常使用建议不超过 8 人；更大房间应改用 SFU。

观众可以独立选择观看质量，不影响房间内其他人：

| 档位 | 目标规格 | 最高视频码率 |
|---|---|---:|
| 自动 | 浏览器自适应 | 不额外限制 |
| 流畅 | 720p30 | 2.5 Mbps |
| 清晰 | 1080p30 | 5 Mbps |
| 高帧 | 1080p60 | 10 Mbps |
| 极清 | 1440p30 | 12 Mbps |

实际分辨率和帧率仍受共享源、浏览器、房主上行及观看端网络限制。只有存在“高帧”观众时，房主才会将屏幕采集提升到 60 FPS。

标签页音频和麦克风采用不同的编码策略：标签页音频使用 48 kHz 立体声 Opus、音乐内容提示和最高 192 kbps 发送码率，并关闭语音降噪、自动增益与 DTX；麦克风继续使用回声消除、降噪和自动增益。浏览器或操作系统只提供单声道源时不会被强制扩展为真实立体声。

## 公网部署

准备一台有公网 IPv4 的 Linux 服务器、一个指向该服务器的域名，以及 Docker Compose。复制环境变量模板并填写真实值：

```bash
cp .env.example .env
openssl rand -hex 32
```

`.env` 示例：

```dotenv
SYNCAST_DOMAIN=syncast.example.com
PUBLIC_IP=203.0.113.10
TURN_SECRET=上一步生成的随机值
```

启动服务：

```bash
docker compose --env-file .env -f compose.public.yaml up -d --build
```

需要在云防火墙和系统防火墙开放：

| 端口 | 协议 | 用途 |
|---|---|---|
| 80 | TCP | Caddy 申请证书及 HTTPS 跳转 |
| 443 | TCP、UDP | HTTPS 和 HTTP/3 信令 |
| 3478 | TCP、UDP | STUN/TURN |
| 49160–49200 | UDP | TURN 媒体中继 |

Caddy 自动申请 HTTPS 证书。Syncast 使用和 coturn 相同的 `TURN_SECRET` 生成一小时有效的 HMAC 临时凭据，长期密钥不会下发给浏览器。

## 局域网启动

不需要第三方 Python 依赖：

```bash
python3 server.py
```

默认地址为 `https://localhost:8443`。其他设备可访问 `https://<主机局域网 IP>:8443`，首次打开需要接受本地自签名证书。未配置 `RTC_STUN_URLS` 和 `RTC_TURN_URLS` 时，浏览器只使用本地 ICE 候选。

仅限本机调试时可以关闭 TLS：

```bash
python3 server.py --host 127.0.0.1 --port 8080 --http
```

## 手动配置 ICE

不使用 Compose 时可设置：

```bash
export RTC_STUN_URLS='stun:rtc.example.com:3478'
export RTC_TURN_URLS='turn:rtc.example.com:3478?transport=udp,turn:rtc.example.com:3478?transport=tcp'
export RTC_TURN_SECRET='与 coturn static-auth-secret 相同的随机值'
python3 server.py
```

也支持 `RTC_TURN_USERNAME` 和 `RTC_TURN_PASSWORD` 静态认证，但公网部署推荐使用临时凭据。

## 测试

```bash
python3 -m unittest discover -s tests -v
node tests/media.test.js
node --check static/app.js
docker compose --env-file .env -f compose.public.yaml config --quiet
```
