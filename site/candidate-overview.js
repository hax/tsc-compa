import { reportHref, selectionOf } from './catalog.js';

// The index has already been validated and sorted by readReports. Do not fall
// back to a sample, another reference, or another version of the same family.
export function latestFullReport(reports, candidateId, version, referenceId) {
  return reports.find((report) => {
    const selection = selectionOf(report);
    return selection.candidate === candidateId && selection.version === version &&
      selection.reference === referenceId && selection.suite === 'full';
  });
}

export function compatibilityCounts(report) {
  const { compatibility, skipped, executionFailures } = report.summary ?? {};
  const { pass, fail, unknown } = compatibility ?? {};
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  if (![pass, fail, skipped, unknown].every(valid)) return null;
  if (executionFailures === undefined) return { pass, fail, skipped, unknown };
  const { crash, timeout } = executionFailures ?? {};
  if (![crash, timeout].every(valid) || crash + timeout > fail) return null;
  return { pass, fail, skipped, unknown, crash, timeout };
}

export function formatCompatibilityCounts(counts) {
  if (!counts) return '兼容性计数暂不可用';
  const count = (name) => numberFormat.format(counts[name]);
  const execution = counts.crash || counts.timeout ? `（含崩溃 ${count('crash')}、超时 ${count('timeout')}）` : '';
  const unknown = counts.unknown ? ` / 无法确认 ${count('unknown')}` : '';
  return `兼容通过 ${count('pass')} / 不兼容 ${count('fail')}${execution} / 跳过 ${count('skipped')}${unknown}`;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}

function link(text, href) {
  const anchor = element('a', text);
  anchor.href = href;
  return anchor;
}

const shanghaiDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Shanghai' });
const shanghaiTime = new Intl.DateTimeFormat('sv-SE', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai',
});
export function displayDate(timestamp) {
  return shanghaiDate.format(Date.parse(timestamp));
}

function time(timestamp, exact = false) {
  const node = element('time', exact ? `${shanghaiTime.format(Date.parse(timestamp))} UTC+8` : displayDate(timestamp));
  node.title = timestamp;
  node.dateTime = timestamp;
  return node;
}

const repoUrl = (repo) => `https://github.com/${repo}`;
const commitLink = (repo, sha) => link(sha.slice(0, 7), `${repoUrl(repo)}/commit/${sha}`);
const numberFormat = new Intl.NumberFormat('zh-CN');

function dates(repo, { npm, release }) {
  const rows = element('dl');
  rows.className = 'candidate-dates';
  function add(label, ...value) {
    const detail = element('dd');
    detail.append(...value);
    rows.append(element('dt', label), detail);
  }
  if (npm) {
    add('npm 发布', link(`${npm.package}@${npm.version}`, `https://www.npmjs.com/package/${npm.package}/v/${npm.version}`),
      ' · ', time(npm.publishedAt), ...(npm.gitHead ? [' · 源码 ', commitLink(repo, npm.gitHead)] : []));
    if (npm.slsaCommit) {
      const attestation = `https://registry.npmjs.org/-/npm/v1/attestations/${npm.package}@${npm.version}`;
      add('npm SLSA 记录的源码提交', commitLink(repo, npm.slsaCommit), ' · ', link('构建来源证明', attestation));
    }
  }
  if (release) {
    const { tag, publishedAt, taggerDate, commit, commitDate } = release;
    add('GitHub Release 发布', link(tag, `${repoUrl(repo)}/releases/tag/${tag}`), ' · ', time(publishedAt));
    const tagLink = link(tag, `${repoUrl(repo)}/tree/${tag}`);
    if (taggerDate) add('Git 标签时间', tagLink, ' · ', time(taggerDate));
    else add('Git 标签', tagLink, '（轻量标签，无独立时间）');
    add('标签指向的提交', commitLink(repo, commit), ' · ', time(commitDate));
  }
  return rows;
}

function headLine(repo, head) {
  const line = element('p');
  line.className = 'note candidate-head';
  line.append(`默认分支 ${head.branch} 的 HEAD 提交时间：`, commitLink(repo, head.sha), ' · ', time(head.committedAt));
  return line;
}

function reportLine(report, candidateName, version, root, indexAvailable) {
  const line = element('p');
  line.className = 'candidate-result';
  if (!report) {
    line.textContent = indexAvailable ? '尚无此组合的公开全量报告。' : '报告索引暂不可用。';
    return line;
  }
  const fullLink = link('全量报告', reportHref(report.reportPath, root));
  fullLink.setAttribute('aria-label', `查看 ${candidateName} ${version} 全量报告`);
  line.append(fullLink, ` · ${formatCompatibilityCounts(compatibilityCounts(report))}`);
  return line;
}

export function renderCandidateOverview(snapshot, reports, root) {
  if (snapshot.schemaVersion !== 1) throw new Error('Invalid candidate overview snapshot');
  const grid = element('div');
  grid.className = 'candidate-grid';
  for (const { id, name, repo, head, versions, internalSmoke } of snapshot.families) {
    const family = element('article');
    family.className = 'candidate-family';
    const title = element('h3');
    title.append(link(name, repoUrl(repo)));
    family.append(title, headLine(repo, head));
    if (internalSmoke === head.sha) {
      const note = element('p', '此提交仅用于内部冒烟；公开全量报告使用下方发行版。');
      note.className = 'note';
      family.append(note);
    }
    for (const version of versions) {
      const row = element('div');
      row.className = 'candidate-version';
      const report = latestFullReport(reports ?? [], id, version.version, snapshot.reference.id);
      row.append(element('h4', version.version), dates(repo, version),
        reportLine(report, name, version.version, root, Boolean(reports)));
      family.append(row);
    }
    grid.append(family);
  }

  const { name, repo, head, smoke, release, issue } = snapshot.internal;
  const internal = element('article');
  internal.className = 'candidate-internal';
  const heading = element('h3');
  heading.append(link(name, repoUrl(repo)), ' · 仅内部验证');
  const smokeLine = element('p');
  smokeLine.append('内部冒烟使用源码提交 ', commitLink(repo, smoke.sha), '（提交时间：', time(smoke.committedAt), '）。');
  const blocked = element('p');
  blocked.append(`正式发行 ${release.tag} 的全量预演出现崩溃和超时，未生成公开报告。`,
    link(`查看阻断问题 #${issue}`, `https://github.com/hax/tsc-compa/issues/${issue}`), '。');
  internal.append(heading, headLine(repo, head), smokeLine, blocked, dates(repo, { release }));

  const asOf = element('p');
  asOf.className = 'note';
  asOf.append('上游资料核对截至 ', time(snapshot.asOf, true), '。下列日期按 Asia/Shanghai（UTC+8）显示。默认分支 HEAD 未作为公开全量评测的候选运行。');
  const scope = element('p');
  scope.className = 'note';
  const versions = snapshot.families.reduce((total, family) => total + family.versions.length, 0);
  scope.append(`${snapshot.families.length} 个家族、${versions} 个候选配置。下方计数来自各配置最近发布的全量报告，参考为 `,
    link(snapshot.reference.label, `${repoUrl(snapshot.reference.repo)}/commit/${snapshot.reference.commit}`),
    '。跳过和候选执行失败的配置不参与诊断比较。');
  return [scope, asOf, grid, internal];
}
