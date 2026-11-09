# Syncast

Syncast 是一个自托管的小型直播协作服务。默认通过 WebRTC 在成员间传输媒体；也可在 VPS 上启用 LiveKit SFU，让房主上传一条可分层视频轨道和共享声音，由服务器按观众选择的层分发给每个人。房主可在房间内选择“服务器广播”，或继续使用原有直连和成员中转。服务器广播模式下，所有成员的麦克风通话也通过 SFU 转发，保留独立音轨；其他模式使用成员间 P2P。

## 工作方式

1. 所有成员通过 HTTPS 连接公网信令服务并加入房间。
2. 默认模式下，浏览器交换 SDP 与 ICE 候选，依次尝试局域网直连和 STUN 公网打洞。P2P 连接仍拒绝 TURN `relay` 候选。
3. 屏幕默认从房主到观众的星型 P2P 开始；自动模式会在房主持续受限时启用浅层树状转发。
4. 启用并选择“服务器广播”后，房主和观众分别连接 VPS 上的 SFU，画面、共享声音及所有成员的麦克风均经过服务器转发，不需要成员之间 P2P 打洞。未共享屏幕时也可以通过服务器通话。

屏幕和共享来源声音来自 `getDisplayMedia`，麦克风来自独立的 `getUserMedia`，因此房主麦克风不会混入直播音轨。标签页使用浏览器提供的标签页独立音频；房主可在共享前选择窗口独立音频或系统混音，默认使用独立音频。共享整个屏幕时仍请求系统音频。系统混音可能包含 Syncast 播放的通话声音并形成回音。选择器会尽量排除当前 Syncast 标签页，直接共享 Syncast 自身标签页或窗口时仍会移除音轨。单房间仍最多 12 人，P2P 模式公网日常使用建议不超过 8 人；启用广播仍保持 12 人上限。

### 动态树状转发

房主可以在通话频道标题旁选择直播连接方式：

- **自动**（新用户默认）：从直连开始。至少有四位观众且存在可中转成员时，每五秒检查视频发送统计；至少两条、且至少一半发送连接连续三次报告带宽或编码受限后，启用中转。启用后保持到本次共享结束或观众降至四人以下，避免压力下降后又反复切回。此判断是基于浏览器统计的启发式策略，不等同于测量房主总上行带宽。
- **优先直连**：始终由房主发送给所有观众，不自动启用成员中转；无法打洞时不会回退到服务器媒体中继。
- **节省上传**：主动使用浅层树状转发。通常房主只向三个第一层成员发送媒体，第一层成员再转发给叶节点。
- **服务器广播**：需要部署者启用。房主上传一条带多层编码的视频轨道及一路共享音频，VPS 按观众选择的画质层分发；各成员的麦克风也经 VPS 转发，不使用成员直连或观众浏览器转发。广播与 P2P 模式可以在共享中切换，画面和语音切换时可能短暂停顿。

树状模式最多经过一个中转成员，普通中转最多带三个子节点。识别为移动设备的客户端只作为叶节点；中转容量不足时，多出的观众回退到房主，因此房主的三条连接目标不是硬限制。规划优先保留健康分支；分配新连接时结合已有语音链路的可达性、往返延迟（RTT）、子节点数量，以及连续两次采样确认的编码 CPU 压力选择中转。健康报告过期后不再参与择优，不会仅因 RTT 波动重建已有分支。成员加入、离开或连接恢复失败时，房主串行发布带版本的拓扑，观众确认订阅后上游才建立新连接。

更换上游时，可用的旧连接最多保留三十秒；新连接实际解码出视频帧后再切换播放并释放旧连接，降低重连期间的黑屏概率。切换期间会短暂增加带宽和连接数。语音及画面连接均支持最多三轮 ICE 恢复；丢失的协商请求会重发，树状画面恢复失败后才尝试更换上游。失败路径暂时避让六十秒；恢复与更换上游均遵守纯 P2P 限制。

