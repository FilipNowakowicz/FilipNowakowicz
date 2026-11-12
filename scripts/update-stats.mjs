import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const login = 'FilipNowakowicz';
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');
const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1;
const today = now.toISOString().slice(0, 10);
const fmt = n => n.toLocaleString('en-GB');

async function query(query) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  if (!response.ok || result.errors) throw new Error(JSON.stringify(result.errors ?? result));
  return result.data;
}

const profile = (await query(`{ user(login:"${login}") { createdAt followers { totalCount } } }`)).user;
const firstYear = new Date(profile.createdAt).getUTCFullYear();
let stars = 0, forks = 0, cursor = null;
do {
  const after = cursor ? `,after:${JSON.stringify(cursor)}` : '';
  const repos = (await query(`{ user(login:"${login}") {
    repositories(first:100,ownerAffiliations:OWNER,privacy:PUBLIC${after}) {
      nodes { stargazerCount forkCount }
      pageInfo { hasNextPage endCursor }
    }
  } }`)).user.repositories;
  for (const repo of repos.nodes) { stars += repo.stargazerCount; forks += repo.forkCount; }
  cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
} while (cursor);

// Public metrics stay separate from anonymous private contribution counts.
const fields = [];
function collection(alias, from, to) {
  return `${alias}: contributionsCollection(from:"${from}T00:00:00Z",to:"${to}T23:59:59Z") {
    restrictedContributionsCount
    commitContributionsByRepository(maxRepositories:100) {
      repository { isPrivate } contributions { totalCount }
    }
  }`;
}
for (let y = firstYear; y <= year; y++) {
  fields.push(collection(`y${y}`, `${y}-01-01`, y === year ? today : `${y}-12-31`));
}
const searches = [
  'prs: search(query:"author:'+login+' is:pr is:public",type:ISSUE) { issueCount }',
  'merged: search(query:"author:'+login+' is:pr is:merged is:public",type:ISSUE) { issueCount }',
];
for (let m = 1; m <= month; m++) {
  const mm = String(m).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const to = m === month ? today : new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
  fields.push(collection(`m${m}`, from, to));
  for (const kind of ['pr', 'issue']) searches.push(`${kind}${m}: search(query:"author:${login} is:${kind} is:public created:${from}..${to}",type:ISSUE) { issueCount }`);
}
const data = await query(`{ user(login:"${login}") { ${fields.join('\n')} } ${searches.join('\n')} }`);
function commits(collection) {
  const repos = collection.commitContributionsByRepository;
  // Avoid silently publishing a partial count if the API cap is reached.
  if (repos.length >= 100) throw new Error('Contribution repository limit reached');
  return repos.filter(r => !r.repository.isPrivate).reduce((sum, r) => sum + r.contributions.totalCount, 0);
}
let lifetimeCommits = 0;
let lifetimePrivate = 0;
for (let y = firstYear; y <= year; y++) lifetimePrivate += data.user[`y${y}`].restrictedContributionsCount;
for (let y = firstYear; y <= year; y++) lifetimeCommits += commits(data.user[`y${y}`]);
const stats = [
  ['Public commits', lifetimeCommits], ['Public PRs opened', data.prs.issueCount],
  ['Public PRs merged', data.merged.issueCount], ['Stars received', stars],
  ['Forks received', forks], ['Followers', profile.followers.totalCount],
  ['Private contributions', lifetimePrivate],
];
const series = [
  { name: 'Public commits', color: '#83bff0', values: [] },
  { name: 'Public PRs opened', color: '#dcacfa', values: [] },
  { name: 'Public issues opened', color: '#f2c078', values: [] },
  { name: 'Private contributions', color: '#79d2b0', values: [] },
];
for (let m = 1; m <= month; m++) {
  const values = [commits(data.user[`m${m}`]), data[`pr${m}`].issueCount, data[`issue${m}`].issueCount, data.user[`m${m}`].restrictedContributionsCount];
  series.forEach((s, i) => s.values.push(values[i] + (s.values.at(-1) ?? 0)));
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const t = (x, y, s, size = 13, c = '#9daab8', extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${c}" ${extra}>${escape(s)}</text>`;
const fg = '#e6edf3', muted = '#9daab8';
const peak = Math.max(1, ...series.flatMap(s => s.values));
// Round the axis up to a readable multiple of 1, 2 or 5.
const scale = 10 ** Math.floor(Math.log10(peak / 4));
const tick = [1, 2, 5, 10].map(n => n * scale).find(n => n >= peak / 4);
const max = tick * 4, x0 = 70, x1 = 870, top = 213, base = 443, height = base - top;
let body = t(30, 43, 'Filip Nowakowicz', 24, fg, 'font-weight="600"') + t(930, 41, 'GitHub', 14, muted, 'text-anchor="end"');
stats.forEach(([label, value], i) => {
  body += t(30 + i * 129, 98, fmt(value), 27, fg, 'font-weight="600"') + t(30 + i * 129, 124, label, 10.5);
});
body += t(30, 156, 'Lifetime totals · Private activity combines contribution types', 11) + t(30, 190, `Contributions accumulated in ${year}`, 16, fg);
for (let i = 0; i <= 4; i++) {
  const y = base - i * height / 4;
  body += `<path d="M${x0} ${y}H${x1}" stroke="#29333f"/>` + t(x0 - 12, y + 4, fmt(max * i / 4), 11, muted, 'text-anchor="end"');
}
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const x = i => month === 1 ? x0 : x0 + i * (x1 - x0) / (month - 1);
for (let i = 0; i < month; i++) body += t(x(i), base + 25, months[i] + (i === month - 1 ? '*' : ''), 12, muted, 'text-anchor="middle"');
// Separate endpoint labels when series finish close together.
const endpoints = series.map((s, i) => ({ i, y: base - s.values.at(-1) / max * height })).sort((a, b) => a.y - b.y);
for (let i = 1; i < endpoints.length; i++) endpoints[i].y = Math.max(endpoints[i].y, endpoints[i - 1].y + 16);
if (endpoints.at(-1).y > base) {
  const shift = endpoints.at(-1).y - base;
  endpoints.forEach(p => { p.y -= shift; });
}
series.forEach((s, j) => {
  const points = s.values.map((v, i) => [x(i), base - v / max * height]);
  body += `<polyline points="${points.map(p => p.join(',')).join(' ')}" fill="none" stroke="${s.color}" stroke-width="3" stroke-linejoin="round"/>`;
  points.forEach(([px, py], i) => {
    body += `<circle cx="${px}" cy="${py}" r="3" fill="${s.color}"><title>${months[i]}: ${fmt(s.values[i])} ${s.name.toLowerCase()}</title></circle>`;
  });
  body += t(points.at(-1)[0] + 12, endpoints.find(p => p.i === j).y + 4, fmt(s.values.at(-1)), 12, s.color);
  body += `<path d="M${30 + j * 225} 501h24" stroke="${s.color}" stroke-width="3"/>` + t(64 + j * 225, 506, s.name, 13);
});
body += t(30, 540, `Public activity + anonymous private contributions · *Current month through ${today}`, 12);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560" role="img"><title>GitHub statistics including anonymous private contributions in ${year}</title><desc>${stats.map(([label, value]) => `${label}: ${fmt(value)}`).join('; ')}. Graph: public commit contributions, PRs opened, issues opened and anonymous private contributions accumulated since January. Private contributions combine activity types; no repository details are included.</desc><rect x=".5" y=".5" width="959" height="559" rx="12" fill="#0d1117" stroke="#30363d"/><g font-family="Arial, sans-serif">${body}</g></svg>\n`;
await fs.mkdir('assets', { recursive: true });
const filename = `github-stats-${createHash('sha256').update(svg).digest('hex').slice(0, 12)}.svg`;
await fs.writeFile(`assets/${filename}`, svg);
await fs.writeFile('README.md', `[![GitHub statistics including anonymous private contributions](assets/${filename})](https://github.com/${login}?tab=repositories)\n`);
for (const old of await fs.readdir('assets')) {
  if (/^github-stats(?:-[a-f0-9]{12})?\.svg$/.test(old) && old !== filename) await fs.unlink(`assets/${old}`);
}
console.log(`Updated public and anonymous private stats for ${today}`);
