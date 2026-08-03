import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createMcpDispatcher, serveStdio } from '../src/mcp/protocol';

describe('shared MCP stdio protocol', () => {
  test('drains pipelined requests after stdin closes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      stdout += chunk;
    });

    const dispatch = createMcpDispatcher({
      serverInfo: { name: 'drain-test', version: '1.0.0' },
      protocolVersion: '2024-11-05',
      tools: [{
        name: 'delayed',
        async run(args) {
          await Bun.sleep(Number(args.delay));
          return String(args.value);
        },
      }],
    });

    const serving = serveStdio(
      dispatch,
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    input.end(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delayed', arguments: { delay: 20, value: 'first' } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delayed', arguments: { delay: 1, value: 'second' } } }),
        '',
      ].join('\n'),
    );
    await serving;

    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses.map((response) => response.id).sort()).toEqual([1, 2]);
    expect(responses.map((response) => response.result.content[0].text).sort()).toEqual(['first', 'second']);
  });
});
