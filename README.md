# Syncast

Syncast 是一个自托管的小型直播协作服务。公网服务器只负责网页、房间信令和 ICE 协商，屏幕、系统声音及独立麦克风轨道通过 WebRTC 在成员间直接传输，不提供服务器媒体中继。

## 工作方式

1. 所有成员通过 HTTPS 连接公网信令服务并加入房间。
2. 浏览器交换 SDP 与 ICE 候选，依次尝试局域网直连和 STUN 公网打洞。
3. 客户端拒绝 TURN `relay` 候选；无法完成 P2P 打洞的成员对会连接失败。
4. 屏幕默认从房主到观众的星型 P2P 开始；自动模式会在房主持续受限时启用浅层树状转发。语音始终采用成员间 mesh。

屏幕和共享来源声音来自 `getDisplayMedia`，麦克风来自独立的 `getUserMedia`，因此房主麦克风不会混入直播音轨。标签页使用浏览器提供的标签页独立音频；房主可在共享前选择窗口独立音频或系统混音，默认使用独立音频。共享整个屏幕时仍请求系统音频。系统混音可能包含 Syncast 播放的通话声音并形成回音。选择器会尽量排除当前 Syncast 标签页，直接共享 Syncast 自身标签页或窗口时仍会移除音轨。单房间最多 12 人，公网日常使用建议不超过 8 人；更大房间应改用 SFU。

### 动态树状转发

房主可以在通话频道标题旁选择直播连接方式：

- **自动**（新用户默认）：从直连开始。至少有四位观众且存在可中转成员时，每五秒检查视频发送统计；至少两条、且至少一半发送连接连续三次报告带宽或编码受限后，启用中转。启用后保持到本次共享结束或观众降至四人以下，避免压力下降后又反复切回。此判断是基于浏览器统计的启发式策略，不等同于测量房主总上行带宽。
- **优先直连**：始终由房主发送给所有观众，不自动启用成员中转；无法打洞时不会回退到服务器媒体中继。
- **节省上传**：主动使用浅层树状转发。通常房主只向三个第一层成员发送媒体，第一层成员再转发给叶节点。

树状模式最多经过一个中转成员，普通中转最多带三个子节点。识别为移动设备的客户端只作为叶节点；中转容量不足时，多出的观众回退到房主，因此房主的三条连接目标不是硬限制。规划优先保留健康分支；分配新连接时结合已有语音链路的可达性、往返延迟（RTT）、子节点数量，以及连续两次采样确认的编码 CPU 压力选择中转。健康报告过期后不再参与择优，不会仅因 RTT 波动重建已有分支。成员加入、离开或连接恢复失败时，房主串行发布带版本的拓扑，观众确认订阅后上游才建立新连接。

更换上游时，可用的旧连接最多保留三十秒；新连接实际解码出视频帧后再切换播放并释放旧连接，降低重连期间的黑屏概率。切换期间会短暂增加带宽和连接数。语音及画面连接均支持最多三轮 ICE 恢复；丢失的协商请求会重发，树状画面恢复失败后才尝试更换上游。失败路径暂时避让六十秒；恢复与更换上游均遵守纯 P2P 限制。

页面分别显示房间信令、直播和语音连接状态，并列出连接异常的成员。每五秒交换一次媒体计数和链路健康报告，报告有效期二十秒；发送端持续发送、接收端连续十五秒没有对应媒体进展时，触发恢复。静止画面、静音和主动关闭共享声音不单独作为故障依据。直播停滞先尝试 ICE 恢复，第二轮重建直播连接；共享音频未恢复时仍保留重试次数，避免循环重建。语音恢复独立处理，不打断正常直播。点击“重新连接”可重试异常连接并恢复播放，无需退出房间；没有已识别异常时，会主动重试现有媒体连接。

中转发生在成员浏览器之间，信令服务器不处理媒体；任意父子 WebRTC 连接都必须完成 P2P 打洞，不使用 TURN。浏览器中继会解码并重新编码远程轨道，可能增加延迟、CPU 占用和少量画质损失。中继节点固定向上游请求高帧画质，叶节点仍可以独立选择观看画质。

观众可以独立选择观看质量，不影响房间内其他人：

| 档位 | 目标规格 | 最高视频码率 |
|---|---|---:|
| 流畅 | 720p30 | 5 Mbps |
| 清晰 | 1080p30 | 10 Mbps |
| 高帧 | 1080p60 | 20 Mbps |
| 极清 | 1440p30 | 24 Mbps |

默认使用“高帧”档位，以 1080p60 和最高 20 Mbps 发送，不再提供无约束的自动档位。观众仍可主动选择其他固定档位，且只影响自己的连接。实际分辨率、帧率和可用码率仍受共享源、浏览器、房主上行及观看端网络限制；WebRTC 在网络拥塞时仍会降低发送速率以维持连接。

共享来源音频和麦克风采用不同的编码策略：系统、标签页或窗口音频使用 48 kHz 立体声 Opus、音乐内容提示和最高 192 kbps 发送码率，并关闭语音降噪、自动增益与 DTX；麦克风继续使用回声消除、降噪和自动增益。整屏及窗口音频取决于操作系统和浏览器支持，不支持时自动退回仅共享画面；单声道源不会被强制扩展为真实立体声。系统混音模式明确允许回音风险，生产使用建议优先选择窗口独立音频，或将通话和游戏音频路由到不同设备。

## P2P 与带宽分担

STUN 只帮助浏览器发现公网地址，不转发媒体。服务端不会下发 TURN 地址，客户端也会丢弃 `relay` 候选，因此 NAT 穿透失败时不会占用 Syncast 服务器的媒体带宽，但对应成员也无法建立媒体连接。

直播连接方式及中转限制见上文“动态树状转发”。成员中转只转发直播画面和共享来源音频，语音保持独立 mesh。

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
node tests/health.test.js
node --check static/app.js
docker compose --env-file .env -f compose.public.yaml config --quiet
```

浏览器功能测试使用 Playwright 驱动 Chromium，以合成画面、合成共享音频和虚拟麦克风验证真实 WebRTC 连接，不采集本机屏幕或麦克风：

```bash
python3 -m venv /tmp/syncast-test-venv
/tmp/syncast-test-venv/bin/pip install playwright
/tmp/syncast-test-venv/bin/playwright install chromium
/tmp/syncast-test-venv/bin/python tests/browser_functional.py
```

也可以通过 `SYNCAST_TEST_BROWSER` 指定已有 Chrome/Chromium 可执行文件，省略浏览器下载。测试通过实际解码帧和音频接收量增长验证媒体传输，覆盖五人语音、星型和树状共享、独立画质、共享重启后的静音保持、中转成员退出、房主关闭房间、麦克风权限拒绝与恢复、加入失败后的采集释放，以及窄屏操作栏。还覆盖延迟新上游时的旧画面保持、健康分支不重建、自动模式的持续压力门槛，以及注入 ICE 故障和丢失信令后的恢复与重试上限。新增测试覆盖连接仍正常时的媒体停滞检测、直播重建期间的语音保持、共享音频恢复前的重试计数、手动重连，以及编码压力报告的过期与中转选择。真实屏幕选择器、系统音频兼容性和公网 P2P 穿透仍需在目标设备及网络上验证。
