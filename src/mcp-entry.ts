#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";
runMcpServer().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