页面分别显示房间信令、直播和语音连接状态，并列出连接异常的成员。每五秒交换一次媒体计数和链路健康报告，报告有效期二十秒；发送端持续发送、接收端连续十五秒没有对应媒体进展时，触发恢复。静止画面、静音和主动关闭共享声音不单独作为故障依据。直播停滞先尝试 ICE 恢复，第二轮重建直播连接；共享音频未恢复时仍保留重试次数，避免循环重建。语音恢复独立处理，不打断正常直播。点击“重新连接”可重试异常连接并恢复播放，无需退出房间；没有已识别异常时，会主动重试现有媒体连接。

中转发生在成员浏览器之间，信令服务器不处理媒体；任意父子 WebRTC 连接都必须完成 P2P 打洞，不使用 TURN。浏览器中继会解码并重新编码远程轨道，可能增加延迟、CPU 占用和少量画质损失。中继节点固定向上游请求 1080p60，叶节点仍可以独立选择分辨率和帧率。

客户端的画质控件分为分辨率和帧率两个独立选项。观众可以组合出以下规格，且只影响自己的连接：

| 分辨率 | 帧率 | 最高视频码率 |
|---|---|---:|
| 720p | 30 fps | 5 Mbps |
| 720p | 60 fps | 5 Mbps |
| 1080p | 30 fps | 10 Mbps |
| 1080p | 60 fps | 20 Mbps |

P2P 默认选择 1080p 和 60 fps，以最高 20 Mbps 发送，不提供无约束的自动档位。服务器广播使用下方的高清、均衡或流畅发布档位。实际分辨率、帧率和可用码率仍受共享源、浏览器、房主上行及观看端网络限制；WebRTC 在网络拥塞时仍会降低发送速率以维持连接。

共享来源音频和麦克风采用不同的编码策略：系统、标签页或窗口音频使用 48 kHz 立体声 Opus、音乐内容提示和最高 192 kbps 发送码率，并关闭语音降噪、自动增益与 DTX；麦克风继续使用回声消除、降噪和自动增益。整屏及窗口音频取决于操作系统和浏览器支持，不支持时自动退回仅共享画面；单声道源不会被强制扩展为真实立体声。系统混音模式明确允许回音风险，生产使用建议优先选择窗口独立音频，或将通话和游戏音频路由到不同设备。

## P2P 与带宽分担

STUN 只帮助浏览器发现公网地址，不转发媒体。原有 P2P 连接不会使用 TURN，因此 NAT 穿透失败时对应成员无法建立直接媒体连接。服务器广播使用独立的 LiveKit WebRTC 连接，不依赖成员之间打洞；需要浏览器能访问 VPS 的媒体端口。

直播连接方式及中转限制见上文“动态树状转发”。成员中转只转发直播画面和共享来源音频，语音保持独立 mesh。

手机和蜂窝网络可以作为普通观看或语音节点，但蜂窝网络常见的 CGNAT、对称 NAT 会降低打洞成功率。当前实现不会选择手机作为中转节点。P2P 打洞失败时不会自动切换模式；房主可以主动选择已启用的服务器广播来传输直播。服务器广播中的语音同样不依赖成员之间打洞；各客户端必须能访问 VPS 媒体端口。

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

## 可选的 VPS 服务器广播

服务器广播由 **LiveKit SFU 1.13.11** 提供，浏览器 SDK **2.23.0** 已随项目提供，不依赖 CDN。SFU 转发媒体包，不在 VPS 上解码或重新编码视频。不开启时，原来的部署命令和 P2P 行为不变。

### 使用效果与边界

