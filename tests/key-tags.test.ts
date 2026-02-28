import { APIKeyTagManager } from '../src/key-tags';

describe('APIKeyTagManager', () => {
  let mgr: APIKeyTagManager;

  beforeEach(() => {
    mgr = new APIKeyTagManager();
  });

  // ── Tag Operations ────────────────────────────────────────────────

  it('sets tags for a key', () => {
    mgr.setTags('k1', ['tier:free', 'region:us']);
    expect(mgr.getTags('k1')).toEqual(expect.arrayContaining(['tier:free', 'region:us']));
  });

  it('replaces existing tags on setTags', () => {
    mgr.setTags('k1', ['a', 'b']);
    mgr.setTags('k1', ['c']);
    expect(mgr.getTags('k1')).toEqual(['c']);
    expect(mgr.findByTag('a')).toHaveLength(0);
  });

  it('adds a single tag', () => {
    mgr.addTag('k1', 'tier:pro');
    expect(mgr.hasTag('k1', 'tier:pro')).toBe(true);
  });

  it('removes a tag', () => {
    mgr.setTags('k1', ['a', 'b']);
    expect(mgr.removeTag('k1', 'a')).toBe(true);
    expect(mgr.hasTag('k1', 'a')).toBe(false);
    expect(mgr.hasTag('k1', 'b')).toBe(true);
  });

  it('returns false removing nonexistent tag', () => {
    expect(mgr.removeTag('k1', 'x')).toBe(false);
  });

  it('clears tags for a key', () => {
    mgr.setTags('k1', ['a', 'b']);
    mgr.clearTags('k1');
    expect(mgr.getTags('k1')).toHaveLength(0);
  });

  it('returns empty array for unknown key', () => {
    expect(mgr.getTags('unknown')).toHaveLength(0);
  });

  it('enforces max tags per key', () => {
    const small = new APIKeyTagManager({ maxTagsPerKey: 2 });
    small.setTags('k1', ['a', 'b']);
    expect(() => small.addTag('k1', 'c')).toThrow('Maximum');
  });

  it('rejects empty tag', () => {
    expect(() => mgr.addTag('k1', '')).toThrow('required');
  });

  it('rejects empty key', () => {
    expect(() => mgr.setTags('', ['a'])).toThrow('required');
  });

  // ── Search ────────────────────────────────────────────────────────

  it('finds keys by single tag', () => {
    mgr.addTag('k1', 'tier:free');
    mgr.addTag('k2', 'tier:free');
    mgr.addTag('k3', 'tier:pro');
    expect(mgr.findByTag('tier:free')).toHaveLength(2);
  });

  it('finds keys matching ALL tags', () => {
    mgr.setTags('k1', ['tier:free', 'region:us']);
    mgr.setTags('k2', ['tier:free', 'region:eu']);
    const result = mgr.findByAllTags(['tier:free', 'region:us']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('k1');
  });

  it('finds keys matching ANY tag', () => {
    mgr.setTags('k1', ['tier:free']);
    mgr.setTags('k2', ['region:eu']);
    mgr.setTags('k3', ['other']);
    expect(mgr.findByAnyTag(['tier:free', 'region:eu'])).toHaveLength(2);
  });

  it('searches tags by prefix', () => {
    mgr.addTag('k1', 'tier:free');
    mgr.addTag('k2', 'tier:pro');
    mgr.addTag('k3', 'region:us');
    const results = mgr.searchTags('tier:');
    expect(results).toHaveLength(2);
    expect(results).toContain('tier:free');
    expect(results).toContain('tier:pro');
  });

  it('lists all unique tags', () => {
    mgr.addTag('k1', 'a');
    mgr.addTag('k1', 'b');
    mgr.addTag('k2', 'a');
    mgr.addTag('k2', 'c');
    expect(mgr.listAllTags()).toEqual(['a', 'b', 'c']);
  });

  // ── Grouping ──────────────────────────────────────────────────────

  it('groups tags by prefix', () => {
    mgr.setTags('k1', ['tier:free', 'region:us']);
    mgr.setTags('k2', ['tier:pro', 'region:eu']);
    const group = mgr.groupByPrefix('tier');
    expect(group.prefix).toBe('tier');
    expect(group.values).toEqual(['free', 'pro']);
    expect(group.keyCount).toBe(2);
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.setTags('k1', ['a', 'b']);
    mgr.setTags('k2', ['a', 'c']);
    const stats = mgr.getStats();
    expect(stats.totalKeys).toBe(2);
    expect(stats.totalTags).toBe(4);
    expect(stats.uniqueTags).toBe(3);
    expect(stats.avgTagsPerKey).toBe(2);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.setTags('k1', ['a', 'b']);
    mgr.destroy();
    expect(mgr.getStats().totalKeys).toBe(0);
    expect(mgr.getStats().uniqueTags).toBe(0);
  });
});
