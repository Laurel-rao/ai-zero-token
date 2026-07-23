# VSRSS VPN 节点安装与踩坑记录

本文记录 `45.205.25.191` 上使用 `sing-box` 搭建 Clash/Mihomo 可用代理节点的安装方式、当前端口规划、验证命令和本次实际遇到的问题。

## 当前节点状态

- 服务器：`root@45.205.25.191`
- 系统：CentOS Stream 8
- 代理引擎：`sing-box` Docker 容器
- 容器名：`vsrss-sing-box`
- 配置目录：`/opt/vsrss`
- 凭据文件：`/opt/vsrss/credentials.txt`
- Clash 订阅服务：`vsrss-subscription.service`

当前端口：

| 端口 | 用途 |
| --- | --- |
| `18443/tcp` | VLESS Reality |
| `8388/tcp+udp` | Shadowsocks |
| `8080/tcp` | Clash/Mihomo 订阅文件 |
| `18080/tcp` | Go 静态测速服务 |
| `80/tcp` | Nginx / Web 服务 |
| `443/tcp` | Nginx / HTTPS Web 服务 |

注意：VPN 服务不要占用 `80` 和 `443`，这两个端口留给 Nginx。

订阅地址格式：

```text
http://45.205.25.191:8080/sub/<SUB_TOKEN>/clash.yaml
http://45.205.25.191:8080/sub/<SUB_TOKEN>/clash-ss.yaml
http://45.205.25.191:8080/sub/<SUB_TOKEN>/links.txt
```

`<SUB_TOKEN>` 从服务器读取，不要写入公开仓库：

```bash
ssh root@45.205.25.191 'grep "^SUB_TOKEN=" /opt/vsrss/credentials.txt'
```

## 从零安装

### 1. 确认环境

```bash
ssh root@45.205.25.191 '
  uname -a
  cat /etc/os-release
  docker --version
  docker compose version
  ss -tulpn | sed -n "1,80p"
'
```

本次服务器已有 Docker 和 Docker Compose。若没有，需要先安装 Docker。

### 2. 拉取 sing-box 镜像

```bash
ssh root@45.205.25.191 'docker pull ghcr.io/sagernet/sing-box:latest'
```

确认版本：

```bash
ssh root@45.205.25.191 'docker run --rm ghcr.io/sagernet/sing-box:latest version'
```

### 3. 生成密钥和目录

```bash
ssh root@45.205.25.191 '
  set -euo pipefail
  mkdir -p /opt/vsrss/sing-box /opt/vsrss/private

  UUID=$(docker run --rm ghcr.io/sagernet/sing-box:latest generate uuid)
  KEYPAIR=$(docker run --rm ghcr.io/sagernet/sing-box:latest generate reality-keypair)
  PRIVATE_KEY=$(printf "%s\n" "$KEYPAIR" | awk "/PrivateKey:/ {print \$2}")
  PUBLIC_KEY=$(printf "%s\n" "$KEYPAIR" | awk "/PublicKey:/ {print \$2}")
  SHORT_ID=$(openssl rand -hex 8)
  SS_PASSWORD=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-24)
  SUB_TOKEN=$(openssl rand -hex 18)

  cat > /opt/vsrss/credentials.txt <<EOF
UUID=$UUID
PRIVATE_KEY=$PRIVATE_KEY
PUBLIC_KEY=$PUBLIC_KEY
SHORT_ID=$SHORT_ID
SS_PASSWORD=$SS_PASSWORD
SUB_TOKEN=$SUB_TOKEN
VLESS_PORT=18443
SS_PORT=8388
SUB_PORT=8080
EOF
  chmod 600 /opt/vsrss/credentials.txt
'
```

### 4. 写入 sing-box 服务配置

