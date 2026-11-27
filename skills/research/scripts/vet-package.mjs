#!/usr/bin/env node
// vet-package: proves an npm package exists and is healthy before anyone adds it, from registry data rather than memory.
//
// Why: about one in five packages recommended by LLMs did not exist in one study (USENIX Security 2025), and the
// invented names repeat across runs, so attackers register them. Packages also get hijacked (event-stream, the
// Sept 2025 chalk/debug phishing, the Shai-Hulud worms). This script checks the live registry and advisory
// databases for each candidate and gives a verdict.
//
// Usage:
//   node vet-package.mjs <name[@version]> [more names...] [--json] [--rn | --no-rn]
// React Native checks (React Native Directory, Expo bundled modules) run when --rn is given, or automatically when
// package.json in this directory or a workspace package (apps/*, packages/*) depends on react-native or expo.
//
// Verdicts:
//   REJECT  a hard gate failed: does not exist, deprecated, known vulnerability or malware, archived repo,
//           unmaintained or New-Architecture-incompatible React Native library
//   REVIEW  needs a human judgement: install scripts, a much more popular similarly named package, missing repo,
//           a trust downgrade from the previous release, or a check that could not be completed (unknown)
//   OK      no gate failed and every gate check completed; soft concerns are listed as cautions
// A failed API call is reported as unknown and never counts as a pass.
// Exit codes: 0 all OK, 1 at least one REJECT, 3 at least one REVIEW (no REJECT), 2 usage error.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const MAX_PACKAGES = 20;
const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const HEADERS = { 'user-agent': 'mend-vet-package/1.1' };
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const SOFT = { minAgeDays: 90, minVersionAgeDays: 7, minWeeklyDownloads: 10_000, maxPushAgeDays: 365, maxTransitiveDeps: 50, minScorecard: 4 };

function fail(message) {
  process.stderr.write(`vet-package: ${message}\n`);
  process.exit(2);
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  try {
    const res = await fetch(url, { method, body, headers: { ...HEADERS, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; } // Some endpoints answer errors in plain text.
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, status: 0, json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const describe = (res) => (res.status ? `HTTP ${res.status}` : res.error ?? 'no response');
const registryPath = (name) => (name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));
const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS) : null);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : 'unknown');
const osvQuery = (name, version) => request('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package: { name, ecosystem: 'npm' }, version }) });

function parseSpec(spec) {
  const at = spec.lastIndexOf('@');
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: null };
}

function semverParts(v) {
  const m = SEMVER.exec(v);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

function compareNums(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// The highest stable release below `target`, so trust comparisons use the same release channel.
function previousStable(versions, target) {
  const t = semverParts(target);
  if (!t) return null;
  let best = null;
  for (const v of versions) {
    const p = semverParts(v);
    if (!p || p.pre || compareNums(p.nums, t.nums) >= 0) continue;
    if (!best || compareNums(p.nums, best.nums) > 0) best = { v, nums: p.nums };
  }
  return best?.v ?? null;
}

function githubSlug(manifest, depsVersion) {
  const related = depsVersion?.relatedProjects?.find((p) => p.relationType === 'SOURCE_REPO');
  const fromDeps = related?.projectKey?.id;
  if (fromDeps?.startsWith('github.com/')) return { slug: fromDeps.slice('github.com/'.length), verified: related.relationProvenance === 'SLSA_ATTESTATION' };
  const raw = typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url;
  const match = raw ? /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(raw) : null;
  return match ? { slug: match[1], verified: false } : null;
}

const hasProvenance = (manifest) => Boolean(manifest?.dist?.attestations || manifest?._npmUser?.trustedPublisher);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } // Unreadable manifests only disable auto-detection.
}

// Find react-native / expo in ./package.json or in workspace packages one or two levels down.
function detectProject() {
  const candidates = ['package.json'];
  for (const dir of ['apps', 'packages']) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true }).slice(0, 200)) {
      if (entry.isDirectory()) candidates.push(join(dir, entry.name, 'package.json'));
    }
  }
  for (const path of candidates) {
    const pkg = existsSync(path) ? readJson(path) : null;
    if (!pkg) continue;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['react-native'] || deps.expo) return { isReactNative: true, source: path, expoRange: deps.expo ?? null };
  }
  return { isReactNative: false, source: null, expoRange: null };
}

