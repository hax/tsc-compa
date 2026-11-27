import {
  combineChoices, readCatalog, readReports, reportHref, requestedSelection,
  resolveSelection, runHref, sameSelection, selectionOf, shareUrl, versionKey,
} from './catalog.js';

const root = new URL('./', import.meta.url);
const byId = (id) => document.getElementById(id);
const filters = byId('filters');
const chooser = Object.fromEntries(['candidate', 'version', 'reference', 'suite'].map((id) => [id, byId(id)]));
const share = byId('share');
const loadStatus = byId('load-status');
const results = byId('results');
const resultStatus = byId('result-status');
const latest = byId('latest');
const history = byId('history');
const historyList = byId('history-list');
const historyCount = byId('history-count');

let catalog;
let reports;
let choices = [];
let selection;

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

async function readJson(path) {
  const response = await fetch(new URL(path, root), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function selectOptions(select, pairs, current) {
  const options = Array.from(new Map(pairs), ([value, text]) => {
    const option = element('option', text);
    option.value = value;
    return option;
  });
  select.replaceChildren(...options);
  select.value = current;
}

function renderChooser(row) {
  const { candidate, reference, suite } = row;
  const nameChoices = choices.filter((choice) => choice.candidate.name === candidate.name);
  const versionChoices = nameChoices.filter((choice) => versionKey(choice.candidate) === versionKey(candidate));
  const referenceChoices = versionChoices.filter((choice) => choice.reference.id === reference.id);
  const versions = new Map(nameChoices.map((choice) => [versionKey(choice.candidate), choice.candidate]));
  const versionLabels = Array.from(versions, ([key, option]) => [key, Array.from(versions.values()).some((other) =>
    other.version === option.version && other.id !== option.id) ? `${option.version} (${option.id})` : option.version]);
  selectOptions(chooser.candidate, choices.map((choice) => [choice.candidate.name, choice.candidate.name]), candidate.name);
  selectOptions(chooser.version, versionLabels, versionKey(candidate));
  selectOptions(chooser.reference, versionChoices.map((choice) => [choice.reference.id, choice.reference.label]), reference.id);
  selectOptions(chooser.suite, referenceChoices.map((choice) => [choice.suite.id, choice.suite.label]), suite.id);
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
function reportTime(report) {
  const timestamp = element('time', `${dateFormat.format(Date.parse(report.generatedAt))} UTC`);
  timestamp.dateTime = report.generatedAt;
  return timestamp;
}

function renderLatest(report) {
  const reportLink = link('打开兼容性报告', reportHref(report.reportPath, root));
  reportLink.className = 'report-main';
  const provenance = element('dl');
  provenance.className = 'provenance';
  const fields = [
    ['候选', `${report.candidate.name} ${report.candidate.version}`],
    ['参考', report.reference.label],
    ['测试集', report.suite.label],
    ['生成时间', reportTime(report)],
    ['运行来源', link('GitHub Actions 记录', runHref(report.runUrl))],
    ['报告 ID', element('code', report.id)],
  ];
  fields.at(-1)[1].className = 'report-id';
  for (const [label, value] of fields) {
    const entry = element('dd');
    entry.append(value);
    provenance.append(element('dt', label), entry);
  }
  latest.replaceChildren(reportLink, provenance);
}

function renderResults(row) {
  history.open = false;
  history.hidden = true;
  historyList.replaceChildren();
  latest.hidden = true;
  latest.replaceChildren();
  results.hidden = false;
  if (!reports) {
    resultStatus.textContent = '报告索引暂不可用，无法确认这个组合是否已经运行。';
    return;
  }
  const matching = reports.filter((report) => sameSelection(row, report));
  if (!matching.length) {
    resultStatus.textContent = '尚无公开报告：这个组合可能尚未运行，或运行结果尚未发布。';
    return;
  }
  resultStatus.textContent = catalog && !catalog.some((choice) => sameSelection(row, choice))
    ? '历史组合：不在当前评测目录中。以下是该组合最近发布的报告。'
    : '以下是该组合最近发布的报告。';
  renderLatest(matching[0]);
  latest.hidden = false;
  if (matching.length < 2) return;
  historyCount.textContent = `（${matching.length - 1} 份）`;
  for (const report of matching.slice(1)) {
    const item = element('li');
    const reportLink = link('报告', reportHref(report.reportPath, root));
    reportLink.setAttribute('aria-label', `查看报告 ${report.id}`);
    const runLink = link('Actions 记录', runHref(report.runUrl));
    runLink.setAttribute('aria-label', `查看报告 ${report.id} 的 GitHub Actions 记录`);
    item.append(reportTime(report), ' · ', reportLink, ' · ', runLink);
    historyList.append(item);
  }
  history.hidden = false;
}

function render(row) {
  if (!row) return;
  selection = row;
  renderChooser(row);
  share.href = shareUrl(location.href, row).href;
  filters.hidden = false;
  share.hidden = false;
  renderResults(row);
}

function selectionFromLocation() {
  return resolveSelection(choices, requestedSelection(new URL(location.href)), reports?.[0] && selectionOf(reports[0]));
}

function loadMessage(adjusted) {
  return [
    !catalog && '当前评测目录不可读。若能读取报告索引，下方仍会列出已发布的组合。',
    !reports && '报告索引无法读取，请稍后刷新页面。',
    adjusted && '链接中的部分条件已不可用，已显示可选的替代组合。',
  ].filter(Boolean).join(' ');
}

for (const [field, select] of Object.entries(chooser)) {
  select.addEventListener('change', () => {
    const name = chooser.candidate.value;
    const next = choices.filter((row) => row.candidate.name === name &&
      (field === 'candidate' || versionKey(row.candidate) === chooser.version.value) &&
      (field === 'candidate' || field === 'version' || row.reference.id === chooser.reference.value) &&
      (field !== 'suite' || row.suite.id === chooser.suite.value));
    const preferred = selectionOf(selection);
    for (const key of ['candidate', 'version', 'reference', 'suite']) {
      const narrower = next.filter((row) => selectionOf(row)[key] === preferred[key]);
      if (narrower.length) next.splice(0, next.length, ...narrower);
    }
    if (!next.length) return;
    render(next[0]);
    window.history.pushState(null, '', share.href);
    loadStatus.textContent = loadMessage(false);
  });
}

window.addEventListener('popstate', () => {
  const { combination, adjusted } = selectionFromLocation();
  render(combination);
  loadStatus.textContent = loadMessage(adjusted);
});

async function start() {
  const [catalogResult, indexResult] = await Promise.allSettled([
    readJson('./reports/catalog.json').then(readCatalog),
    readJson('./reports/index.json').then((value) => readReports(value, root)),
  ]);
  if (catalogResult.status === 'fulfilled') catalog = catalogResult.value;
  if (indexResult.status === 'fulfilled') reports = indexResult.value;
  choices = combineChoices(catalog ?? [], reports ?? []);
  if (!choices.length) {
    loadStatus.textContent = loadMessage(false) || '目前没有可选组合或已发布报告。';
    return;
  }
  const { combination, adjusted } = selectionFromLocation();
  render(combination);
  loadStatus.textContent = loadMessage(adjusted);
}

start();