```bash
ssh root@45.205.25.191 '
  set -euo pipefail
  . /opt/vsrss/credentials.txt

  cat > /opt/vsrss/sing-box/config.json <<EOF
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-reality-in",
      "listen": "::",
      "listen_port": 18443,
      "users": [
        {
          "uuid": "$UUID",
          "flow": "xtls-rprx-vision"
        }
      ],
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com",
        "reality": {
          "enabled": true,
          "handshake": {
            "server": "www.microsoft.com",
            "server_port": 443
          },
          "private_key": "$PRIVATE_KEY",
          "short_id": [
            "$SHORT_ID"
          ]
        }
      }
    },
    {
      "type": "shadowsocks",
      "tag": "ss-in",
      "listen": "::",
      "listen_port": 8388,
      "method": "aes-256-gcm",
      "password": "$SS_PASSWORD"
    }
  ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    },
    {
      "type": "block",
      "tag": "block"
    }
  ]
}
EOF

  chmod 600 /opt/vsrss/sing-box/config.json
  docker run --rm \
    -v /opt/vsrss/sing-box/config.json:/etc/sing-box/config.json:ro \
    ghcr.io/sagernet/sing-box:latest check -c /etc/sing-box/config.json
'
```

### 5. 写入 Docker Compose

```bash
ssh root@45.205.25.191 '
  cat > /opt/vsrss/docker-compose.yml <<EOF
services:
  sing-box:
    image: ghcr.io/sagernet/sing-box:latest
    container_name: vsrss-sing-box
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./sing-box/config.json:/etc/sing-box/config.json:ro
    command: run -c /etc/sing-box/config.json
EOF

  cd /opt/vsrss
  docker compose up -d
'
```

### 6. 生成 Clash/Mihomo 订阅

推荐把 SS 放在第一位。Reality 对客户端内核要求更高，旧 Clash 客户端容易握手失败。

```bash
ssh root@45.205.25.191 '
  set -euo pipefail
  . /opt/vsrss/credentials.txt

  cat > /opt/vsrss/private/clash.yaml <<EOF
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
unified-delay: true
tcp-concurrent: true

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://1.1.1.1/dns-query
    - https://8.8.8.8/dns-query
    - tls://1.1.1.1:853
  fallback:
    - https://dns.google/dns-query
    - https://cloudflare-dns.com/dns-query

proxies:
  - name: vsrss-ss
    type: ss
    server: 45.205.25.191
    port: 8388
    cipher: aes-256-gcm
    password: $SS_PASSWORD
    udp: true

  - name: vsrss-vless-reality
    type: vless
    server: 45.205.25.191
    port: 18443
    uuid: $UUID
    network: tcp
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: www.microsoft.com
    client-fingerprint: chrome
    reality-opts:
      public-key: $PUBLIC_KEY
      short-id: $SHORT_ID

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - vsrss-ss
      - vsrss-vless-reality
      - DIRECT

rules:
  - IP-CIDR,45.205.25.191/32,DIRECT
  - DOMAIN-SUFFIX,x.com,PROXY
  - DOMAIN-SUFFIX,twitter.com,PROXY
  - DOMAIN-SUFFIX,twimg.com,PROXY
  - DOMAIN-SUFFIX,t.co,PROXY
  - DOMAIN-SUFFIX,api.x.com,PROXY
  - DOMAIN-SUFFIX,api.twitter.com,PROXY
  - DOMAIN-KEYWORD,twitter,PROXY
  - DOMAIN-KEYWORD,twimg,PROXY
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
EOF

  cat > /opt/vsrss/private/clash-ss.yaml <<EOF
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
unified-delay: true
tcp-concurrent: true

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://1.1.1.1/dns-query
    - https://8.8.8.8/dns-query
    - tls://1.1.1.1:853
  fallback:
    - https://dns.google/dns-query
    - https://cloudflare-dns.com/dns-query

proxies:
  - name: vsrss-ss
    type: ss
    server: 45.205.25.191
    port: 8388
    cipher: aes-256-gcm
    password: $SS_PASSWORD
    udp: true

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - vsrss-ss
      - DIRECT

rules:
  - IP-CIDR,45.205.25.191/32,DIRECT
  - DOMAIN-SUFFIX,x.com,PROXY
  - DOMAIN-SUFFIX,twitter.com,PROXY
  - DOMAIN-SUFFIX,twimg.com,PROXY
  - DOMAIN-SUFFIX,t.co,PROXY
  - DOMAIN-KEYWORD,twitter,PROXY
  - DOMAIN-KEYWORD,twimg,PROXY
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
EOF

  printf "vless://%s@45.205.25.191:18443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=%s&sid=%s&type=tcp&headerType=none#vsrss-vless-reality\n" "$UUID" "$PUBLIC_KEY" "$SHORT_ID" > /opt/vsrss/private/links.txt
  printf "ss://%s@45.205.25.191:8388#vsrss-ss\n" "$(printf "aes-256-gcm:%s" "$SS_PASSWORD" | base64 -w0)" >> /opt/vsrss/private/links.txt

  chmod 700 /opt/vsrss/private
  chmod 600 /opt/vsrss/private/*
'
```

