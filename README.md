# 把 Mac 本地文件夹暴露成 MCP：接入 Notion AI 完整指南

🎯 把本地一个目录暴露成远程 MCP 服务器，接给 Notion AI。不开路由器端口、不给完整磁盘权限：沙盒目录 + 鉴权反向代理 + Tailscale Funnel。macOS 和 Windows 两版思路一致，具体步骤分在下面两份文档里。

## 选平台

- [mac.md](./mac.md)
- [windows.md](./windows.md)

## 资料

- [Notion 帮助：MCP connections for Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents)
- [Supergateway](https://github.com/supercorp-ai/supergateway)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
- [Tailscale CLI（含 Windows）](https://tailscale.com/docs/reference/tailscale-cli)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