async function loadExpoBundled(expoRange) {
  let version = null;
  let how = 'latest Expo SDK (no expo dependency found)';
  const full = expoRange ? /(\d+\.\d+\.\d+)/.exec(expoRange)?.[1] : null;
  const major = expoRange ? /(\d+)/.exec(expoRange)?.[1] : null;
  if (full) { version = full; how = `expo ${expoRange} from package.json`; }
  else if (major) {
    const tags = (await request('https://registry.npmjs.org/expo', { headers: { accept: ABBREVIATED } })).json?.['dist-tags'] ?? {};
    version = tags[`sdk-${major}`] ?? null;
    how = version ? `expo ${expoRange} resolved via dist-tag sdk-${major}` : how;
  }
  version = version ?? (await request('https://registry.npmjs.org/expo/latest')).json?.version ?? null;
  if (!version) return { version: null, modules: null, how: 'unknown (registry unreachable)' };
  const res = await request(`https://cdn.jsdelivr.net/npm/expo@${version}/bundledNativeModules.json`);
  return { version, modules: res.ok ? res.json : null, how: res.ok ? how : `${how}; bundled module list unavailable (${describe(res)})` };
}

async function vet(spec, ctx) {
  const { name, version: requested } = parseSpec(spec);
  const r = { spec, name, version: requested, verdict: 'OK', gates: [], review: [], cautions: [], unknown: [], info: [], facts: {} };
  const gate = (msg) => r.gates.push(msg);
  const review = (msg) => r.review.push(msg);
  const caution = (msg) => r.cautions.push(msg);
  const unknown = (what, res) => r.unknown.push(`${what} (${describe(res)})`);
  const finish = () => { r.verdict = r.gates.length > 0 ? 'REJECT' : r.review.length > 0 || r.unknown.length > 0 ? 'REVIEW' : 'OK'; return r; };

  if (!NAME_RE.test(name)) { gate('not a valid npm package name'); return finish(); }

  const packument = await request(`https://registry.npmjs.org/${registryPath(name)}`, { headers: { accept: ABBREVIATED } });
  if (packument.status === 404) {
    gate('does not exist on npm. It may be a hallucinated name: search again by what it should do, and never install a similar-sounding name');
    return finish();
  }
  if (!packument.ok || !packument.json) { unknown('npm registry; nothing was verified', packument); return finish(); }

  const versions = Object.keys(packument.json.versions ?? {});
  const version = requested ?? packument.json['dist-tags']?.latest;
  if (!version || !versions.includes(version)) {
    // Registries unpublish malicious versions, so ask OSV why a requested version is missing.
    const missing = version ? await osvQuery(name, version) : null;
    const ids = (missing?.json?.vulns ?? []).map((v) => v.id);
    gate(`version ${version ?? '(none)'} does not exist on npm${ids.length > 0 ? `; it was removed and has advisories: ${ids.join(', ')}` : ''}`);
    return finish();
  }
  r.version = version;
  const abbreviatedVersion = packument.json.versions[version];
  const previous = previousStable(versions, version);
  const enc = encodeURIComponent(name);
  const encV = encodeURIComponent(version);

  const [manifest, prevManifest, depsPkg, depsVer, depsGraph, osv, downloads, similar, rnDir] = await Promise.all([
    request(`https://registry.npmjs.org/${registryPath(name)}/${encV}`),
    previous ? request(`https://registry.npmjs.org/${registryPath(name)}/${encodeURIComponent(previous)}`) : Promise.resolve(null),
    request(`https://api.deps.dev/v3/systems/npm/packages/${enc}`),
    request(`https://api.deps.dev/v3/systems/npm/packages/${enc}/versions/${encV}`),
    request(`https://api.deps.dev/v3/systems/npm/packages/${enc}/versions/${encV}:dependencies`),
    osvQuery(name, version),
    request(`https://api.npmjs.org/downloads/point/last-week/${name}`),
    request(`https://api.deps.dev/v3alpha/systems/npm/packages/${enc}:similarlyNamedPackages`),
    ctx.rn ? request(`https://reactnative.directory/api/library?name=${enc}`) : Promise.resolve(null),
  ]);

  const m = manifest.ok ? manifest.json : null;
  if (!m) unknown('version manifest (install scripts, maintainers, provenance)', manifest);

  // Hard gates
  if (m?.deprecated || abbreviatedVersion?.deprecated) gate(`deprecated: ${m?.deprecated ?? abbreviatedVersion.deprecated}`);
  if (osv.ok) {
    const vulns = osv.json?.vulns ?? [];
    const malware = vulns.filter((v) => v.id.startsWith('MAL-'));
    const other = vulns.filter((v) => !v.id.startsWith('MAL-'));
    if (malware.length > 0) gate(`MALWARE reported for this version: ${malware.map((v) => v.id).join(', ')}`);
    if (other.length > 0) gate(`known vulnerabilities in ${version}: ${other.map((v) => `${v.id}${v.summary ? ` (${v.summary.slice(0, 60)})` : ''}`).join('; ')}`);
    r.facts.vulnerabilities = vulns.length;
  } else unknown('OSV vulnerability database', osv);

  // Age and adoption
  if (depsPkg.ok) {
    const published = (depsPkg.json?.versions ?? []).map((v) => v.publishedAt).filter(Boolean).sort();
    r.facts.firstPublished = published[0] ?? null;
    r.facts.versionPublished = depsPkg.json?.versions?.find((v) => v.versionKey?.version === version)?.publishedAt ?? null;
    const ageDays = daysSince(r.facts.firstPublished);
    const versionAgeDays = daysSince(r.facts.versionPublished);
    if (ageDays !== null && ageDays < SOFT.minAgeDays) caution(`package is only ${ageDays} days old`);
    if (versionAgeDays !== null && versionAgeDays < SOFT.minVersionAgeDays) caution(`this version is ${versionAgeDays} days old; hijacked releases are usually caught within days, so consider pinning an older one`);
  } else r.info.push(`publish dates unavailable (deps.dev ${describe(depsPkg)})`);

  if (downloads.ok) {
    r.facts.weeklyDownloads = downloads.json?.downloads ?? null;
    if ((r.facts.weeklyDownloads ?? 0) < SOFT.minWeeklyDownloads) caution(`low adoption: ${fmt(r.facts.weeklyDownloads)} downloads last week`);
  } else unknown('npm downloads (needed for the typo-squat comparison)', downloads);

  // Install-time code and publisher trust
  const installScripts = ['preinstall', 'install', 'postinstall'].filter((s) => m?.scripts?.[s]);
  if (abbreviatedVersion?.hasInstallScript || installScripts.length > 0) {
    review(`runs code on install (${installScripts.join(', ') || 'install script'}). Acceptable only for known native-binary packages; record why`);
  }
  r.facts.maintainers = m?.maintainers?.length ?? null;
  if (r.facts.maintainers === 1) caution('single maintainer (one phished account can publish anything)');
  r.facts.provenance = m ? hasProvenance(m) : null;
  if (previous) {
    const prev = prevManifest?.ok ? prevManifest.json : null;
    if (!prev) unknown(`previous release ${previous} (trust-downgrade check)`, prevManifest ?? { status: 0 });
    else if (m) {
      if (hasProvenance(prev) && !hasProvenance(m)) review(`trust downgrade: ${previous} had provenance or trusted publishing and ${version} does not (a common hijack signal)`);
      const before = new Set((prev.maintainers ?? []).map((x) => x.name));
      const added = (m.maintainers ?? []).map((x) => x.name).filter((n) => !before.has(n));
      if (added.length > 0) caution(`maintainers added since ${previous}: ${added.join(', ')}`);
    }
  }

  // Licence and dependency weight
  if (depsVer.ok) {
    r.facts.licenses = depsVer.json?.licenses ?? [];
    if (r.facts.licenses.length === 0) caution('no licence declared');
    if (r.facts.licenses.some((l) => /\b(A?GPL|SSPL|EUPL)\b/i.test(l))) caution(`copyleft licence (${r.facts.licenses.join(', ')}): check compatibility with your app's distribution`);
  } else r.info.push(`licence and source-repo link unavailable (deps.dev ${describe(depsVer)})`);
  if (depsGraph.ok) {
    r.facts.transitiveDeps = Math.max(0, (depsGraph.json?.nodes?.length ?? 1) - 1);
    if (r.facts.transitiveDeps > SOFT.maxTransitiveDeps) caution(`${r.facts.transitiveDeps} transitive dependencies`);
  } else r.info.push(`dependency graph unavailable (deps.dev ${describe(depsGraph)})`);

  // Typo-squat check
  if (!similar.ok && similar.status !== 404) unknown('similarly named packages (typo-squat check)', similar);
  else if (similar.ok) {
    const names = (similar.json?.packages ?? []).map((p) => p.name ?? p.packageKey?.name ?? p.versionKey?.name).filter(Boolean).slice(0, 5);
    const counts = await Promise.all(names.map((n) => request(`https://api.npmjs.org/downloads/point/last-week/${n}`)));
    const failed = names.filter((_, i) => !counts[i].ok);
    if (failed.length > 0) unknown(`downloads for similarly named ${failed.join(', ')}`, counts.find((c) => !c.ok));
    const bigger = names.filter((n, i) => counts[i].ok && (counts[i].json?.downloads ?? 0) > 100 * Math.max(1, r.facts.weeklyDownloads ?? 0));
    if (bigger.length > 0) review(`similarly named and far more popular: ${bigger.join(', ')}. Make sure this is the package you meant, not a typo-squat`);
  }

  // Source repository
  const repo = githubSlug(m, depsVer.ok ? depsVer.json : null);
  if (!repo) review('no GitHub source repository found; the code cannot be inspected or its health checked');
  else {
    const gh = await request(`https://api.github.com/repos/${repo.slug}`, { headers: { accept: 'application/vnd.github+json' } });
    const slug = gh.ok && gh.json?.full_name ? gh.json.full_name : repo.slug; // GitHub's casing; Scorecard is case-sensitive.
    r.facts.repo = `github.com/${slug}`;
    r.facts.repoVerified = repo.verified;
    if (gh.ok) {
      r.facts.stars = gh.json?.stargazers_count ?? null;
      r.facts.lastPush = gh.json?.pushed_at ?? null;
      if (gh.json?.archived) gate('source repository is archived');
      const pushAge = daysSince(r.facts.lastPush);
      if (pushAge !== null && pushAge > SOFT.maxPushAgeDays) caution(`no commits for ${pushAge} days`);
    } else if (gh.status === 404) review(`declared repository ${r.facts.repo} does not exist; the package may be copying someone else's repo URL`);
    else unknown('GitHub repository (archived check; unauthenticated limit is 60 requests an hour)', gh);
    const scorecard = await request(`https://api.securityscorecards.dev/projects/github.com/${slug}`);
    if (scorecard.ok) {
      r.facts.scorecard = scorecard.json?.score ?? null;
      if (r.facts.scorecard !== null && r.facts.scorecard < SOFT.minScorecard) caution(`OpenSSF Scorecard ${r.facts.scorecard}/10`);
    } else if (scorecard.status !== 404) r.info.push(`OpenSSF Scorecard unavailable (${describe(scorecard)})`);
  }

  // React Native
  if (ctx.rn) {
    if (!rnDir?.ok) unknown('React Native Directory (maintenance and New Architecture gates)', rnDir ?? { status: 0 });
    else {
      const entry = rnDir.json?.[name] ?? null; // 200 with no entry: the directory does not list it (normal for pure-JS packages).
      r.facts.rn = entry ? { newArchitecture: entry.newArchitecture ?? 'unknown', expoGo: entry.expoGo === true, unmaintained: entry.unmaintained === true, hasNativeCode: entry.github?.hasNativeCode ?? null } : null;
      if (entry?.unmaintained) gate('marked unmaintained in React Native Directory');
      const native = entry?.github?.hasNativeCode;
      if (entry && native !== false) {
        if (entry.newArchitecture === false || entry.newArchitecture === 'unsupported') gate('does not support the React Native New Architecture (required on RN 0.82+)');
        else if (entry.newArchitecture !== true && entry.newArchitecture !== 'supported') review(`New Architecture support is "${entry.newArchitecture ?? 'unknown'}"; prove it on a device before relying on it`);
      }
      if (native && !entry.expoGo) caution('has native code and does not run in Expo Go: needs a development build');
    }
    const bundled = ctx.expo.modules?.[name];
    if (bundled) {
      r.facts.expoBundled = bundled;
      caution(`bundled with Expo SDK ${ctx.expo.version} as ${bundled}: install with "npx expo install ${name}" to get the SDK-matched version`);
    }
  }
  return finish();
}

