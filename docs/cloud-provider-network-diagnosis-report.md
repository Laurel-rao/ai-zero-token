# 公网 HTTP 大文件下载异常慢诊断报告

## 1. 问题概述

- 服务公网地址：`http://43.128.120.182/`
- 服务器容器：`ai-zero-token`
- 服务监听：容器内 `8787`，宿主机 `80 -> 8787`
- 问题表现：从客户端访问公网地址时，小页面响应正常，但下载稍大的静态资源或生成图片资源非常慢。
- 典型现象：约 `1.82MB` 的 PNG 图片，在客户端公网访问时 `8s` 超时；但服务器本机访问同一接口仅 `0.004s` 左右。

该问题影响页面图片预览和大静态资源加载。应用侧已验证服务端读取文件、容器响应、本机回环访问均正常，异常主要发生在公网链路或公网入口侧。

## 2. 测试环境

- 测试日期：2026-07-01
- 服务器公网 IP：`43.128.120.182`
- 服务端路径示例：
  - 原图：`/_gateway/generations/images/req-8c/generated-1.png`
  - 预览图：`/_gateway/generations/images/req-8c/generated-1.preview.webp`
- 文件大小：
  - 原图：`1,820,695 bytes`，约 `1.82MB`
  - 预览图：`16,458 bytes`，约 `16.1KB`

## 3. 关键测试结果

### 3.1 客户端访问公网 IP

测试命令使用登录 cookie 后访问图片接口，结果如下：

```text
客户端 -> http://43.128.120.182/_gateway/generations/images/req-8c/generated-1.preview.webp
status=200
total=5726.7ms
ttfb=1007.8ms
download=4718.9ms
bytes=16.1KB

客户端 -> http://43.128.120.182/_gateway/generations/images/req-8c/generated-1.png
结果：8s 超时
文件大小：1.82MB
```

说明：即使只有 `16.1KB` 的预览图，也需要约 `5.7s`，其中下载阶段约 `4.7s`。这不符合正常公网 HTTP 下载表现。

### 3.2 服务器本机访问 127.0.0.1

在服务器上直接访问本机服务：

```text
服务器 -> http://127.0.0.1/_gateway/generations/images/req-8c/generated-1.preview.webp
status=200
time=0.001734s
size=16458
speed=16458000 bytes/s

服务器 -> http://127.0.0.1/_gateway/generations/images/req-8c/generated-1.png
status=200
time=0.004143s
size=1820695
speed=455173750 bytes/s
```

说明：应用服务本身返回非常快，原图 `1.82MB` 只需约 `4ms`。

### 3.3 服务器磁盘直接读取

在服务器宿主机直接读取同一文件：

```text
preview 文件：
bytes=16458
read_avg=0.041ms

original 文件：
bytes=1820695
read_avg=1.122ms
```

说明：磁盘和挂载卷 IO 正常，不是磁盘读取慢。

### 3.4 服务器本机访问自己的公网 IP

在服务器本机访问 `43.128.120.182` 公网地址：

```text
服务器 -> http://43.128.120.182/assets/index-CF9sA3QM.js
status=200
total=0.008997s
size=259499
speed=32437375 bytes/s

服务器 -> http://43.128.120.182/_gateway/generations/images/req-8c/generated-1.png
status=200
total=0.028239s
size=1820695
speed=65024821 bytes/s
```

说明：服务器本机访问公网 IP 也很快，应用进程和宿主机本地网络栈未见明显异常。

## 4. 排除项

根据以上数据，基本可排除：

- 应用代码读取图片慢：服务器本机接口返回约 `4ms`
- 容器性能不足：Docker stats 显示 CPU/内存占用很低
- 磁盘或挂载卷 IO 慢：原图直接读约 `1ms`
- 图片解码导致服务端慢：服务端仅返回静态二进制文件
- 单个图片接口实现问题：客户端访问静态 JS 大文件也出现明显卡顿

## 5. 初步判断

问题更可能发生在以下范围：

- 公网入站链路质量异常
- 云服务器公网带宽、限速、突发带宽策略异常
- 云厂商网络节点到客户端所在网络的链路拥塞或丢包
- 公网 IP 所在区域/运营商线路质量异常
- 安全防护、DDoS 清洗、WAF、NAT 网关或边界设备对大响应有异常限速

特征是：小 HTML 首包可返回，但稍大的 HTTP 响应吞吐极低；同一服务在服务器本机访问非常快。

## 6. 复现命令

### 6.1 服务器本机测试

```bash
curl -o /dev/null -s -w \
  "status=%{http_code} start=%{time_starttransfer}s total=%{time_total}s size=%{size_download} speed=%{speed_download}\n" \
  http://127.0.0.1/_gateway/generations/images/req-8c/generated-1.png
```

### 6.2 公网客户端测试

需要带登录 cookie 后访问图片接口。也可以让服务商协助在不同地区节点直接测试公网下载：

```bash
curl -o /dev/null -s -w \
  "status=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s start=%{time_starttransfer}s total=%{time_total}s size=%{size_download} speed=%{speed_download}\n" \
  http://43.128.120.182/assets/index-CF9sA3QM.js
```

静态 JS 不需要业务登录，适合服务商直接复测。

## 7. 希望云服务商协助排查

请协助检查：

1. 云服务器公网带宽上限、实际限速、突发带宽策略是否异常。
2. 公网 IP `43.128.120.182` 的入站/出站链路是否存在丢包、拥塞或清洗限速。
3. 该 IP 到中国大陆常见运营商网络的 HTTP 下载质量。
4. 是否有安全防护、DDoS 清洗、WAF、边界 NAT、QoS 策略影响大文件响应。
5. 同机房同线路其他公网 IP 是否也存在类似大文件下载慢的问题。
6. 如有必要，请提供更换公网 IP、调整线路或升级/修复公网带宽的方案。

## 8. 当前业务影响

- 图片预览加载慢。
- 前端静态资源首次加载可能异常慢。
- 小接口响应正常，但大响应下载体验不稳定。

应用侧已临时改为“先显示缩略图，后台加载原图”的渐进式预览，但这只能缓解用户体验，不能解决公网吞吐异常本身。
