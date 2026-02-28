import { WebhookTemplateEngine } from '../src/webhook-templates';

describe('WebhookTemplateEngine', () => {
  let engine: WebhookTemplateEngine;

  beforeEach(() => {
    engine = new WebhookTemplateEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  // ─── Template CRUD ────────────────────────────────────────────────

  test('upsert and retrieve a template', () => {
    const ok = engine.upsertTemplate({
      id: 'slack',
      name: 'Slack Alert',
      format: 'json',
      body: '{"text":"{{message}}"}',
      active: true,
    });
    expect(ok).toBe(true);
    const tpl = engine.getTemplate('slack');
    expect(tpl).toBeTruthy();
    expect(tpl!.name).toBe('Slack Alert');
  });

  test('list all templates', () => {
    engine.upsertTemplate({ id: 'a', name: 'A', format: 'json', body: '{}', active: true });
    engine.upsertTemplate({ id: 'b', name: 'B', format: 'text', body: 'hi', active: true });
    expect(engine.getTemplates().length).toBe(2);
  });

  test('remove a template', () => {
    engine.upsertTemplate({ id: 'del', name: 'Del', format: 'text', body: 'x', active: true });
    expect(engine.removeTemplate('del')).toBe(true);
    expect(engine.getTemplate('del')).toBeNull();
  });

  test('reject empty body', () => {
    expect(engine.upsertTemplate({ id: 'bad', name: 'Bad', format: 'text', body: '', active: true })).toBe(false);
  });

  test('enforce max templates', () => {
    const small = new WebhookTemplateEngine({ maxTemplates: 2 });
    small.upsertTemplate({ id: 'a', name: 'A', format: 'text', body: 'x', active: true });
    small.upsertTemplate({ id: 'b', name: 'B', format: 'text', body: 'x', active: true });
    expect(small.upsertTemplate({ id: 'c', name: 'C', format: 'text', body: 'x', active: true })).toBe(false);
    small.destroy();
  });

  test('enforce max body size', () => {
    const small = new WebhookTemplateEngine({ maxBodySize: 10 });
    expect(small.upsertTemplate({ id: 'big', name: 'Big', format: 'text', body: 'a'.repeat(20), active: true })).toBe(false);
    small.destroy();
  });

  // ─── Basic Rendering ──────────────────────────────────────────────

  test('render text template with variables', () => {
    engine.upsertTemplate({
      id: 'greet',
      name: 'Greeting',
      format: 'text',
      body: 'Hello {{name}}, your key is {{key}}.',
      active: true,
    });
    const result = engine.render('greet', { name: 'Alice', key: 'key_abc' });
    expect(result).toBeTruthy();
    expect(result!.body).toBe('Hello Alice, your key is key_abc.');
    expect(result!.varsUsed).toContain('name');
    expect(result!.varsUsed).toContain('key');
  });

  test('render with missing variables', () => {
    engine.upsertTemplate({
      id: 'tpl',
      name: 'Tpl',
      format: 'text',
      body: 'Hello {{name}}, tool={{tool}}.',
      active: true,
    });
    const result = engine.render('tpl', { name: 'Bob' });
    expect(result!.body).toBe('Hello Bob, tool=.');
    expect(result!.missingVars).toContain('tool');
  });

  test('render returns null for unknown template', () => {
    expect(engine.render('nonexistent', {})).toBeNull();
  });

  test('render returns null for inactive template', () => {
    engine.upsertTemplate({ id: 'off', name: 'Off', format: 'text', body: 'x', active: false });
    expect(engine.render('off', {})).toBeNull();
  });

  // ─── Default Variables ────────────────────────────────────────────

  test('default vars used when not provided', () => {
    engine.upsertTemplate({
      id: 'tpl',
      name: 'Tpl',
      format: 'text',
      body: 'env={{env}}',
      defaultVars: { env: 'production' },
      active: true,
    });
    const result = engine.render('tpl', {});
    expect(result!.body).toBe('env=production');
  });

  test('provided vars override defaults', () => {
    engine.upsertTemplate({
      id: 'tpl',
      name: 'Tpl',
      format: 'text',
      body: 'env={{env}}',
      defaultVars: { env: 'production' },
      active: true,
    });
    const result = engine.render('tpl', { env: 'staging' });
    expect(result!.body).toBe('env=staging');
  });

  // ─── Required Variables ───────────────────────────────────────────

  test('required vars reported as missing', () => {
    engine.upsertTemplate({
      id: 'tpl',
      name: 'Tpl',
      format: 'text',
      body: '{{event}}',
      requiredVars: ['event', 'key'],
      active: true,
    });
    const result = engine.render('tpl', { event: 'alert' });
    expect(result!.missingVars).toContain('key');
  });

  // ─── JSON Escaping ────────────────────────────────────────────────

  test('JSON format escapes special characters', () => {
    engine.upsertTemplate({
      id: 'json',
      name: 'JSON',
      format: 'json',
      body: '{"msg":"{{message}}"}',
      active: true,
    });
    const result = engine.render('json', { message: 'He said "hello"\nnewline' });
    expect(result!.body).toContain('\\"hello\\"');
    expect(result!.body).toContain('\\n');
  });

  // ─── Form URL Encoding ───────────────────────────────────────────

  test('form format URL-encodes values', () => {
    engine.upsertTemplate({
      id: 'form',
      name: 'Form',
      format: 'form',
      body: 'key={{key}}&msg={{msg}}',
      active: true,
    });
    const result = engine.render('form', { key: 'key_abc', msg: 'hello world' });
    expect(result!.body).toBe('key=key_abc&msg=hello%20world');
  });

  // ─── Conditionals ─────────────────────────────────────────────────

  test('conditional includes content when var is truthy', () => {
    engine.upsertTemplate({
      id: 'cond',
      name: 'Cond',
      format: 'text',
      body: 'Hello{{#if extra}} with extra{{/if}}!',
      active: true,
    });
    expect(engine.render('cond', { extra: 'yes' })!.body).toBe('Hello with extra!');
    expect(engine.render('cond', {})!.body).toBe('Hello!');
  });

  test('conditional excludes content when var is false', () => {
    engine.upsertTemplate({
      id: 'cond',
      name: 'Cond',
      format: 'text',
      body: 'Start{{#if show}} visible{{/if}} end',
      active: true,
    });
    expect(engine.render('cond', { show: 'false' })!.body).toBe('Start end');
  });

  // ─── Header Interpolation ────────────────────────────────────────

  test('headers are interpolated', () => {
    engine.upsertTemplate({
      id: 'h',
      name: 'H',
      format: 'text',
      body: 'body',
      headers: { 'Authorization': 'Bearer {{token}}' },
      active: true,
    });
    const result = engine.render('h', { token: 'abc123' });
    expect(result!.headers['Authorization']).toBe('Bearer abc123');
  });

  // ─── Inline Rendering ─────────────────────────────────────────────

  test('renderInline works without stored template', () => {
    const result = engine.renderInline('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  // ─── Validation ───────────────────────────────────────────────────

  test('validateTemplate extracts variables', () => {
    const v = engine.validateTemplate('{{event}} on {{key}}', 'text');
    expect(v.valid).toBe(true);
    expect(v.extractedVars).toContain('event');
    expect(v.extractedVars).toContain('key');
  });

  test('validateTemplate detects unbalanced conditionals', () => {
    const v = engine.validateTemplate('{{#if show}} missing close', 'text');
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toContain('Unbalanced');
  });

  test('extractVars returns all variable names', () => {
    const vars = engine.extractVars('{{a}} {{b}} {{#if c}}inside{{/if}}');
    expect(vars).toContain('a');
    expect(vars).toContain('b');
    expect(vars).toContain('c');
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track renders and errors', () => {
    engine.upsertTemplate({ id: 'tpl', name: 'T', format: 'text', body: 'x', active: true });
    engine.render('tpl', {});
    engine.render('tpl', {});
    engine.render('nonexistent', {}); // error

    const stats = engine.getStats();
    expect(stats.totalTemplates).toBe(1);
    expect(stats.activeTemplates).toBe(1);
    expect(stats.totalRenders).toBe(2);
    expect(stats.rendersByTemplate['tpl']).toBe(2);
    expect(stats.totalErrors).toBe(1);
  });

  test('destroy clears everything', () => {
    engine.upsertTemplate({ id: 'tpl', name: 'T', format: 'text', body: 'x', active: true });
    engine.render('tpl');
    engine.destroy();
    expect(engine.getTemplates().length).toBe(0);
    expect(engine.getStats().totalRenders).toBe(0);
  });
});
