import * as fs from 'node:fs/promises';
import { CommandHandler } from './command-handler.ts';
import { RespParser } from './resp-parser.ts';
import { StorageEngine } from './storage-engine.ts';

export interface AofRecoveryResult {
  commandsReplayed: number;
  bytesRead: number;
  truncatedBytes: number;
  elapsedMs: number;
}

/**
 * Crash-recovery bootstrapper.
 * Sequentially streams and parses the AOF file on startup to restore the exact
 * in-memory engine state before the TCP server opens for client traffic.
 * Detects and repairs incomplete trailing writes caused by sudden power cuts or crashes.
 */
export class AofRecovery {
  /**
   * Replays an AOF log into the provided StorageEngine.
   */
  public static async restore(filePath: string, engine: StorageEngine): Promise<AofRecoveryResult> {
    const startTime = Date.now();

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      // No AOF file found; fresh start
      return {
        commandsReplayed: 0,
        bytesRead: 0,
        truncatedBytes: 0,
        elapsedMs: Date.now() - startTime,
      };
    }

    const fileHandle = await fs.open(filePath, 'r+');
    const parser = new RespParser();

    const CHUNK_SIZE = 64 * 1024; // 64 KB read buffer
    const readBuffer = Buffer.allocUnsafe(CHUNK_SIZE);

    let totalBytesRead = 0;
    let commandsReplayed = 0;
    let lastValidFileOffset = 0;

    try {
      while (true) {
        const { bytesRead } = await fileHandle.read(readBuffer, 0, CHUNK_SIZE, null);
        if (bytesRead === 0) break;

        totalBytesRead += bytesRead;
        const chunk = readBuffer.subarray(0, bytesRead);
        const parsedValues = parser.execute(chunk);

        for (const val of parsedValues) {
          CommandHandler.execute(val, engine);
          commandsReplayed++;
        }
      }

      // Check if there are leftover unparsed bytes or incomplete frames
      // (indicating an un-synced power failure or crash truncated the final command)
      let truncatedBytes = 0;
      if (parser.isIncomplete) {
        const validSize = parser.lastValidOffset;
        truncatedBytes = totalBytesRead - validSize;
        if (truncatedBytes > 0) {
          await fileHandle.truncate(validSize);
          totalBytesRead = validSize;
        }
      }

      return {
        commandsReplayed,
        bytesRead: totalBytesRead,
        truncatedBytes,
        elapsedMs: Date.now() - startTime,
      };
    } finally {
      await fileHandle.close();
    }
  }
}
