// Replaces global fetch with canned registry responses so vet-package runs offline and deterministically.
// MOCK_FAIL=<substring,...> makes matching URLs fail like a network error; MOCK_FAIL=ALL fails everything.
const failing = (process.env.MOCK_FAIL ?? '').split(',').filter(Boolean);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const old = '2020-01-01T00:00:00Z';
const manifest = (version) => ({
  version, maintainers: [{ name: 'a' }, { name: 'b' }],
  repository: { url: 'git+https://github.com/owner/demo.git' },
  dist: { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } },
});

globalThis.fetch = async (input) => {
  const url = String(input);
  if (failing.includes('ALL') || failing.some((f) => url.includes(f))) throw new TypeError(`fetch failed (mock): ${url}`);
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname);
  if (u.host === 'registry.npmjs.org') {
    if (path === '/demo') return json({ 'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' }, versions: { '1.0.0': {}, '2.0.0': {}, '3.0.0-beta.1': {} } });
    const m = /^\/demo\/(.+)$/.exec(path);
    if (m && ['1.0.0', '2.0.0', '3.0.0-beta.1'].includes(m[1])) return json(manifest(m[1]));
    return json({ error: 'Not found' }, 404);
  }
  if (u.host === 'api.npmjs.org') return json({ downloads: 500_000 });
  if (u.host === 'api.deps.dev') {
    if (path.endsWith(':similarlyNamedPackages')) return json({ packages: [] });
    if (path.endsWith(':dependencies')) return json({ nodes: [{}, {}] });
    if (path.includes('/versions/')) return json({ licenses: ['MIT'], relatedProjects: [] });
    return json({ versions: ['1.0.0', '2.0.0', '3.0.0-beta.1'].map((v) => ({ versionKey: { version: v }, publishedAt: old })) });
  }
  if (u.host === 'api.osv.dev') return json({});
  if (u.host === 'api.github.com') return json({ full_name: 'owner/demo', stargazers_count: 900, pushed_at: new Date().toISOString(), archived: false });
  if (u.host === 'api.securityscorecards.dev') return json({ score: 7 });
  return json({}, 404);
};
