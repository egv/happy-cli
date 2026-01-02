/**
 * OpenCode CLI Entry Point
 * 
 * This module provides the main entry point for running the OpenCode agent
 * through Happy CLI using the Agent Client Protocol (ACP).
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join, resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { AgentState, Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';

import { createOpenCodeBackend } from '@/agent/acp/opencode';
import type { AgentBackend, AgentMessage } from '@/agent/AgentBackend';

/**
 * Main entry point for opencode command
 */
export async function runOpenCode(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  cwd?: string;
}): Promise<void> {
  const sessionTag = randomUUID();
  const api = await ApiClient.create(opts.credentials);

  // Machine setup
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error('[START] No machine ID found. Run "happy auth" first.');
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  // Session setup
  const state: AgentState = {
    controlledByUser: false,
  };
  const metadata: Metadata = {
    path: opts.cwd || process.cwd(),
    host: os.hostname(),
    version: packageJson.version,
    os: os.platform(),
    machineId: machineId,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: projectPath(),
    happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
    startedFromDaemon: opts.startedBy === 'daemon',
    hostPid: process.pid,
    startedBy: opts.startedBy || 'terminal',
    lifecycleState: 'running',
    lifecycleStateSince: Date.now(),
    flavor: 'opencode'
  };
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  const session = api.sessionSyncClient(response);

  // Report to daemon
  try {
    logger.debug(`[START] Reporting session ${response.id} to daemon`);
    const result = await notifyDaemonSessionStarted(response.id, metadata);
    if (result.error) {
      logger.debug(`[START] Failed to report to daemon:`, result.error);
    }
  } catch (error) {
    logger.debug('[START] Failed to report to daemon:', error);
  }

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  
  // Abort handling
  let abortController = new AbortController();
  let shouldExit = false;
  let openCodeBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;

  async function handleAbort() {
    logger.debug('[OpenCode] Abort requested');
    try {
      abortController.abort();
      if (openCodeBackend && acpSessionId) {
        await openCodeBackend.cancel(acpSessionId);
      }
    } catch (error) {
      logger.debug('[OpenCode] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[OpenCode] Kill session requested');
    await handleAbort();

    try {
      if (session) {
        session.updateMetadata((current) => ({
          ...current,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated'
        }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }

      stopCaffeinate();

      if (openCodeBackend) {
        await openCodeBackend.dispose();
      }

      logger.debug('[OpenCode] Session terminated');
      process.exit(0);
    } catch (error) {
      logger.debug('[OpenCode] Error during termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Simple display for OpenCode
  if (hasTTY) {
    console.clear();
    console.log('🚀 OpenCode ACP Mode');
    console.log('Waiting for commands from mobile app...');
    console.log('');
  }

  // Start Happy MCP server
  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Create OpenCode backend
  openCodeBackend = createOpenCodeBackend({
    cwd: opts.cwd || process.cwd(),
    mcpServers,
  });

  // Track responses
  let accumulatedResponse = '';
  let isResponseInProgress = false;

  // Set up message handler
  openCodeBackend.onMessage((msg: AgentMessage) => {
    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          if (!isResponseInProgress) {
            messageBuffer.addMessage(msg.textDelta, 'assistant');
            isResponseInProgress = true;
          } else {
            messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
          }
          accumulatedResponse += msg.textDelta;
        }
        break;

      case 'status':
        if (msg.status === 'error') {
          const errorMsg = msg.detail || 'Unknown error';
          messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
          session.sendSessionEvent({ type: 'message', message: `Error: ${errorMsg}` });
        }
        break;

      case 'tool-call':
        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        messageBuffer.addMessage(`🔧 ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`, 'tool');
        session.sendCodexMessage({
          type: 'tool-call',
          name: msg.toolName,
          callId: msg.callId,
          input: msg.args,
          id: randomUUID(),
        });
        break;

      case 'tool-result':
        const resultText = typeof msg.result === 'string'
          ? msg.result.substring(0, 200)
          : JSON.stringify(msg.result).substring(0, 200);
        const truncatedResult = resultText + (typeof msg.result === 'string' && msg.result.length > 200 ? '...' : '');
        messageBuffer.addMessage(`✅ ${msg.toolName}: ${truncatedResult}`, 'result');
        session.sendCodexMessage({
          type: 'tool-call-result',
          callId: msg.callId,
          output: msg.result,
          id: randomUUID(),
        });
        break;

      case 'permission-request':
        session.sendCodexMessage({
          type: 'permission-request',
          permissionId: msg.id,
          reason: msg.reason,
          payload: msg.payload,
          id: randomUUID(),
        });
        break;
    }
  });

  // Handle user messages from mobile
  session.onUserMessage(async (message) => {
    if (!acpSessionId) {
      try {
        const { sessionId } = await openCodeBackend!.startSession();
        acpSessionId = sessionId;
        logger.debug(`[OpenCode] ACP session started: ${acpSessionId}`);
        
        const pushMsg = `OpenCode is ready! Session: ${sessionId}`;
        try {
          await api.push().sendToAllDevices(
            "OpenCode is ready!",
            pushMsg,
            { sessionId: session.sessionId }
          );
        } catch (pushError) {
          logger.debug('[OpenCode] Failed to send ready push', pushError);
        }
      } catch (error) {
        logger.debug('[OpenCode] Error starting ACP session:', error);
        messageBuffer.addMessage('Failed to start OpenCode', 'status');
        return;
      }
    }

    messageBuffer.addMessage(message.content.text, 'user');
    
    try {
      if (!openCodeBackend || !acpSessionId) {
        throw new Error('OpenCode backend or session not initialized');
      }
      
      await openCodeBackend.sendPrompt(acpSessionId, message.content.text);
      logger.debug('[OpenCode] Prompt sent successfully');
    } catch (error) {
      logger.debug('[OpenCode] Error sending prompt:', error);
      messageBuffer.addMessage('Error sending prompt', 'status');
    } finally {
      accumulatedResponse = '';
      isResponseInProgress = false;
    }
  });

  try {
    // Main loop - keep alive
    let thinking = false;
    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
      session.keepAlive(thinking, 'remote');
    }, 2000);

    session.sendSessionEvent({ type: 'ready' });

    // Cleanup on exit
    const cleanup = async () => {
      clearInterval(keepAliveInterval);
      
      try {
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      } catch (e) {
        logger.debug('[OpenCode] Error while closing session', e);
      }

      if (openCodeBackend) {
        await openCodeBackend.dispose();
      }

      happyServer.stop();
      stopCaffeinate();
      
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      }
      if (hasTTY) {
        try { process.stdin.pause(); } catch { /* ignore */ }
      }

      messageBuffer.clear();
      logger.debug('[OpenCode] Cleanup completed');
    };

    process.on('SIGINT', async () => {
      shouldExit = true;
      await handleAbort();
      await cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      shouldExit = true;
      await cleanup();
      process.exit(0);
    });

  } catch (error) {
    logger.debug('[OpenCode] Fatal error:', error);
    process.exit(1);
  }
}