- 房主在“直播连接方式”选择 **服务器广播**，观众自动跟随。没有配置时该选项不可用。
- WebRTC 模式的画面路径为 `房主 → VPS → 各观众`。提供“高清”档：720p60 / 5 Mbps 与 1080p60 / 20 Mbps 两层 VP8 编码，高清视频上限可在房主界面选择 12/20/30/40 Mbps，对应总视频预算约 15/25/35/45 Mbps；“均衡”档为 2 + 6 Mbps，合计约 8 Mbps，不再额外编码一层 1080p30。观众仍可独立选择 720p/1080p、30/60 帧，同一分辨率通过时间层限制帧率。高档观众存在时，低层也可能保留用于拥塞降档，不能假定 dynacast 一定只上传一层。VPS 按每位观众的选择与链路条件转发。共享音频最高 192 kbps，并启用 Opus RED 冗余抵抗丢包；协议、冗余和重传会增加实际流量。
- WebRTC 模式下观众可分别选择 720p 或 1080p，以及 30 fps 或 60 fps；选择只影响自己的订阅。720p 使用低层，1080p 使用高层，30/60 fps 通过时间层上限区分。最高发布层为 1080p60。实际质量仍受共享源、浏览器、房主编码能力和观看端网络限制。
- 麦克风作为独立音轨经 VPS 转发，房主也会接收其他成员的语音。选择服务器广播后即建立服务器通话，停止共享只撤下画面和共享声音，通话继续。麦克风静音与共享声音开关互不影响，拒绝麦克风权限仍可收听，之后可点击麦克风按钮重新授权。最多 12 人的限制保持不变。
- 广播模式关闭成员间的画面和语音连接，新加入成员直接使用服务器；连接失败时不会自动回退 P2P。房主主动切回自动、优先直连或节省上传时，才恢复成员间语音。
- 房主可在共享期间切换“广播画质”：**高清 · 1080p60**（25 Mbps 总视频上限）和 **均衡 · 1080p60**（8 Mbps 总视频上限）保留独立观众画质；**流畅 · 720p30** 仅发送一路最高 2 Mbps 视频。流畅档是整场视频上限，观众选择更高规格也不会超过此上限。切档只更换视频，保持共享声音与麦克风；视频可能短暂停顿。新浏览器默认使用高清档，房主可按线路情况主动选择均衡或流畅；选择保存在房主当前浏览器。
- 广播视频优先保持帧率，编码或网络受限时允许降低分辨率，避免为保留清晰度而持续掉帧。成员加入、离开或切换麦克风时，复用当前播放器，避免重新加载同一条共享流导致画面和共享声音停顿。
- 直播状态和拓扑会显示广播服务器；LiveKit 自动处理短暂断线，失败时显示重连提示，可点击“重新连接”或由房主切回 P2P。广播的画面和语音均由 LiveKit 管理重连，不使用原有成员间的媒体停滞检测。
- 浏览器到 SFU 的传输加密在服务器终止，VPS 是受信任的媒体处理节点；此模式不是成员之间的端到端加密。

### 广播卡顿排查

VPS 的标称带宽不代表房主到 VPS、VPS 到每位观众的实际吞吐或丢包率。最多六人时，五名观众都接收高清档最高 20 Mbps 视频的总出口约 100 Mbps（均衡档约 30 Mbps），再加音频、协议及重传；即使总带宽足够，跨运营商线路、UDP 丢包或房主多层编码仍可能导致卡顿。通话语音码率较低，语音流畅不能证明共享画面链路没有拥塞。

共享时打开连接面板中的 **共享流统计**，房主和观众分别查看：

- 房主：实际编码帧率、所有活动视频层的总发送码率，以及浏览器报告的编码处理或发送带宽限制。
- 观众：实际接收分辨率和解码帧率、视频及共享声音码率、最近采样间隔的丢包、平均抖动缓冲驻留时间和新增画面停顿次数。
- 浏览器提供时显示本机到 VPS 的 UDP/TCP 路径及往返时间。它不是房主到观众的端到端延迟，缓冲数值也不能当作完整延迟。浏览器未提供的字段不显示；首次采样、换层或重连需要重新建立统计基线。

统计每五秒更新。若使用 TCP，先确认 VPS 云安全组和主机防火墙的 `7882/UDP` 可达；TCP 丢包重传可能阻塞后续媒体。信令可经过 Cloudflare，媒体必须直达 VPS 公网 IP。

可先让房主选择 **流畅 · 720p30** 做对照，将全场视频上传预算收敛到 2 Mbps。也可只让观众选择 `720p / 30 帧`，但这只是订阅偏好，不等同于房主流畅发布档。只降低一位观众的画质不会消除其他观众要求的高码率层；720p30/60 共用 720p 编码层，订阅 30 帧也不保证房主编码量减半。若明显改善，再逐步升至 1080p30/60，结合统计区分房主上传/编码与观众接收问题。SFU 不转码，VPS 不需要为每位观众重新编码视频。

