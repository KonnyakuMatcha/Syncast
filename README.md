# Syncast

Syncast 是一个自托管的小型直播协作服务。公网服务器只负责网页、房间信令和 ICE 协商，屏幕、系统声音及独立麦克风轨道通过 WebRTC 在成员间直接传输，不提供服务器媒体中继。

## 工作方式

1. 所有成员通过 HTTPS 连接公网信令服务并加入房间。
2. 浏览器交换 SDP 与 ICE 候选，依次尝试局域网直连和 STUN 公网打洞。
3. 客户端拒绝 TURN `relay` 候选；无法完成 P2P 打洞的成员对会连接失败。
4. 屏幕默认采用房主到观众的星型 P2P；房主可开启“带宽分担”，由符合条件的桌面端成员中转画面和系统音频。语音始终采用成员间 mesh。

屏幕、标签页声音和浏览器支持的窗口专属音频来自 `getDisplayMedia`，麦克风来自独立的 `getUserMedia`，因此房主麦克风不会混入直播音轨。应用请求 `windowAudio: "window"` 并禁止整机音频：标签页和独立窗口音轨可以发送，整个屏幕模式只发送画面。选择器会尽量排除当前 Syncast 标签页。不要选择包含 Syncast 通话页面的浏览器窗口；游戏或独立播放器窗口是窗口音频的目标场景。单房间最多 12 人，公网日常使用建议不超过 8 人；本项目不提供 SFU 或 TURN，大房间和复杂 NAT 环境并不是目标场景。

观众可以独立选择观看质量，不影响房间内其他人：

| 档位 | 目标规格 | 最高视频码率 |
|---|---|---:|
| 流畅 | 720p30 | 5 Mbps |
| 清晰 | 1080p30 | 10 Mbps |
| 高帧 | 1080p60 | 20 Mbps |
| 极清 | 1440p30 | 24 Mbps |

默认使用“高帧”档位，以 1080p60 和最高 20 Mbps 发送，不再提供无约束的自动档位。观众仍可主动选择其他固定档位，且只影响自己的连接。实际分辨率、帧率和可用码率仍受共享源、浏览器、房主上行及观看端网络限制；WebRTC 在网络拥塞时仍会降低发送速率以维持连接。

共享来源音频和麦克风采用不同的编码策略：标签页或窗口音频使用 48 kHz 立体声 Opus、音乐内容提示和最高 192 kbps 发送码率，并关闭语音降噪、自动增益与 DTX；麦克风继续使用回声消除、降噪和自动增益。窗口音频取决于操作系统和浏览器支持，不支持时自动退回仅共享画面；单声道源不会被强制扩展为真实立体声。

## P2P 与带宽分担

STUN 只帮助浏览器发现公网地址，不转发媒体。服务端不会下发 TURN 地址，客户端也会丢弃 `relay` 候选，因此 NAT 穿透失败时不会占用 Syncast 服务器的媒体带宽，但对应成员也无法建立媒体连接。

“带宽分担”默认关闭。开启后，客户端依据已有语音 P2P 链路的连通性、往返延迟、设备类型和页面可见性选择中转节点。拓扑最多两层，每个中转节点最多服务 2 个下游；中转离开或链路失败时，房主会重新发布拓扑。该模式只转发舞台画面和系统音频，语音仍然保持 mesh。它会减少房主上行，但增加中转成员的上行、CPU 占用和一跳延迟。

手机和蜂窝网络可以作为普通观看或语音节点，但蜂窝网络常见的 CGNAT、对称 NAT 会降低打洞成功率。当前实现不会选择手机作为中转节点。由于没有 TURN，打洞失败时不会自动回退到服务器。

## 标准公网部署

准备一台有公网 IPv4 的 Linux 服务器、一个指向该服务器的域名，以及 Docker Compose。复制环境变量模板并填写真实值：

```bash
cp .env.example .env
```

`.env` 示例：

```dotenv
SYNCAST_DOMAIN=syncast.example.com
RTC_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
```

Docker Compose V2 构建并启动：

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

Caddy 会通过标准端口自动申请并续期 HTTPS 证书。若云厂商拦截标准 HTTP/HTTPS，请使用下一节的非标准端口部署，避免反复触发 ACME 验证。

## 非标准端口与手动证书

部分云厂商会在公网入口拦截未备案域名的 `80/443` HTTP 流量。此时可以在已放通的非标准端口提供 HTTPS，但浏览器仍要求域名匹配且由系统信任的证书。端口变化不会降低 HTTPS 的证书要求。

当前华为云实例使用：

- 访问地址：`https://hw.sharelter.online:8965/Syncast/`
- DERP 保留端口：`8964`，不要占用或停止
- 可信证书：`/opt/derp/cert/hw.sharelter.online.crt`
- 私钥：`/opt/derp/cert/hw.sharelter.online.key`
- 服务器本地覆盖文件：`Caddyfile.8965`、`compose.8965.yaml`

