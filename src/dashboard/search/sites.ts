// Site search: a short keyword + Tab (or space) searches that site directly,
// skipping the search engine's results page. "gh react table" → GitHub's
// search for "react table".

export interface SiteSearch {
  key: string;
  name: string;
  domain: string;
  url: (q: string) => string;
}

const e = encodeURIComponent;

export const SITE_SEARCHES: SiteSearch[] = [
  { key: 'gh', name: 'GitHub', domain: 'github.com', url: (q) => `https://github.com/search?q=${e(q)}&type=repositories` },
  { key: 'so', name: 'Stack Overflow', domain: 'stackoverflow.com', url: (q) => `https://stackoverflow.com/search?q=${e(q)}` },
  { key: 'npm', name: 'npm', domain: 'npmjs.com', url: (q) => `https://www.npmjs.com/search?q=${e(q)}` },
  { key: 'mdn', name: 'MDN', domain: 'developer.mozilla.org', url: (q) => `https://developer.mozilla.org/search?q=${e(q)}` },
  { key: 'yt', name: 'YouTube', domain: 'youtube.com', url: (q) => `https://www.youtube.com/results?search_query=${e(q)}` },
  { key: 'bili', name: '哔哩哔哩', domain: 'bilibili.com', url: (q) => `https://search.bilibili.com/all?keyword=${e(q)}` },
  { key: 'zh', name: '知乎', domain: 'zhihu.com', url: (q) => `https://www.zhihu.com/search?type=content&q=${e(q)}` },
  { key: 'wiki', name: 'Wikipedia', domain: 'wikipedia.org', url: (q) => `https://en.wikipedia.org/w/index.php?search=${e(q)}` },
  { key: 'bd', name: '百度', domain: 'baidu.com', url: (q) => `https://www.baidu.com/s?wd=${e(q)}` },
];

export function siteSearchFor(key: string): SiteSearch | undefined {
  const k = key.toLowerCase();
  return SITE_SEARCHES.find((s) => s.key === k);
}