function printText(results, ctx) {
  const out = [`React Native checks: ${ctx.rn ? `on (${ctx.rnReason}); Expo SDK list: ${ctx.expo.how}` : `off (${ctx.rnReason})`}`, ''];
  for (const r of results) {
    const f = r.facts;
    out.push(`${r.name}@${r.version ?? '?'}  ${r.verdict}`);
    if ('maintainers' in f) { // Reached only once the package and version were found.
      out.push(`  published: first ${f.firstPublished?.slice(0, 10) ?? 'unknown'}, this version ${f.versionPublished?.slice(0, 10) ?? 'unknown'}`);
      out.push(`  weekly downloads: ${fmt(f.weeklyDownloads)} · maintainers: ${f.maintainers ?? 'unknown'} · licence: ${f.licenses?.join(', ') || 'unknown'} · provenance: ${f.provenance === null || f.provenance === undefined ? 'unknown' : f.provenance ? 'yes' : 'no'}`);
      out.push(`  repo: ${f.repo ?? 'none'}${f.repo ? `${f.repoVerified ? ' (verified by attestation)' : ' (claimed, not verified)'} · stars ${fmt(f.stars)} · last push ${f.lastPush?.slice(0, 10) ?? 'unknown'} · scorecard ${f.scorecard ?? 'n/a'}` : ''}`);
      out.push(`  transitive deps: ${f.transitiveDeps ?? 'unknown'} · known vulnerabilities: ${f.vulnerabilities ?? 'unknown'}`);
      if (ctx.rn) out.push(`  react native: ${f.rn ? `new arch ${f.rn.newArchitecture} · expo go ${f.rn.expoGo ? 'yes' : 'no'} · native code ${f.rn.hasNativeCode ?? 'unknown'}` : f.rn === null ? 'not in React Native Directory (normal for pure-JS packages)' : 'unknown'}`);
    }
    for (const g of r.gates) out.push(`  REJECT  ${g}`);
    for (const v of r.review) out.push(`  REVIEW  ${v}`);
    for (const u of r.unknown) out.push(`  unknown ${u}`);
    for (const c of r.cautions) out.push(`  caution ${c}`);
    for (const i of r.info) out.push(`  info    ${i}`);
    out.push('');
  }
  const counts = ['REJECT', 'REVIEW', 'OK'].map((v) => `${results.filter((r) => r.verdict === v).length} ${v}`).join(', ');
  out.push(`vet-package: ${counts}. Unknown checks never count as passes.`);
  process.stdout.write(out.join('\n') + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const specs = args.filter((a) => !a.startsWith('--'));
  const unknownFlags = args.filter((a) => a.startsWith('--') && !['--json', '--rn', '--no-rn'].includes(a));
  if (unknownFlags.length > 0) fail(`unknown option(s): ${unknownFlags.join(' ')}`);
  if (specs.length === 0) fail('usage: node vet-package.mjs <name[@version]> [...] [--json] [--rn | --no-rn]');
  if (specs.length > MAX_PACKAGES) fail(`at most ${MAX_PACKAGES} packages per run`);

  const project = detectProject();
  const rn = !args.includes('--no-rn') && (args.includes('--rn') || project.isReactNative);
  const rnReason = args.includes('--no-rn') ? '--no-rn' : args.includes('--rn') ? '--rn' : project.isReactNative ? `found in ${project.source}` : 'no react-native or expo dependency found here or in apps/*, packages/*; pass --rn to force';
  const expo = rn ? await loadExpoBundled(project.expoRange) : { version: null, modules: null, how: 'n/a' };
  const ctx = { rn, rnReason, expo };
  const results = [];
  for (const spec of specs) results.push(await vet(spec, ctx)); // Sequential: keeps well inside public API rate limits.

  if (json) process.stdout.write(JSON.stringify({ reactNativeChecks: { on: rn, reason: rnReason, expo: expo.how }, results }, null, 2) + '\n');
  else printText(results, ctx);
  process.exitCode = results.some((r) => r.verdict === 'REJECT') ? 1 : results.some((r) => r.verdict === 'REVIEW') ? 3 : 0;
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