证书必须包含完整证书链、匹配私钥，并覆盖 `hw.sharelter.online`。不要把证书私钥提交到 Git。

`Caddyfile.8965` 只包含 Caddy 配置，文件开头不能出现 Markdown 代码围栏或 Compose 的 `caddy:` 字段：

```caddyfile
https://{$SYNCAST_DOMAIN}:8965 {
    tls /certs/{$SYNCAST_DOMAIN}.crt /certs/{$SYNCAST_DOMAIN}.key
    encode zstd gzip

    redir /Syncast /Syncast/ 308

    handle_path /Syncast/* {
        reverse_proxy syncast:8080
    }

    handle {
        respond "Not Found" 404
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        Referrer-Policy "same-origin"
        Permissions-Policy "camera=(), display-capture=(self), microphone=(self)"
    }
}
```

`compose.8965.yaml` 是 Compose 覆盖文件：

```yaml
services:
  caddy:
    ports:
      - "8965:8965"
      - "8965:8965/udp"
    volumes:
      - ./Caddyfile.8965:/etc/caddy/Caddyfile:ro
      - /opt/derp/cert:/certs:ro
```

先确认文件类型和 Caddy 配置，避免 Docker 把目录挂载到 `/etc/caddy/Caddyfile`：

```bash
test -f Caddyfile.8965
test -f compose.8965.yaml

sudo docker run --rm \
  -e SYNCAST_DOMAIN=hw.sharelter.online \
  -v "$PWD/Caddyfile.8965:/etc/caddy/Caddyfile:ro" \
  -v /opt/derp/cert:/certs:ro \
  caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile
```

旧版 `/usr/bin/docker-compose` 构建镜像：

```bash
sudo env PYTHONPATH=/usr/lib/python3/dist-packages \
  /usr/bin/docker-compose --env-file .env \
  -f compose.public.yaml -f compose.8965.yaml \
  build --pull
```

启动或更新服务：

```bash
sudo env PYTHONPATH=/usr/lib/python3/dist-packages \
  /usr/bin/docker-compose --env-file .env \
  -f compose.public.yaml -f compose.8965.yaml \
  up -d --remove-orphans
```

一次性拉取、构建并启动：

```bash
cd ~/Syncast
git pull origin main

sudo env PYTHONPATH=/usr/lib/python3/dist-packages \
  /usr/bin/docker-compose --env-file .env \
  -f compose.public.yaml -f compose.8965.yaml \
  up -d --build --remove-orphans
```

验证容器、HTTPS 和健康接口：

```bash
sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl --noproxy '*' -i https://hw.sharelter.online:8965/Syncast/api/health
```

## ZeroTier 可选组网

当公网 P2P 打洞经常失败时，可以让所有参与者加入同一个 ZeroTier 网络。只让 Syncast 服务器加入 ZeroTier 没有作用，因为服务器不转发媒体。浏览器还必须收集到 ZeroTier 虚拟网卡对应的 ICE 候选，系统防火墙也要允许该网卡上的 UDP 流量。

ZeroTier 能显著改善 CGNAT 环境的可达性，但不能保证底层始终物理直连；当 ZeroTier 自身打洞失败时，流量可能经过 ZeroTier 基础设施。手机还需要保持 ZeroTier VPN 在线，后台省电策略可能中断连接。可通过 `chrome://webrtc-internals` 检查最终选中的候选地址是否属于 ZeroTier 网段。

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

若要通过 ZeroTier 明确收集虚拟网卡候选，可以在 ZeroTier 网络中运行仅提供 STUN 的服务，并把其 ZeroTier 地址加入 `RTC_STUN_URLS`。不要配置 TURN 中继地址，否则仍会被 Syncast 客户端过滤。

## 日志与排障

标准 Compose V2：

```bash
docker compose --env-file .env -f compose.public.yaml ps
docker compose --env-file .env -f compose.public.yaml logs --tail=100 caddy syncast
```

华为云旧版 Compose：

```bash
sudo env PYTHONPATH=/usr/lib/python3/dist-packages \
  /usr/bin/docker-compose --env-file .env \
  -f compose.public.yaml -f compose.8965.yaml \
  logs --tail=100 caddy syncast
```

若本机访问正常而公网返回 `ADM/2.1.1` 或“非法阻断”，响应来自云厂商入口而不是 Caddy。若公网连接超时，依次检查云安全组、系统防火墙、Docker 端口映射和监听状态。

## 测试

```bash
python3 -m unittest discover -s tests -v
node tests/media.test.js
node tests/topology.test.js
node --check static/app.js
docker compose --env-file .env -f compose.public.yaml config --quiet
```
