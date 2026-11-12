import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const login = 'FilipNowakowicz';
const token = process.env.PROFILE_STATS_TOKEN;
if (!token) throw new Error('PROFILE_STATS_TOKEN with private repository read access is required');
const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1;
const today = now.toISOString().slice(0, 10);
const fmt = n => n.toLocaleString('en-GB');

async function query(query) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const raw = await response.text();
      if (response.status >= 500 || !raw) throw new Error(`GitHub temporary response: HTTP ${response.status}`);
      const result = JSON.parse(raw);
      if (!response.ok || result.errors) throw new Error(JSON.stringify(result.errors ?? result));
      return result.data;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

const identity = await query(`{ viewer { login } user(login:"${login}") { id createdAt followers { totalCount } } }`);
if (identity.viewer.login !== login) throw new Error('The statistics token must belong to the profile owner');
const profile = identity.user;
const firstYear = new Date(profile.createdAt).getUTCFullYear();
let stars = 0, forks = 0, cursor = null;
do {
  const after = cursor ? `,after:${JSON.stringify(cursor)}` : '';
  const repos = (await query(`{ user(login:"${login}") {
    repositories(first:100,ownerAffiliations:OWNER${after}) {
      nodes { stargazerCount forkCount }
      pageInfo { hasNextPage endCursor }
    }
  } }`)).user.repositories;
  for (const repo of repos.nodes) { stars += repo.stargazerCount; forks += repo.forkCount; }
  cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
} while (cursor);