### 可靠高清与低延迟 WebRTC

服务器广播提供两种共享流传输方式，房主可以在底部“广播传输”选择：

- **可靠高清**（新浏览器默认）：通过有界并行 HTTPS 片段上传 WebM，服务器按序重组，再通过有界 HTTPS 片段向各观众分发。共享画面与共享声音作为同一条可靠字节流传输，用 TCP 恢复丢包，避免关键帧因 UDP 丢包损坏。目标约 1–2 秒播放缓冲，弱网、浏览器解码和代理仍可能增加延迟。麦克风通话继续走 LiveKit，不依赖 P2P，且不增加视频缓冲。
- **WebRTC**：保留原有低延迟 SFU 传输及观众独立分辨率/帧率选择。适合更看重交互延迟的场景。

可靠高清使用房主统一的视频规格，观众个人画质选择器在此模式隐藏；切回 WebRTC 后恢复个人设置。新浏览器的可靠模式默认以 12 Mbps 为视频编码目标，可选择 20/30/40 Mbps；MediaRecorder 的码率是编码目标而非严格流量上限，音频、关键帧和封装也占带宽。静止画面不会为了凑码率而填充无用数据。切换传输方式、码率或源需要重新缓冲，麦克风通话保持。

可靠模式当前需要支持 MediaRecorder + MediaSource WebM VP8/Opus 的浏览器，推荐近期 Chrome/Edge。不支持的客户端会显示提示，可让房主选择 WebRTC。服务器不转码，已排序媒体缓存每房间最多 16 MiB，另有最多 16 MiB 乱序上传窗口，观众中途加入从缓存关键帧开始，落后过多的观众会重新追到直播附近。断开后继续从已确认的字节位置下载，缓存过期时重取初始化与关键帧。上传数据只有当前房主可以发布，下载必须具有当前房间的有效会话。

可靠广播使用现有 HTTP 代理路由，不需要新增公网端口或 WebSocket 路由。Nginx 等代理的请求体上限至少设为 `5m`，关闭代理缓冲和缓存：

```nginx
client_max_body_size 5m;
proxy_buffering off;
proxy_request_buffering off;
proxy_cache off;
```

片段返回 `Content-Length` 和 `Cache-Control: no-store, no-transform`，不应被 CDN 缓存。上传最多四个并行请求，具有片段序号、重复 ACK 幂等处理和有界乱序重组，避免每 200 毫秒片段都等待一个完整网络往返。房主上传线路必须能持续承载编码目标；所有观众共用一条线路时，也需要满足视频码率乘观众人数的下载需求。LiveKit WebRTC 端口仍用于语音和低延迟模式。

### 高码率重传恢复配置

LiveKit 默认视频包缓存仅 500 个。在 20 Mbps、每包约 1200 字节时，只覆盖约 0.24 秒；跨网乱序或多轮重传可能超过这个范围。高码率广播使用以下配置，Compose 广播覆盖文件已包含：

```yaml
rtc:
  packet_buffer_size_video: 4096
  packet_buffer_size_audio: 1024
```

这是用于 NACK 重传恢复的缓存，不是额外的播放器排队时长。缓存会增加媒体服务内存占用，且无法修复持续拥塞或链路吞吐不足。原生部署在 LiveKit 配置的 `rtc` 下加入上述字段，配置校验后重启 LiveKit；重启会断开现有媒体会话。若日志出现 `old packet, cannot be sequenced` 或 `could not add packet to bucket`，应检查此缓存与实际码率、往返时间是否匹配。

WebRTC 模式的共享画面和共享声音在支持的浏览器中使用 500 毫秒目标抖动缓冲，以便重传及时恢复；麦克风语音不增加该缓冲。浏览器可以因网络、音画同步和解码状态调整实际缓冲，这不是端到端延迟保证。

12 Mbps 选项保留 1080p60，低清层上限为 3 Mbps。多名观众共用同一条约 100 Mbps 接入时，五路 20 Mbps 视频另加音频和重传可能已超过接入能力；可先用五路 12 Mbps 留出恢复余量，再根据实际线路升档。

