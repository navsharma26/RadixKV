import { AofLogger } from './aof-logger.ts';
import { RespSerializer, STATIC_RESP } from './resp-serializer.ts';
import { StorageEngine } from './storage-engine.ts';
import type { CommandExecutionResult, RespValue } from './types.ts';

export class CommandHandler {
  /**
   * Dispatches and executes a parsed RESP value as a Redis command.
   */
  public static async execute(val: RespValue, engine: StorageEngine, aof?: AofLogger): Promise<CommandExecutionResult> {
    const args = CommandHandler.extractCommandArguments(val);
    if (!args || args.length === 0) {
      return {
        response: RespSerializer.error("Operation not permitted or empty command"),
      };
    }

    const commandName = args[0].toString('utf-8').toUpperCase();
    const commandArgs = args.slice(1);

    switch (commandName) {
      case 'PING':
        return CommandHandler.handlePing(commandArgs);
      case 'ECHO':
        return CommandHandler.handleEcho(commandArgs);
      case 'SET':
        return CommandHandler.handleSet(commandArgs, engine, aof);
      case 'GET':
        return CommandHandler.handleGet(commandArgs, engine);
      case 'DEL':
        return CommandHandler.handleDel(commandArgs, engine, aof);
      case 'INCR':
        return CommandHandler.handleIncr(commandArgs, engine, aof);
      case 'TTL':
        return CommandHandler.handleTtl(commandArgs, engine);
      case 'QUIT':
        return CommandHandler.handleQuit(commandArgs);
      case 'COMMAND':
        // Standard compatibility hook for redis-cli and client handshakes
        return {
          response: STATIC_RESP.EMPTY_ARRAY,
        };
      default:
        return {
          response: RespSerializer.error(`unknown command '${commandName}'`),
        };
    }
  }

  private static async handleSet(args: Buffer[], engine: StorageEngine, aof?: AofLogger): Promise<CommandExecutionResult> {
    if (args.length < 2) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'set' command"),
      };
    }

    const key = args[0].toString('utf-8');
    const value = args[1];
    let exSeconds: number | undefined;

    if (args.length > 2) {
      if (args.length === 4 && args[2].toString('utf-8').toUpperCase() === 'EX') {
        exSeconds = parseInt(args[3].toString('utf-8'), 10);
        if (isNaN(exSeconds) || exSeconds <= 0) {
          return {
            response: RespSerializer.rawError("ERR value is not an integer or out of range"),
          };
        }
      } else {
        return {
          response: RespSerializer.rawError("ERR syntax error"),
        };
      }
    }

    engine.set(key, value, { exSeconds });
    if (aof) {
      await aof.logSet(key, value, exSeconds);
    }

    return {
      response: STATIC_RESP.OK,
    };
  }

  private static handleGet(args: Buffer[], engine: StorageEngine): CommandExecutionResult {
    if (args.length !== 1) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'get' command"),
      };
    }

    const key = args[0].toString('utf-8');
    const val = engine.get(key);

    return {
      response: RespSerializer.bulkString(val),
    };
  }

  private static async handleDel(args: Buffer[], engine: StorageEngine, aof?: AofLogger): Promise<CommandExecutionResult> {
    if (args.length < 1) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'del' command"),
      };
    }

    const keys = args.map(a => a.toString('utf-8'));
    const deletedCount = engine.del(...keys);

    if (aof && deletedCount > 0) {
      await aof.logDel(keys);
    }

    return {
      response: RespSerializer.integer(deletedCount),
    };
  }

  private static async handleIncr(args: Buffer[], engine: StorageEngine, aof?: AofLogger): Promise<CommandExecutionResult> {
    if (args.length !== 1) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'incr' command"),
      };
    }

    const key = args[0].toString('utf-8');
    try {
      const newVal = engine.incr(key);
      if (aof) {
        await aof.logIncr(key);
      }
      return {
        response: RespSerializer.integer(newVal),
      };
    } catch (err: any) {
      return {
        response: RespSerializer.rawError(err.message),
      };
    }
  }

  private static handleTtl(args: Buffer[], engine: StorageEngine): CommandExecutionResult {
    if (args.length !== 1) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'ttl' command"),
      };
    }

    const key = args[0].toString('utf-8');
    const ttlVal = engine.ttl(key);

    return {
      response: RespSerializer.integer(ttlVal),
    };
  }

  private static handlePing(args: Buffer[]): CommandExecutionResult {
    if (args.length === 0) {
      return {
        response: STATIC_RESP.PONG,
      };
    }
    if (args.length === 1) {
      return {
        response: RespSerializer.bulkString(args[0]),
      };
    }
    return {
      response: RespSerializer.error("wrong number of arguments for 'ping' command"),
    };
  }

  private static handleEcho(args: Buffer[]): CommandExecutionResult {
    if (args.length !== 1) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'echo' command"),
      };
    }
    return {
      response: RespSerializer.bulkString(args[0]),
    };
  }

  private static handleQuit(args: Buffer[]): CommandExecutionResult {
    if (args.length !== 0) {
      return {
        response: RespSerializer.error("wrong number of arguments for 'quit' command"),
      };
    }
    return {
      response: STATIC_RESP.OK,
      shouldClose: true,
    };
  }

  /**
   * Normalizes different RESP inputs into command argument buffers.
   */
  private static extractCommandArguments(val: RespValue): Buffer[] | null {
    if (val.type === 'array') {
      if (!val.value) return null;
      const buffers: Buffer[] = [];
      for (const item of val.value) {
        if (item.type === 'bulk_string') {
          if (item.value === null) {
            buffers.push(Buffer.alloc(0));
          } else {
            buffers.push(Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value));
          }
        } else if (item.type === 'simple_string') {
          buffers.push(Buffer.from(item.value, 'utf-8'));
        } else if (item.type === 'integer') {
          buffers.push(Buffer.from(item.value.toString(), 'utf-8'));
        } else {
          return null; // Invalid command format
        }
      }
      return buffers;
    }

    if (val.type === 'bulk_string' && val.value !== null) {
      return [Buffer.isBuffer(val.value) ? val.value : Buffer.from(val.value)];
    }

    if (val.type === 'simple_string') {
      // Inline-style command string (e.g., "PING")
      const parts = val.value.trim().split(/\s+/);
      return parts.map(p => Buffer.from(p, 'utf-8'));
    }

    return null;
  }
}
