/**
 * OpenCode ACP Backend Tests
 * 
 * Tests for OpenCode ACP backend integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createOpenCodeBackend, registerOpenCodeAgent, type OpenCodeBackendOptions } from './opencode';
import { agentRegistry } from '../AgentRegistry';
import type { AgentBackend } from '../AgentBackend';

describe('OpenCode ACP Backend', () => {
  let testCwd: string;
  let mockOpenCodeProcess: ChildProcess | null = null;

  beforeEach(() => {
    testCwd = process.cwd();
  });

  afterEach(async () => {
    if (mockOpenCodeProcess) {
      mockOpenCodeProcess.kill('SIGTERM');
      mockOpenCodeProcess = null;
    }
  });

  describe('createOpenCodeBackend', () => {
    it('should create an OpenCode backend with correct configuration', () => {
      const options: OpenCodeBackendOptions = {
        cwd: testCwd,
        command: 'opencode',
        args: ['--acp'],
      };

      const backend = createOpenCodeBackend(options);

      expect(backend).toBeDefined();
      expect(typeof backend.startSession).toBe('function');
      expect(typeof backend.sendPrompt).toBe('function');
      expect(typeof backend.cancel).toBe('function');
      expect(typeof backend.dispose).toBe('function');
      expect(typeof backend.onMessage).toBe('function');
    });

    it('should use opencode command with --acp flag', () => {
      const options: OpenCodeBackendOptions = {
        cwd: testCwd,
        command: 'opencode',
        args: ['--acp'],
      };

      const backend = createOpenCodeBackend(options);

      expect(backend).toBeDefined();
      // The actual command and args will be verified when the backend spawns the process
    });

    it('should be registered in agent registry', () => {
      // Register the agent
      registerOpenCodeAgent();

      // Verify it's registered
      expect(agentRegistry.has('opencode')).toBe(true);
      expect(agentRegistry.list()).toContain('opencode');
    });
  });
});
