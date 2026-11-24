# 安全政策与漏洞反馈 (Security Policy)

## 安全设计原则

「微博关注列表定律 (Weibo Follow Law)」遵循最小权限与零外传架构：
- **零外部网络通信**：所有计算、缓存与 UI 渲染均在用户浏览器本地完成，除微博官网同源接口（`https://weibo.com`）外，不向任何第三方域名发起网络请求。
- **最小权限模型**：`manifest.json` 仅申请 `["storage"]` 单一扩展权限，不使用 `cookies`、`tabs`、`webRequest`、`scripting` 或 `<all_urls>` 权限，亦不加载任何远程代码（Remote Code）。
- **XSS 与 DOM 注入安全**：内容脚本与管理面板坚持使用安全的 DOM API（`textContent` / `createElement` / `replaceChildren`）构建界面，拒绝将外部接口返回字段直接拼入 `innerHTML`。
- **请求限流与风控熔断**：全部网络接口调用均内置并发串行队列、超时控制与风控冷却熔断机制，绝不在后台静默高频刷取接口。

## 支持版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| `1.5.x`（当前最新 `1.5.4`） | ✅ 支持 |
| `< 1.5.0` | ❌ 请升级至最新 `1.5.x` 版本 |

## 漏洞报告渠道 (Reporting a Vulnerability)

如果您发现潜在的安全隐患、权限越界风险或隐私问题，请**不要在公开 Issue 中直接披露可被利用的细节**，请通过以下方式联系维护团队：

1. 在本仓库使用 GitHub **Security Advisories**（`Security -> Advisories -> Report a vulnerability`）提交私密报告；
2. 若为一般功能缺陷或非敏感安全建议，可在 [GitHub Issues](https://github.com/valid-studio/weibo-follow-law/issues) 提交说明。

我们将在收到报告后的 **72 小时内** 确认核查并评估修复方案。