### 7. 启动订阅服务

CentOS Stream 8 的 `/usr/libexec/platform-python` 是 Python 3.6，不支持 `ThreadingHTTPServer`，所以订阅服务脚本使用 `HTTPServer`。

```bash
ssh root@45.205.25.191 '
  set -euo pipefail
  . /opt/vsrss/credentials.txt

  cat > /opt/vsrss/subscription_server.py <<PY
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

TOKEN = "$SUB_TOKEN"
BASE = Path("/opt/vsrss/private")
FILES = {
    "/sub/%s/clash.yaml" % TOKEN: ("clash.yaml", "text/yaml; charset=utf-8"),
    "/sub/%s/clash-ss.yaml" % TOKEN: ("clash-ss.yaml", "text/yaml; charset=utf-8"),
    "/sub/%s/links.txt" % TOKEN: ("links.txt", "text/plain; charset=utf-8"),
}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        item = FILES.get(self.path.split("?", 1)[0])
        if not item:
            self.send_error(404)
            return
        filename, content_type = item
        data = (BASE / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args), flush=True)

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
PY

  chmod 700 /opt/vsrss/subscription_server.py

  cat > /etc/systemd/system/vsrss-subscription.service <<EOF
[Unit]
Description=VSRSS Clash subscription token server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/libexec/platform-python /opt/vsrss/subscription_server.py
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now vsrss-subscription.service
'
```

## 验证命令

### 服务状态

```bash
ssh root@45.205.25.191 '
  docker ps --filter name=vsrss-sing-box --format "table {{.Names}}\t{{.Status}}"
  systemctl is-active vsrss-subscription.service
  ss -tulpn | egrep ":(80|443|8080|8388|18080|18443)\b" || true
'
```

预期：

- `vsrss-sing-box` 为 `Up`
- `vsrss-subscription.service` 为 `active`
- `18443`、`8388`、`8080` 正在监听
- `80`、`443` 不被 VPN 占用

### 公网端口

```bash
for p in 18443 8388 8080; do
  nc -vz -w 3 45.205.25.191 "$p" 2>&1 || true
done
```

### 订阅可拉取

```bash
SUB_TOKEN="<SUB_TOKEN>"
curl -s -o /tmp/clash.yaml -w "%{http_code}\n" "http://45.205.25.191:8080/sub/$SUB_TOKEN/clash.yaml"
curl -s -o /tmp/clash-ss.yaml -w "%{http_code}\n" "http://45.205.25.191:8080/sub/$SUB_TOKEN/clash-ss.yaml"
```

### 节点服务日志

```bash
ssh root@45.205.25.191 'docker logs --tail 120 vsrss-sing-box'
```

### 订阅服务日志

```bash
ssh root@45.205.25.191 'journalctl -u vsrss-subscription.service -n 80 --no-pager'
```

## Go 测速服务

为了不占用 `80/443`，静态测速服务放在 `18080`。

```bash
ssh root@45.205.25.191 '
  systemctl status nettest-http.service --no-pager
  ss -tulpn | grep 18080 || true
'
```

测试地址：

```text
http://45.205.25.191:18080/
http://45.205.25.191:18080/64mb.bin
http://45.205.25.191:18080/256mb.bin
```

测速命令：

```bash
curl -L --max-time 120 -o /dev/null \
  -w "http=%{http_code} size=%{size_download} time=%{time_total}s speed=%{speed_download}B/s\n" \
  http://45.205.25.191:18080/64mb.bin
```

本次测试结果波动较大：

- 10MB 分片约 `0.93 - 1.50 MB/s`
- 64MB 单连接约 `4.76 MB/s`
- 256MB 长连接掉速明显，180 秒只下载约 `93MB`

说明这条公网链路有明显波动，不能只用一次测速判断节点质量。

## 踩坑记录

### 1. WireGuard 内核模块不可用

CentOS Stream 8 当前内核没有自带 WireGuard 模块：

