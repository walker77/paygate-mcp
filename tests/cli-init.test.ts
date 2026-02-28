/**
 * Tests for the CLI init wizard module (cli-init.ts).
 * Tests the config generation logic, not the interactive prompts (which require stdin mocking).
 */

import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('CLI Init Module', () => {
  // Test that the module exports runInit
  it('should export runInit function', () => {
    const { runInit } = require('../src/cli-init');
    expect(typeof runInit).toBe('function');
  });

  describe('config file output format', () => {
    const tmpFile = join(tmpdir(), `paygate-init-test-${Date.now()}.json`);

    afterEach(() => {
      try { unlinkSync(tmpFile); } catch {}
    });

    it('should refuse to overwrite existing file without --force', async () => {
      // Create a pre-existing file
      writeFileSync(tmpFile, '{}', 'utf-8');

      const { runInit } = require('../src/cli-init');

      // Mock process.exit and process.stdin
      const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as any);
      const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await runInit({ output: tmpFile });
      } catch (e) {
        // Expected: process.exit called
      }

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('already exists'));

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });
});
