import { describe, expect, it } from 'vitest';
import { matchScore, pinyinInitials } from '../src/dashboard/search/match';
import { siteSearchFor } from '../src/dashboard/search/sites';

describe('launcher matching', () => {
  it('derives pinyin initials from the zh-CN collation', () => {
    expect(pinyinInitials('工作周报')).toBe('gzzb');
    expect(pinyinInitials('知乎 - 有问题，就会有答案')).toBe('zhywtjhyda');
    expect(pinyinInitials('Augur 设计稿 v2')).toBe('augursjgv2');
  });

  it('ranks domain prefix > title prefix > word start > substring > initials', () => {
    const tab = { title: 'React Table — 文档', url: 'https://tanstack.com/table', domain: 'tanstack.com' };
    expect(matchScore('tan', tab)).toBeGreaterThan(matchScore('table', tab));
    expect(matchScore('react', tab)).toBeGreaterThan(matchScore('wd', tab));
    expect(matchScore('wd', tab)).toBeGreaterThan(0); // 文档
    expect(matchScore('nope', tab)).toBe(0);
  });

  it('requires every term, in any order', () => {
    const tab = { title: '工作周报 - 飞书文档', url: 'https://feishu.cn/docx/1', domain: 'feishu.cn' };
    expect(matchScore('zb feishu', tab)).toBeGreaterThan(0);
    expect(matchScore('zb github', tab)).toBe(0);
  });

  it('site-search keywords build the site query', () => {
    expect(siteSearchFor('GH')?.url('react table')).toBe('https://github.com/search?q=react%20table&type=repositories');
    expect(siteSearchFor('xx')).toBeUndefined();
  });
});
