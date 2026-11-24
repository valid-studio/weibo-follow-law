# 微博关注列表定律 · 隐私权政策 (Privacy Policy)

**生效日期 / Effective Date**: 2026-11-24  
**适用产品 / Extension Name**: 微博关注列表定律 (Weibo Follow Law Chrome Extension)  
**开源仓库 / Source Repository**: https://github.com/valid-studio/weibo-follow-law

---

## 中文版声明

### 1. 核心原则：100% 本地运行，零数据收集
「微博关注列表定律」完全在您的本地浏览器内运行。**我们没有设立任何远程后端服务器，不接入任何第三方统计、广告或追踪 SDK，也不会收集、上传、存储、共享或出售您的任何个人数据、微博账号凭证、Cookie、关注列表或网页浏览记录。**

### 2. 最小权限与本地数据处理说明
扩展仅申请单一基础权限 **`storage`**（**不申请 `cookies` 权限**）及微博官网同源主机权限（`https://weibo.com/*`、`https://api.weibo.com/*`），全部数据处理均严格限定在您的本地设备内：
- **本地设置与屏蔽名单**：您配置的敏感度偏好、自定义规则与本地屏蔽用户名单仅保存在您浏览器的本地存储（`chrome.storage.local`）中。
- **短期查询缓存**：为减少对微博网页接口的重复请求，已查询过的公开关注重合度计算结果会临时缓存在您本地浏览器的 `IndexedDB` 中（默认保留 7 天，您可随时在扩展设置页一键清空）。
- **微博同源通信（`weibo.com` / `api.weibo.com`）**：仅当您主动点击查成分、批量扫描、拉黑或同步黑名单时，扩展才会在当前浏览器标签页与新浪微博官方域名（`https://weibo.com` 及 `https://api.weibo.com`）之间直接发起同源请求，并仅在页面同源上下文中按需携带微博自身的安全请求头完成您触发的操作。上述信息绝不会离开您的浏览器发往任何第三方域名。

### 3. 用户控制权与数据清除
您可以随时通过扩展「管理与批量排查」面板导出、修改或清空所有本地配置与缓存记录；当您从 Chrome 浏览器卸载本扩展时，浏览器会自动彻底清除本扩展保存在本地的全部 `chrome.storage.local` 与 `IndexedDB` 数据。

---

## English Version

### 1. Core Principle: 100% Local Execution & Zero Telemetry
**Weibo Follow Law** runs completely locally inside your web browser. **We operate zero backend servers, embed zero third-party analytics, advertising, or tracking SDKs, and never collect, transmit, store, share, or sell your personal data, Weibo credentials, cookies, following lists, or browsing history.**

### 2. Minimal Permissions & On-Device Data Handling
The extension requests **only the `storage` permission** (with **zero `cookies` permission**) and host access strictly scoped to Weibo official origins (`https://weibo.com/*` and `https://api.weibo.com/*`):
- **Preferences & Local Mute List**: Sensitivity presets, domain toggles, custom skip rules, and your local muted-account list are stored exclusively in `chrome.storage.local` on your device.
- **Temporary Local Cache**: Public following-overlap calculation results are temporarily cached in your local `IndexedDB` (7-day default TTL, wipeable in one click at any time) solely to avoid redundant requests.
- **User-Initiated Same-Origin Requests (`weibo.com` / `api.weibo.com`)**: Network requests are triggered only by explicit user actions (clicking check, viewport scan, mute/block, or blocklist sync) directly between your browser and official Weibo domains (`https://weibo.com` and `https://api.weibo.com`). No data is ever sent to any external or third-party server.

### 3. User Control & Data Deletion
You may export, edit, or delete all local settings and cached results at any time from the extension dashboard. Removing the extension from Chrome permanently deletes all associated `chrome.storage.local` and `IndexedDB` data.
