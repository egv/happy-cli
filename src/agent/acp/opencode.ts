/**
 * OpenCode ACP Backend - OpenCode agent via ACP
 * 
 * This module provides a factory function for creating an OpenCode backend
 * that communicates using the Agent Client Protocol (ACP).
 * 
 * OpenCode is available via:
 * - npm install -g opencode-ai
 * - brew install opencode
 * 
 * OpenCode ACP mode is started via 'opencode acp' command.
 */

import { AcpSdkBackend, type AcpSdkBackendOptions } from './AcpSdkBackend';
import type { AgentBackend } from '../AgentBackend';
import type { McpServerConfig } from '../AgentBackend';
import { agentRegistry, type AgentFactoryOptions } from '../AgentRegistry';

/**
 * Options for creating an OpenCode ACP backend
 */
export interface OpenCodeBackendOptions extends AgentFactoryOptions {
  /** Command to spawn OpenCode agent */
  command?: string;
  
  /** Arguments for agent agent command */
  args?: string[];
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Create an OpenCode backend using ACP (official SDK).
 * 
 * The OpenCode CLI must be installed and available in PATH.
 * Uses 'acp' subcommand for ACP mode.
 * 
 * @param options - Configuration options
 * @returns AgentBackend instance for OpenCode
 */
export function createOpenCodeBackend(options: OpenCodeBackendOptions): AgentBackend {
  const backendOptions: AcpSdkBackendOptions = {
    agentName: 'opencode',
    cwd: options.cwd,
    command: options.command || 'opencode',
    args: options.args || ['acp'],
    env: options.env,
    mcpServers: options.mcpServers,
  };

  return new AcpSdkBackend(backendOptions);
}

/**
 * Register OpenCode backend with the global agent registry.
 * 
 * This function should be called during application initialization
 * to make OpenCode agent available for use.
 */
export function registerOpenCodeAgent(): void {
  agentRegistry.register('opencode', (opts) => createOpenCodeBackend(opts));
}