### 从旧版服务器广播升级

已启用 LiveKit 的部署无需新增环境变量或端口。拉取最新主线后，使用原有 Compose 文件组合执行 `up -d --build`，更新 Syncast 后端和网页。直播状态现在经服务端保存和广播，加入和手动重连会重取快照；模式切换的状态恢复不依赖单次请求响应到达。更新后所有成员应刷新网页以使用同一协议。重启会清空房间，所有成员需要刷新网页并重新加入，以获得麦克风发布权限和新的房间模式协议。

### 标准 HTTPS 部署

在 `.env` 中追加（IP 和 secret 必须替换）：

```dotenv
SYNCAST_PUBLIC_IP=203.0.113.10
LIVEKIT_API_KEY=syncast
LIVEKIT_API_SECRET=替换为随机密钥
```

用 `openssl rand -hex 32` 生成密钥，粘贴到 `LIVEKIT_API_SECRET`。API key 使用字母数字，secret 使用生成的十六进制值。`SYNCAST_PUBLIC_IP` 必须是浏览器可达的 VPS 公网 IPv4。不要把 `.env` 提交到 Git。

```bash
docker compose --env-file .env \
  -f compose.public.yaml -f compose.broadcast.yaml config --quiet

docker compose --env-file .env \
  -f compose.public.yaml -f compose.broadcast.yaml up -d --build
```

除原有 HTTPS 端口外，在云安全组和系统防火墙放行：

| 端口 | 协议 | 用途 |
|---|---|---|
| 7881 | TCP | WebRTC TCP，UDP 不可用时使用 |
| 7882 | UDP | WebRTC 音视频 |

端口映射必须保持同号。媒体端口直接到 VPS，不能通过普通 HTTP/CDN 代理。`7880` 只在 Compose 内网提供 LiveKit API；浏览器信令通过 Caddy 的 `/Syncast/sfu/` 路由连接。此配置针对单台 Linux VPS，不要求 Redis，不启用 TURN。

```bash
docker compose --env-file .env \
  -f compose.public.yaml -f compose.broadcast.yaml logs --tail=100 livekit syncast caddy
```

`/Syncast/api/health` 的 `broadcast.configured: true` 表示 Syncast 配置已就绪，**不代表 SFU 或公网媒体端口已通过检查**。部署后用不同网络的两台设备实际共享并观看，确认画面、共享声音和“服务器广播 · 上传 1 路 · 多层”状态。

### 已使用 8965 等非标准 HTTPS 端口

保留已有证书及 HTTPS 配置，在 `.env` 另加：

```dotenv
SYNCAST_LIVEKIT_URL=wss://hw.sharelter.online:8965/Syncast/sfu
```

在自己的 `Caddyfile.8965` 中、`handle_path /Syncast/*` **之前**加入：

```caddyfile
handle_path /Syncast/sfu/* {
    reverse_proxy livekit:7880
}
```

覆盖文件顺序要让已有端口/证书配置最后生效：

```bash
docker compose --env-file .env \
  -f compose.public.yaml -f compose.broadcast.yaml -f compose.8965.yaml \
  up -d --build
```

使用旧版 `/usr/bin/docker-compose` 时，同样按上述顺序加入三个 `-f` 参数。媒体仍使用 `7881/TCP`、`7882/UDP`，与 HTTPS 端口及 DERP 的 `8964` 无关。

### 使用已有 LiveKit 或不使用 Compose

启动 `server.py` 前设置：

```bash
export SYNCAST_BROADCAST_ENABLED=true
export SYNCAST_LIVEKIT_URL=wss://media.example.com
export SYNCAST_LIVEKIT_API_URL=https://media.example.com
export LIVEKIT_API_KEY=syncast
export LIVEKIT_API_SECRET=替换为随机密钥
python3 server.py
```

外部 LiveKit 必须使用相同密钥。公开 URL 用于浏览器连接，API URL 用于后端移除成员和关闭媒体房间。启用但配置不完整时服务会拒绝启动。Python 仍只使用标准库。