// Query private default-branch histories directly: contribution collections can
// return anonymous private activity even when this credential can read the repo.
const privateRepos = [];
cursor = null;
do {
  const after = cursor ? `,after:${JSON.stringify(cursor)}` : '';
  const repos = (await query(`{ viewer {
    repositories(first:100,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],privacy:PRIVATE${after}) {
      nodes { id isFork } pageInfo { hasNextPage endCursor }
    }
  } }`)).viewer.repositories;
  privateRepos.push(...repos.nodes.filter(r => !r.isFork));
  cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
} while (cursor);
let privateCommits = 0;
const privateMonthlyCommits = Array(month).fill(0);
for (const repo of privateRepos) {
  let commitCursor = null;
  do {
    const after = commitCursor ? `,after:${JSON.stringify(commitCursor)}` : '';
    const branch = (await query(`{ node(id:${JSON.stringify(repo.id)}) { ... on Repository {
      defaultBranchRef { target { ... on Commit {
        history(first:100,author:{id:${JSON.stringify(profile.id)}}${after}) {
          nodes { authoredDate } pageInfo { hasNextPage endCursor }
        }
      } } }
    } } }`)).node.defaultBranchRef;
    if (!branch) break;
    const history = branch.target.history;
    if (!history) throw new Error('Private default branch is not a commit');
    for (const commit of history.nodes) {
      const date = new Date(commit.authoredDate);
      if (date > now) continue;
      privateCommits++;
      if (date.getUTCFullYear() === year) privateMonthlyCommits[date.getUTCMonth()]++;
    }
    commitCursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (commitCursor);
}

const fields = [];
function collection(alias, from, to) {
  return `${alias}: contributionsCollection(from:"${from}T00:00:00Z",to:"${to}T23:59:59Z") {
    commitContributionsByRepository(maxRepositories:100) {
      repository { isPrivate } contributions { totalCount }
    }
  }`;
}
for (let y = firstYear; y <= year; y++) {
  fields.push(collection(`y${y}`, `${y}-01-01`, y === year ? today : `${y}-12-31`));
}
const searches = [
  'prs: search(query:"author:'+login+' is:pr",type:ISSUE) { issueCount }',
  'merged: search(query:"author:'+login+' is:pr is:merged",type:ISSUE) { issueCount }',
];
for (let m = 1; m <= month; m++) {
  const mm = String(m).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const to = m === month ? today : new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
  fields.push(collection(`m${m}`, from, to));
  for (const kind of ['pr', 'issue']) searches.push(`${kind}${m}: search(query:"author:${login} is:${kind} created:${from}..${to}",type:ISSUE) { issueCount }`);
}
const data = await query(`{ user(login:"${login}") { ${fields.join('\n')} } ${searches.join('\n')} }`);
function commits(collection) {
  const repos = collection.commitContributionsByRepository;
  // Avoid silently publishing a partial count if the API cap is reached.
  if (repos.length >= 100) throw new Error('Contribution repository limit reached');
  return repos.filter(r => !r.repository.isPrivate).reduce((sum, r) => sum + r.contributions.totalCount, 0);
}
let lifetimeCommits = privateCommits;
for (let y = firstYear; y <= year; y++) lifetimeCommits += commits(data.user[`y${y}`]);
const stats = [
  ['Commits', lifetimeCommits], ['PRs opened', data.prs.issueCount],
  ['PRs merged', data.merged.issueCount], ['Stars received', stars],
  ['Forks received', forks], ['Followers', profile.followers.totalCount],
];
const series = [
  { name: 'Commits', color: '#83bff0', values: [] },
  { name: 'PRs opened', color: '#dcacfa', values: [] },
  { name: 'Issues opened', color: '#f2c078', values: [] },
];
for (let m = 1; m <= month; m++) {
  const values = [commits(data.user[`m${m}`]) + privateMonthlyCommits[m - 1], data[`pr${m}`].issueCount, data[`issue${m}`].issueCount];
  series.forEach((s, i) => s.values.push(values[i] + (s.values.at(-1) ?? 0)));
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const t = (x, y, s, size = 13, c = '#9daab8', extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${c}" ${extra}>${escape(s)}</text>`;
const fg = '#e6edf3', muted = '#9daab8';
const peak = Math.max(1, ...series.flatMap(s => s.values));
// Aim for five readable intervals, rounding the ceiling only one tick above
// the data instead of forcing four intervals and leaving excessive headroom.
const scale = 10 ** Math.floor(Math.log10(peak / 5));
const tick = Math.max(1, [1, 2, 5, 10].map(n => n * scale).find(n => n >= peak / 5));
const intervals = Math.ceil(peak / tick);
const max = tick * intervals, x0 = 70, x1 = 870, top = 213, base = 443, height = base - top;
let body = t(30, 43, 'Filip Nowakowicz', 24, fg, 'font-weight="600"');
stats.forEach(([label, value], i) => {
  body += t(30 + i * 153, 98, fmt(value), 30, fg, 'font-weight="600"') + t(30 + i * 153, 124, label, 12);
});
body += t(30, 174, `Contributions accumulated in ${year}`, 16, fg);
for (let i = 0; i <= intervals; i++) {
  const y = base - i * height / intervals;
  body += `<path d="M${x0} ${y}H${x1}" stroke="#29333f"/>` + t(x0 - 12, y + 4, fmt(tick * i), 11, muted, 'text-anchor="end"');
}
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const x = i => month === 1 ? x0 : x0 + i * (x1 - x0) / (month - 1);
for (let i = 0; i < month; i++) body += t(x(i), base + 25, months[i], 12, muted, 'text-anchor="middle"');
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
  body += `<path d="M${30 + j * 280} 501h24" stroke="${s.color}" stroke-width="3"/>` + t(64 + j * 280, 506, s.name, 13);
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="530" viewBox="0 0 960 530" role="img"><title>GitHub statistics and cumulative activity in ${year}</title><desc>${stats.map(([label, value]) => `${label}: ${fmt(value)}`).join('; ')}. Public and accessible private activity combined. Commits include public contribution credits and authored commits on private non-fork default branches. Counters cover all years; graph accumulates monthly since January through ${today}. Current month is partial. No private repository details are included.</desc><rect x=".5" y=".5" width="959" height="529" rx="12" fill="#0d1117" stroke="#30363d"/><g font-family="Arial, sans-serif">${body}</g></svg>\n`;
await fs.mkdir('assets', { recursive: true });
const filename = `github-stats-${createHash('sha256').update(svg).digest('hex').slice(0, 12)}.svg`;
await fs.writeFile(`assets/${filename}`, svg);
await fs.writeFile('README.md', `[![GitHub statistics](assets/${filename})](https://github.com/${login}?tab=repositories)\n`);
for (const old of await fs.readdir('assets')) {
  if (/^github-stats(?:-[a-f0-9]{12})?\.svg$/.test(old) && old !== filename) await fs.unlink(`assets/${old}`);
}
console.log(`Updated combined statistics for ${today}: ${JSON.stringify(stats)}`);
