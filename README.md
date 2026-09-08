# Syncast

Syncast 是一个自托管的小型直播协作服务。公网服务器负责房间信令和 ICE 协商，屏幕、系统声音及独立麦克风轨道通过 WebRTC 在成员间直接传输；NAT 穿透失败时才回退到 TURN 中继。

## 工作方式

1. 所有成员通过 HTTPS 连接公网信令服务并加入房间。
2. 浏览器交换 SDP 与 ICE 候选，依次尝试局域网直连和 STUN 公网打洞。
3. 无法直连的成员对使用 TURN；媒体仍由 WebRTC 加密。
4. 屏幕默认从房主到观众的星型 P2P 开始；自动模式会在房主持续受限时启用浅层树状转发。语音始终采用成员间 mesh。

屏幕和共享来源声音来自 `getDisplayMedia`，麦克风来自独立的 `getUserMedia`，因此房主麦克风不会混入直播音轨。标签页使用浏览器提供的标签页独立音频；房主可在共享前选择窗口独立音频或系统混音，默认使用独立音频。共享整个屏幕时仍请求系统音频。系统混音可能包含 Syncast 播放的通话声音并形成回音。选择器会尽量排除当前 Syncast 标签页，直接共享 Syncast 自身标签页或窗口时仍会移除音轨。单房间最多 12 人，公网日常使用建议不超过 8 人；更大房间应改用 SFU。

### 动态树状转发

房主可以在通话频道标题旁选择直播连接方式：

- **自动**（新用户默认）：从直连开始。至少有四位观众且存在可中转成员时，每五秒检查视频发送统计；至少两条、且至少一半发送连接连续三次报告带宽或编码受限后，启用中转。启用后保持到本次共享结束或观众降至四人以下，避免压力下降后又反复切回。此判断是基于浏览器统计的启发式策略，不等同于测量房主总上行带宽。
- **优先直连**：始终由房主发送给所有观众，不自动启用成员中转；无法打洞时仍允许 TURN。
- **节省上传**：主动使用浅层树状转发。通常房主只向三个第一层成员发送媒体，第一层成员再转发给叶节点。

树状模式最多经过一个中转成员，普通中转最多带三个子节点。识别为移动设备的客户端只作为叶节点；中转容量不足时，多出的观众回退到房主，因此房主的三条连接目标不是硬限制。规划优先保留健康分支，并把新增观众分配给子节点较少的中转。成员加入、离开或连接恢复失败时，房主串行发布带版本的拓扑，观众确认订阅后上游才建立新连接。

更换上游时，可用的旧连接最多保留三十秒；新连接实际解码出视频帧后再切换播放并释放旧连接，降低重连期间的黑屏概率。切换期间会短暂增加带宽和连接数。语音及画面连接均支持最多三轮 ICE 恢复；丢失的协商请求会重发，树状画面恢复失败后才尝试更换上游。失败路径暂时避让六十秒，正常使用 TURN 的路径不会仅因经过中继就被拆掉。

中继发生在成员浏览器之间，信令服务器不处理媒体；但是任意父子 WebRTC 连接打洞失败时仍可能使用配置的 TURN，因此动态树本身不保证服务器零媒体流量。浏览器中继会解码并重新编码远程轨道，可能增加延迟、CPU 占用和少量画质损失。中继节点固定向上游请求高帧画质，叶节点仍可以独立选择观看画质。

观众可以独立选择观看质量，不影响房间内其他人：

| 档位 | 目标规格 | 最高视频码率 |
|---|---|---:|
| 流畅 | 720p30 | 5 Mbps |
| 清晰 | 1080p30 | 10 Mbps |
| 高帧 | 1080p60 | 20 Mbps |
| 极清 | 1440p30 | 24 Mbps |

默认使用“高帧”档位，以 1080p60 和最高 20 Mbps 发送，不再提供无约束的自动档位。观众仍可主动选择其他固定档位，且只影响自己的连接。实际分辨率、帧率和可用码率仍受共享源、浏览器、房主上行及观看端网络限制；WebRTC 在网络拥塞时仍会降低发送速率以维持连接。

共享来源音频和麦克风采用不同的编码策略：系统、标签页或窗口音频使用 48 kHz 立体声 Opus、音乐内容提示和最高 192 kbps 发送码率，并关闭语音降噪、自动增益与 DTX；麦克风继续使用回声消除、降噪和自动增益。整屏及窗口音频取决于操作系统和浏览器支持，不支持时自动退回仅共享画面；单声道源不会被强制扩展为真实立体声。系统混音模式明确允许回音风险，生产使用建议优先选择窗口独立音频，或将通话和游戏音频路由到不同设备。

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

公网入口位于 `https://<SYNCAST_DOMAIN>/Syncast/`，健康检查位于
`https://<SYNCAST_DOMAIN>/Syncast/api/health`。路径区分大小写，末尾的 `/` 不可省略；
访问 `/Syncast` 时 Caddy 会自动跳转到规范地址。

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
node tests/topology.test.js
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

也可以通过 `SYNCAST_TEST_BROWSER` 指定已有 Chrome/Chromium 可执行文件，省略浏览器下载。测试通过实际解码帧和音频接收量增长验证媒体传输，覆盖五人语音、星型和树状共享、独立画质、共享重启后的静音保持、中转成员退出、房主关闭房间、麦克风权限拒绝与恢复、加入失败后的采集释放，以及窄屏操作栏。还覆盖延迟新上游时的旧画面保持、健康分支不重建、自动模式的持续压力门槛，以及注入 ICE 故障和丢失信令后的恢复与重试上限。真实屏幕选择器、系统音频兼容性和公网 TURN 穿透仍需在目标设备及网络上验证。
