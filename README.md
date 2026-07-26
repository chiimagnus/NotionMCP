# 把本地文件夹暴露成 MCP：接入 Notion AI

🎯 通过鉴权反向代理和 Tailscale Funnel，把本地目录接给 Notion AI。`MCP_SANDBOX_DIR` 只是默认工作目录，不是硬隔离；公网安全边界是 Bearer Token。

🛡️ 启动链路内置子进程自愈：supergateway / auth-proxy 任意一个意外退出都会按退避策略自动重启，不需要人工盯着终端手动重启；同时会定期主动回收重启一次以避免长时间运行后的会话/进程积累，运行过程会持久化写入仓库根目录的 `up.log`，方便事后排查。

运行配置集中在根目录的 [`.env`](./.env)，只保留用户通常会修改的目录、技能目录和端口。Token 及平台内部细节由程序处理。

## 选平台

- [macOS](./docs/mac.md)
- [Linux](./docs/linux.md)
- [Windows](./docs/windows.md)

三个平台共用同一个 Node 启动器和工具集；入口分别是 `up.sh`（macOS/Linux）与 `up.ps1`（Windows）。首次使用前建议在仓库根目录执行一次 `npm install`，把 supergateway 固定安装到本地，启动更快也更不容易受网络波动影响（未安装时会自动回退到 `npx -y` 联网拉取）。