```text
modprobe: FATAL: Module wireguard not found
```

尝试安装 `wireguard-tools` / `kmod-wireguard` 会遇到仓库和内核模块匹配问题，并且 `dnf` 过程较慢。为了快速交付 Clash 可用节点，本次改用 `sing-box`。

### 2. Docker Hub 拉取 nginx 超时

最初计划用 `nginx:alpine` 提供订阅文件，但 Docker Hub 拉取超时：

```text
Get "https://registry-1.docker.io/v2/": context deadline exceeded
```

解决：不用额外 nginx 镜像，直接用系统自带 Python 提供 token 化订阅文件。

### 3. CentOS 平台 Python 没有 ThreadingHTTPServer

`/usr/libexec/platform-python` 是 Python 3.6，导入 `ThreadingHTTPServer` 会失败：

```text
ImportError: cannot import name 'ThreadingHTTPServer'
```

解决：使用兼容 Python 3.6 的 `HTTPServer`。

### 4. 订阅路径不要公开固定文件名

最初如果直接暴露：

```text
http://45.205.25.191:8080/clash.yaml
```

等于把节点凭据公开给所有人。

解决：使用随机 token 路径：

```text
http://45.205.25.191:8080/sub/<SUB_TOKEN>/clash.yaml
```

根路径和固定文件名返回 `404`。

### 5. VLESS Reality 客户端兼容性

服务端日志出现：

```text
TLS handshake: REALITY: processed invalid connection
```

通常说明客户端没有正确发出 Reality 握手，常见原因：

- Clash 内核太旧，不支持 Reality 或 `xtls-rprx-vision`
- 订阅解析丢失 `reality-opts`
- 客户端选中了 VLESS Reality，但实际配置不完整

解决：

- 优先使用 Mihomo / Clash Meta 新内核。
- 订阅中把 `vsrss-ss` 放在第一位。
- 提供 `clash-ss.yaml` 作为保底订阅。

### 6. 80/443 不要被 VPN 占用

一开始 Reality 监听在 `443`，后面需要把 `80/443` 留给 Nginx，所以改成：

```text
VLESS Reality: 18443
Shadowsocks: 8388
```

Reality 配置里的 `handshake.server_port` 仍然是远端伪装站点的 `443`，这个不是本机监听端口，不需要改。

### 7. Clash 可能把节点服务器自身也代理出去

如果规则里有：

```yaml
- MATCH,PROXY
```

访问节点服务器自身可能变成：

```text
本机 -> VPN -> 同一台服务器
```

这会影响订阅刷新、测速和同机服务访问。

解决：把节点服务器 IP 设为直连：

```yaml
- IP-CIDR,45.205.25.191/32,DIRECT
```

## 常用运维命令

重启 VPN：

```bash
ssh root@45.205.25.191 'cd /opt/vsrss && docker compose restart sing-box'
```

查看 VPN 日志：

```bash
ssh root@45.205.25.191 'docker logs --tail 120 vsrss-sing-box'
```

重启订阅服务：

```bash
ssh root@45.205.25.191 'systemctl restart vsrss-subscription.service'
```

查看端口占用：

```bash
ssh root@45.205.25.191 'ss -tulpn | egrep ":(80|443|8080|8388|18080|18443)\b" || true'
```

更新 sing-box 镜像：

```bash
ssh root@45.205.25.191 '
  cd /opt/vsrss
  docker pull ghcr.io/sagernet/sing-box:latest
  docker compose up -d --force-recreate sing-box
'
```

备份配置：

```bash
ssh root@45.205.25.191 '
  tar -czf /root/vsrss-backup-$(date +%Y%m%d-%H%M%S).tar.gz /opt/vsrss
  ls -lh /root/vsrss-backup-*.tar.gz | tail -5
'
```

## 安全注意事项

- 不要把 `/opt/vsrss/credentials.txt` 提交到仓库。
- 不要公开 `<SUB_TOKEN>`、`SS_PASSWORD`、`UUID`、Reality 私钥。
- 订阅服务只做 token 路径，不提供目录列表。
- 如果怀疑泄漏，重新生成 `SS_PASSWORD`、`UUID`、Reality keypair 和 `SUB_TOKEN`，然后重启服务并更新客户端订阅。
