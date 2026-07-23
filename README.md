# 同屏

同屏是一个面向可信局域网的小型直播协作服务。房主通过浏览器共享屏幕和系统声音，所有成员通过独立的麦克风轨道进行语音通话。

## 启动

不需要安装第三方依赖，要求 Python 3.10+、OpenSSL 和支持 WebRTC 的现代浏览器。

```bash
python3 server.py
```

服务默认监听 `0.0.0.0:8443`。在房主电脑上打开 `https://localhost:8443`，其他成员打开 `https://<房主局域网 IP>:8443`。首次打开需要接受浏览器对本地自签名证书的提示。

仅在本机调试且不需要从其他设备访问时，可以关闭 TLS：

```bash
python3 server.py --host 127.0.0.1 --port 8080 --http
```

## 媒体行为

- 屏幕与系统声音来自一次 `getDisplayMedia` 调用。
- 房主和参与者的麦克风来自独立的 `getUserMedia` 调用，不会混入共享流。
- 屏幕与语音使用 WebRTC 在成员浏览器间直接传输；服务端只交换连接信令。
- 浏览器和操作系统决定哪些共享源可以附带系统声音。Chrome/Edge 共享标签页时支持最稳定；选择窗口或整个屏幕时，应确认共享选择器中的“同时共享声音”已勾选。
- 当前版本使用点对点 mesh，服务限制单个房间最多 12 人，建议日常使用不超过 8 人。更大规模需要引入局域网 SFU（例如 LiveKit、mediasoup 或 Janus）。

## 测试

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
```
