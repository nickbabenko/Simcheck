#!/usr/bin/env node
/** Local stdio entry point: an agent on this machine spawns this as a child. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { Client } from './client.js';
import { createMcpServer } from './mcp-server.js';

const server = createMcpServer(new Client(loadConfig()));
await server.connect(new StdioServerTransport());
