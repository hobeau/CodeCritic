const { buildSearchSignature } = require('../toolUtils');

describe('toolUtils', () => {
  describe('buildSearchSignature', () => {
    it('should include tool name when provided', () => {
      const sig = buildSearchSignature('search', {
        query: 'foo',
        include: '**/*',
        exclude: '**/node_modules/**',
        maxResults: 20
      });

      const obj = JSON.parse(sig);
      expect(obj.tool).toBe('search');
      expect(obj.query).toBe('foo');
      expect(obj.maxResults).toBe(20);
    });

    it('should differ when query differs', () => {
      const a = buildSearchSignature('search', { query: 'foo', include: '**/*', exclude: '**/node_modules/**', maxResults: 20 });
      const b = buildSearchSignature('search', { query: 'bar', include: '**/*', exclude: '**/node_modules/**', maxResults: 20 });
      expect(a).not.toBe(b);
    });

    it('should support legacy buildSearchSignature(args) calls', () => {
      const sig = buildSearchSignature({ query: 'foo', maxResults: 10 });
      const obj = JSON.parse(sig);
      expect(obj.tool).toBe('');
      expect(obj.query).toBe('foo');
      expect(obj.maxResults).toBe(10);
    });
  });
});