每次连接通过当前房间会话换取 60 秒入场令牌，房主可发布屏幕、共享音频及麦克风，其他成员仅可发布麦克风，所有成员均可订阅；API secret 不下发到浏览器。房间离开、过期会异步调用 LiveKit 清理接口，失败最多重试三次并记录日志。令牌有效期限制入场，不是已建立连接的时长限制；自托管 LiveKit 的已签发令牌在过期前可能再次使用，因此不能将退出操作视为即时撤销凭据。

回退时先停止可选媒体服务，再恢复原部署：

```bash
docker compose --env-file .env -f compose.public.yaml -f compose.broadcast.yaml stop livekit
docker compose --env-file .env -f compose.public.yaml up -d --build
```

若使用自定义 `Caddyfile.8965`，移除其中的 SFU 路由并保留对应覆盖文件。回退会中断正在进行的广播。

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

当公网 P2P 打洞经常失败时，可以让所有参与者加入同一个 ZeroTier 网络。在 P2P 模式中，只让 Syncast 信令服务器加入 ZeroTier 没有作用。浏览器还必须收集到 ZeroTier 虚拟网卡对应的 ICE 候选，系统防火墙也要允许该网卡上的 UDP 流量。

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
node tests/broadcast-stats.test.js
node --check static/app.js
node --check static/broadcast.js
docker compose --env-file .env -f compose.public.yaml config --quiet
```

浏览器功能测试使用 Playwright 驱动 Chromium，以合成画面、合成共享音频和虚拟麦克风验证真实 WebRTC 连接，不采集本机屏幕或麦克风：

```bash
python3 -m venv /tmp/syncast-test-venv
/tmp/syncast-test-venv/bin/pip install playwright
/tmp/syncast-test-venv/bin/playwright install chromium
/tmp/syncast-test-venv/bin/python tests/browser_functional.py
```

也可以通过 `SYNCAST_TEST_BROWSER` 指定已有 Chrome/Chromium 可执行文件，省略浏览器下载。测试通过实际解码帧和音频接收量增长验证媒体传输，覆盖五人语音、星型和树状共享、独立分辨率与帧率、共享重启后的静音保持、中转成员退出、房主关闭房间、麦克风权限拒绝与恢复、加入失败后的采集释放，以及窄屏操作栏。还覆盖延迟新上游时的旧画面保持、健康分支不重建、自动模式的持续压力门槛，以及注入 ICE 故障和丢失信令后的恢复与重试上限。新增测试覆盖连接仍正常时的媒体停滞检测、直播重建期间的语音保持、共享音频恢复前的重试计数、手动重连，以及编码压力报告的过期与中转选择。真实屏幕选择器、系统音频兼容性和公网 P2P 穿透仍需在目标设备及网络上验证。

服务器广播的真实浏览器测试另需本机 `livekit-server`（与部署版本一致）。测试会自行启动仅监听本机的 SFU，使用合成媒体验证三名观众收流、房主发布一条带多层编码的视频轨道、观众独立选层、多人双向服务器语音、无屏幕通话、静音与重连、麦克风拒绝及重新授权、广播与 P2P 互切、停止共享时保持通话、新成员不发起 P2P、房主离开、SFU 故障提示、麦克风和成员变化时播放器不重载，以及真实共享流统计：

```bash
SYNCAST_TEST_LIVEKIT=/path/to/livekit-server \
  /tmp/syncast-test-venv/bin/python tests/browser_broadcast.py
```

配置校验（不需要启动 Docker daemon；变量为测试值）：

```bash
SYNCAST_DOMAIN=test.example SYNCAST_PUBLIC_IP=203.0.113.10 \
LIVEKIT_API_KEY=syncast LIVEKIT_API_SECRET=0123456789abcdef0123456789abcdef \
  docker compose -f compose.public.yaml -f compose.broadcast.yaml config --quiet
```

发送预算是编码器上限，不能覆盖 WebRTC 根据丢包和 RTT 计算的拥塞限制。提高 VPS 网卡标称带宽或只增大 maxBitrate 不保证链路吞吐增加；需要结合房主上传反馈和观众统计判断。
