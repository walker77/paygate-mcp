import { createHmac } from 'crypto';
import { WebhookVerifier } from '../src/webhook-verify';

describe('WebhookVerifier', () => {
  let verifier: WebhookVerifier;

  beforeEach(() => {
    verifier = new WebhookVerifier({ maxTimestampAge: 300, enforceTimestamp: true });
  });

  afterEach(() => {
    verifier.destroy();
  });

  // ─── Secret Management ──────────────────────────────────────────

  test('upsert and retrieve a secret', () => {
    const ok = verifier.upsertSecret({
      id: 'test-secret',
      secret: 'whsec_abc123',
      scheme: 'hmac-sha256',
      signatureHeader: 'x-signature',
      active: true,
    });
    expect(ok).toBe(true);

    const s = verifier.getSecret('test-secret');
    expect(s).toBeTruthy();
    expect(s!.id).toBe('test-secret');
    expect(s!.secret).toBe('***'); // Secret should be masked
  });

  test('list secrets masks secret values', () => {
    verifier.upsertSecret({ id: 's1', secret: 'secret1', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    verifier.upsertSecret({ id: 's2', secret: 'secret2', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });

    const list = verifier.getSecrets();
    expect(list.length).toBe(2);
    expect(list.every(s => s.secret === '***')).toBe(true);
  });

  test('remove a secret', () => {
    verifier.upsertSecret({ id: 'del', secret: 's', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    expect(verifier.removeSecret('del')).toBe(true);
    expect(verifier.getSecret('del')).toBeNull();
  });

  test('enforce max secrets limit', () => {
    const v = new WebhookVerifier({ maxSecrets: 2 });
    v.upsertSecret({ id: 'a', secret: 'a', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    v.upsertSecret({ id: 'b', secret: 'b', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    const ok = v.upsertSecret({ id: 'c', secret: 'c', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    expect(ok).toBe(false);
    v.destroy();
  });

  test('upsert updates existing secret', () => {
    verifier.upsertSecret({ id: 'x', secret: 'old', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    verifier.upsertSecret({ id: 'x', secret: 'new', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: false });
    const s = verifier.getSecret('x');
    expect(s!.active).toBe(false);
  });

  // ─── HMAC-SHA256 Verification ───────────────────────────────────

  test('verify valid HMAC-SHA256 signature', () => {
    const secret = 'my-webhook-secret';
    verifier.upsertSecret({
      id: 'hmac-test',
      secret,
      scheme: 'hmac-sha256',
      signatureHeader: 'x-signature',
      active: true,
    });

    const body = '{"event":"payment.completed"}';
    const sig = createHmac('sha256', secret).update(body).digest('hex');

    const result = verifier.verify(body, { 'x-signature': sig }, 'hmac-test');
    expect(result.valid).toBe(true);
    expect(result.matchedSecretId).toBe('hmac-test');
  });

  test('reject invalid HMAC-SHA256 signature', () => {
    verifier.upsertSecret({
      id: 'hmac-test',
      secret: 'real-secret',
      scheme: 'hmac-sha256',
      signatureHeader: 'x-signature',
      active: true,
    });

    const body = '{"event":"payment.completed"}';
    const badSig = createHmac('sha256', 'wrong-secret').update(body).digest('hex');

    const result = verifier.verify(body, { 'x-signature': badSig }, 'hmac-test');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  test('HMAC with timestamp enforcement', () => {
    const secret = 'ts-secret';
    verifier.upsertSecret({
      id: 'ts-test',
      secret,
      scheme: 'hmac-sha256',
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
      active: true,
    });

    const body = '{"data":true}';
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const ts = Math.floor(Date.now() / 1000).toString();

    const result = verifier.verify(body, { 'x-signature': sig, 'x-timestamp': ts }, 'ts-test');
    expect(result.valid).toBe(true);
    expect(result.ageSeconds).toBeDefined();
  });

  test('reject expired timestamp', () => {
    const secret = 'ts-secret';
    verifier.upsertSecret({
      id: 'ts-old',
      secret,
      scheme: 'hmac-sha256',
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
      active: true,
    });

    const body = '{"data":true}';
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const oldTs = (Math.floor(Date.now() / 1000) - 600).toString(); // 10 min ago

    const result = verifier.verify(body, { 'x-signature': sig, 'x-timestamp': oldTs }, 'ts-old');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_too_old');
  });

  // ─── Stripe v1 Verification ─────────────────────────────────────

  test('verify valid Stripe v1 signature', () => {
    const secret = 'whsec_test123';
    verifier.upsertSecret({
      id: 'stripe-main',
      secret,
      scheme: 'stripe-v1',
      signatureHeader: 'stripe-signature',
      active: true,
    });

    const body = '{"id":"evt_123","type":"charge.succeeded"}';
    const ts = Math.floor(Date.now() / 1000);
    const signedPayload = `${ts}.${body}`;
    const sig = createHmac('sha256', secret).update(signedPayload).digest('hex');
    const header = `t=${ts},v1=${sig}`;

    const result = verifier.verify(body, { 'stripe-signature': header }, 'stripe-main');
    expect(result.valid).toBe(true);
    expect(result.matchedSecretId).toBe('stripe-main');
    expect(result.timestamp).toBe(ts);
  });

  test('reject Stripe signature with wrong secret', () => {
    verifier.upsertSecret({
      id: 'stripe-bad',
      secret: 'real-secret',
      scheme: 'stripe-v1',
      signatureHeader: 'stripe-signature',
      active: true,
    });

    const body = '{"id":"evt_123"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'wrong-secret').update(`${ts}.${body}`).digest('hex');

    const result = verifier.verify(body, { 'stripe-signature': `t=${ts},v1=${sig}` }, 'stripe-bad');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  // ─── GitHub SHA-256 Verification ────────────────────────────────

  test('verify valid GitHub SHA-256 signature', () => {
    const secret = 'github-webhook-secret';
    verifier.upsertSecret({
      id: 'github-repo',
      secret,
      scheme: 'github-sha256',
      signatureHeader: 'x-hub-signature-256',
      active: true,
    });

    const body = '{"action":"push","ref":"refs/heads/main"}';
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

    const result = verifier.verify(body, { 'x-hub-signature-256': sig }, 'github-repo');
    expect(result.valid).toBe(true);
  });

  test('reject invalid GitHub signature', () => {
    verifier.upsertSecret({
      id: 'github-bad',
      secret: 'real-secret',
      scheme: 'github-sha256',
      signatureHeader: 'x-hub-signature-256',
      active: true,
    });

    const body = '{"action":"push"}';
    const sig = 'sha256=' + createHmac('sha256', 'wrong').update(body).digest('hex');

    const result = verifier.verify(body, { 'x-hub-signature-256': sig }, 'github-bad');
    expect(result.valid).toBe(false);
  });

  // ─── Auto-discovery (no secretId) ───────────────────────────────

  test('auto-discover matching secret when no secretId given', () => {
    const secret1 = 'secret-one';
    const secret2 = 'secret-two';

    verifier.upsertSecret({ id: 's1', secret: secret1, scheme: 'hmac-sha256', signatureHeader: 'x-sig-1', active: true });
    verifier.upsertSecret({ id: 's2', secret: secret2, scheme: 'hmac-sha256', signatureHeader: 'x-sig-2', active: true });

    const body = '{"test":true}';
    const sig = createHmac('sha256', secret2).update(body).digest('hex');

    // Only provide header for s2
    const result = verifier.verify(body, { 'x-sig-2': sig });
    expect(result.valid).toBe(true);
    expect(result.matchedSecretId).toBe('s2');
  });

  test('return no_matching_secret when none match', () => {
    verifier.upsertSecret({ id: 's1', secret: 'abc', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });

    const result = verifier.verify('body', { 'x-sig': 'bad-sig' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_matching_secret');
  });

  // ─── Edge Cases ─────────────────────────────────────────────────

  test('reject verification against inactive secret', () => {
    verifier.upsertSecret({ id: 'inactive', secret: 's', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: false });
    const result = verifier.verify('body', {}, 'inactive');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('secret_inactive');
  });

  test('reject verification for unknown secretId', () => {
    const result = verifier.verify('body', {}, 'nonexistent');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('secret_not_found');
  });

  test('case-insensitive header lookup', () => {
    const secret = 'ci-secret';
    verifier.upsertSecret({
      id: 'ci',
      secret,
      scheme: 'hmac-sha256',
      signatureHeader: 'X-Signature',
      active: true,
    });

    const body = 'test';
    const sig = createHmac('sha256', secret).update(body).digest('hex');

    // Provide header with different case
    const result = verifier.verify(body, { 'x-signature': sig }, 'ci');
    expect(result.valid).toBe(true);
  });

  // ─── Sign Methods ───────────────────────────────────────────────

  test('sign generates valid HMAC', () => {
    const secret = 'sign-secret';
    verifier.upsertSecret({ id: 'signer', secret, scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });

    const body = '{"data":"test"}';
    const sig = verifier.sign(body, 'signer');
    expect(sig).toBeTruthy();

    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(sig).toBe(expected);
  });

  test('signStripe generates valid Stripe format', () => {
    const secret = 'whsec_stripe';
    verifier.upsertSecret({ id: 'stripe-sign', secret, scheme: 'stripe-v1', signatureHeader: 'stripe-signature', active: true });

    const body = '{"id":"evt_1"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = verifier.signStripe(body, 'stripe-sign', ts);

    expect(header).toBeTruthy();
    expect(header).toContain(`t=${ts}`);
    expect(header).toContain('v1=');

    // Verify the generated signature is valid
    const result = verifier.verify(body, { 'stripe-signature': header! }, 'stripe-sign');
    expect(result.valid).toBe(true);
  });

  test('sign returns null for unknown secret', () => {
    expect(verifier.sign('body', 'nope')).toBeNull();
    expect(verifier.signStripe('body', 'nope')).toBeNull();
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track verifications', () => {
    verifier.upsertSecret({ id: 'st', secret: 'abc', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });

    const body = 'test';
    const sig = createHmac('sha256', 'abc').update(body).digest('hex');

    verifier.verify(body, { 'x-sig': sig }, 'st');
    verifier.verify(body, { 'x-sig': 'bad' }, 'st');

    const stats = verifier.getStats();
    expect(stats.totalVerifications).toBe(2);
    expect(stats.successCount).toBe(1);
    expect(stats.failureCount).toBe(1);
    expect(stats.bySecretId['st']).toBe(1);
    expect(stats.totalSecrets).toBe(1);
  });

  test('resetStats clears counters', () => {
    verifier.upsertSecret({ id: 'rs', secret: 'x', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    verifier.verify('body', {}, 'rs');
    verifier.resetStats();
    const stats = verifier.getStats();
    expect(stats.totalVerifications).toBe(0);
    expect(stats.successCount).toBe(0);
  });

  test('destroy clears everything', () => {
    verifier.upsertSecret({ id: 'd', secret: 's', scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });
    verifier.destroy();
    expect(verifier.getSecrets().length).toBe(0);
    expect(verifier.getStats().totalVerifications).toBe(0);
  });

  // ─── Buffer body support ────────────────────────────────────────

  test('accept Buffer body', () => {
    const secret = 'buf-secret';
    verifier.upsertSecret({ id: 'buf', secret, scheme: 'hmac-sha256', signatureHeader: 'x-sig', active: true });

    const body = Buffer.from('{"buffer":true}');
    const sig = createHmac('sha256', secret).update(body).digest('hex');

    const result = verifier.verify(body, { 'x-sig': sig }, 'buf');
    expect(result.valid).toBe(true);
  });
});
