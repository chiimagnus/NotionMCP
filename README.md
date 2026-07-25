# 把本地文件夹暴露成 MCP：接入 Notion AI

🎯 通过鉴权反向代理和 Tailscale Funnel，把本地目录接给 Notion AI。`MCP_SANDBOX_DIR` 只是默认工作目录，不是硬隔离；公网安全边界是 Bearer Token。

## 选平台

- [macOS：当前完整可运行入口](./docs/mac.md)
- [Windows：PowerShell 入口与已知限制](./docs/windows.md)

## macOS 快速运行

在仓库根目录执行：

```bash
chmod +x ./up.sh
./up.sh
```

脚本会从自身所在目录加载后端和鉴权代理，所以直接运行仓库版本即可。默认沙盒目录是 `~/Github_OpenSource/AI-Share`；需要更换时：

```bash
MCP_SANDBOX_DIR="$HOME/AI-Share" ./up.sh
```

安装、Token、Tailscale 和 Notion 配置见 [macOS 文档](./docs/mac.md)。

## 资料

- [Notion 帮助：MCP connections for Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents)
- [Supergateway](https://github.com/supercorp-ai/supergateway)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
- [Tailscale CLI（含 Windows）](https://tailscale.com/docs/reference/tailscale-cli)
- [Filesystem MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
