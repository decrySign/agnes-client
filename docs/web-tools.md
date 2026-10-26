# 联网工具（web_search / web_fetch）

- web_search：默认解析 Bing 网页结果；设置 TAVILY_API_KEY 后改用 Tavily。
- web_fetch：抓取公网网页并转成文本，正文用 <untrusted_web_content> 包裹，模型被告知不执行其中指令。

## 开关
- AGNES_WEB_FETCH=0：关闭网页抓取
- AGNES_WEB_SEARCH=0：关闭联网搜索
- 取值 0、false、off、no、disabled（不分大小写）都算关闭，其他值或不设为开启。
- 改完需要重启服务才生效；开关同时作用于主 Agent 和子 Agent。

## 内网防护（尽力而为）
- 只放行 http/https；localhost、.local、.internal 以及各种写法的内网/回环 IP（含 IPv6 内嵌 IPv4、NAT64、6to4）一律拒绝。
- 连接时再做一次 DNS 检查，实际连接的就是检查过的地址，防 DNS 重绑定；每一跳跳转都检查。
- 限制：本机开着代理的 fake-ip 模式（如 Clash）时，所有域名都解析到 198.18.x，客户端看不到真实地址，
  解析到内网的自定义域名可能漏过。已按主机名兜底拦截常见通配域名（nip.io、sslip.io、xip.io、traefik.me、localtest.me 等）。
  其中 nip.io、sslip.io、xip.io、traefik.me 是整个域名拦掉的，即使写的是公网 IP 也会被拒绝。
  对安全要求高的环境请设 AGNES_WEB_FETCH=0。
