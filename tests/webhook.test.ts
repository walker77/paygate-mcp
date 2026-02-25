import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { WebhookEmitter } from '../src/webhook';
import { UsageEvent } from '../src/types';

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    timestamp: new Date().toISOString(),
    apiKey: 'pg_test1234',
    keyName: 'test-key',
    tool: 'search',
    creditsCharged: 1,
    allowed: true,
    ...overrides,
  };
}

describe('WebhookEmitter', () => {
  let mockServer: Server;
  let receivedBodies: string[];
  let serverPort: number;

  beforeEach((done) => {
    receivedBodies = [];
    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedBodies.push(body);
        res.writeHead(200);
        res.end('ok');
      });
    });
    mockServer.listen(0, () => {
      serverPort = (mockServer.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    mockServer.close(done);
  });

  it('should batch and send events on flush', (done) => {
    const emitter = new WebhookEmitter(
      `http://localhost:${serverPort}/hook`,
      10,
      60000, // long interval so we control flush manually
    );

    emitter.emit(makeEvent({ tool: 'tool-a' }));
    emitter.emit(makeEvent({ tool: 'tool-b' }));
    emitter.flush();

    setTimeout(() => {
      expect(receivedBodies).toHaveLength(1);
      const parsed = JSON.parse(receivedBodies[0]);
      expect(parsed.events).toHaveLength(2);
      expect(parsed.events[0].tool).toBe('tool-a');
      expect(parsed.events[1].tool).toBe('tool-b');
      expect(parsed.sentAt).toBeDefined();
      emitter.destroy();
      done();
    }, 500);
  }, 10000);

  it('should auto-flush when batch size is reached', (done) => {
    const emitter = new WebhookEmitter(
      `http://localhost:${serverPort}/hook`,
      3, // batch size of 3
      60000,
    );

    emitter.emit(makeEvent());
    emitter.emit(makeEvent());
    emitter.emit(makeEvent()); // triggers auto-flush

    setTimeout(() => {
      expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(receivedBodies[0]);
      expect(parsed.events).toHaveLength(3);
      emitter.destroy();
      done();
    }, 500);
  }, 10000);

  it('should flush remaining events on destroy', (done) => {
    const emitter = new WebhookEmitter(
      `http://localhost:${serverPort}/hook`,
      100, // large batch so no auto-flush
      60000,
    );

    emitter.emit(makeEvent());
    emitter.emit(makeEvent());
    emitter.destroy(); // should flush the 2 buffered events

    setTimeout(() => {
      expect(receivedBodies).toHaveLength(1);
      const parsed = JSON.parse(receivedBodies[0]);
      expect(parsed.events).toHaveLength(2);
      done();
    }, 500);
  }, 10000);

  it('should not crash on failed delivery', (done) => {
    // Point at a port that's not listening
    const emitter = new WebhookEmitter('http://localhost:1/bad', 10, 60000);
    emitter.emit(makeEvent());
    emitter.flush();

    // Should not throw — just silently fail
    setTimeout(() => {
      emitter.destroy();
      done();
    }, 500);
  }, 10000);

  it('should not send when buffer is empty', () => {
    const emitter = new WebhookEmitter(
      `http://localhost:${serverPort}/hook`,
      10,
      60000,
    );

    emitter.flush(); // nothing to send
    expect(receivedBodies).toHaveLength(0);
    emitter.destroy();
  });
});
