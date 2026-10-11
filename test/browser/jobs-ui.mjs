// 申請單的畫面：學生送申請、看自己的申請；老師在「待審」核准或拒絕；核准後學生看到結果。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/jobs-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-jobsui-');
fx.cache.db.close?.();
const T = { user: 'teacher1', pass: 'tpass-1' }, K = { user: 'kid1', pass: 'kpass-2' };
let pages = [], code = 1;
const login = async (base, who, path = '/', size = { width: 1000, height: 1100 }) => {
  const p = await openPage(base + path, { ...size, settle: 2500 });
  pages.push(p);
  await p.until(`!!document.getElementById('loginUser')`);
  await p.type('#loginUser', who.user); await p.type('#loginPass', who.pass);
  await p.click('#loginGo');
  await p.wait(2500);
  return p;
};
try {
  const S = await start('ui-jobs', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });
  const s = await login(S.base, K), t = await login(S.base, T, '/admin');

  section('學生：分析新句子 → 送申請');
  await s.click('.tabs button[data-view="sentence"]');
  await s.type('#inp', 'I like tea. We eat lunch.');
  await s.click('#go');
  chk('兩句都標成「等老師核准」', await s.until(`document.querySelectorAll('#out article.sent .badge.warn').length === 2 && [...document.querySelectorAll('#out .badge.warn')].every(b => /等老師核准/.test(b.textContent))`, 8000));
  chk('提示已送出申請、有「看我的申請」', await s.evl(`/已送出申請：2 句/.test(document.getElementById('usageBar').textContent) && !!document.getElementById('goJobs')`));
  chk('沒有呼叫模型', S.calls().length === 0);
  chk('畫面上沒有任何費用', !(await s.evl(`/US\\$|\\$\\d/.test(document.getElementById('view-sentence').textContent)`)));
  await s.click('#goJobs');
  chk('「我的申請」：一張待審的，有撤回鈕，沒有費用', await s.until(`document.body.dataset.view === 'jobs' && document.querySelectorAll('#jobsList .job').length === 1 && /等待核准/.test(document.getElementById('jobsList').textContent) && !!document.querySelector('[data-job="cancel"]') && !/US\\$/.test(document.getElementById('view-jobs').textContent)`, 8000), await s.evl(`document.getElementById('jobsList').textContent.slice(0, 160)`));
  chk('分頁上的徽章：1', await s.until(`document.getElementById('jobsBadgeS').textContent === '1'`, 8000));

  section('老師：待審');
  await t.click('.tabs button[data-view="jobs"].admin-only');
  chk('「待審」有 1 張、顯示句數與預估費用', await t.until(`document.querySelectorAll('#jobsList .job').length === 1 && /2 句要請模型分析/.test(document.getElementById('jobsList').textContent) && /US\\$\\d/.test(document.getElementById('jobsList').textContent)`, 8000), await t.evl(`document.getElementById('jobsList').textContent.slice(0, 200)`));
  chk('可以看原文', await t.evl(`!!document.querySelector('.job-text pre') && /I like tea/.test(document.querySelector('.job-text pre').textContent)`));
  await t.click('[data-job="approve"]');
  chk('核准後執行完成，列在「處理過的」，顯示實際花費', await t.until(`/完成/.test(document.getElementById('jobsList').textContent) && /實際花費/.test(document.getElementById('jobsList').textContent)`, 15000) || await (async () => { await t.click('.tabs button[data-view="jobs"].admin-only'); return t.until(`/完成/.test(document.getElementById('jobsList').textContent)`, 8000); })());
  chk('模型被呼叫一次', S.calls().length === 1);

  section('學生：看到結果');
  await s.click('.tabs button[data-view="jobs"].student-only');
  chk('申請變成「完成」，有「看分析結果」', await s.until(`/完成/.test(document.getElementById('jobsList').textContent) && !!document.querySelector('[data-job="open-sentences"]')`, 8000));
  await s.click('[data-job="open-sentences"]');
  chk('按下去：2 句直接分析好、不再有申請', await s.until(`document.querySelectorAll('#out article.sent').length === 2 && !document.querySelector('#out .badge.warn')`, 8000) && S.calls().length === 1);

  section('老師拒絕、學生看到理由');
  await s.click('.tabs button[data-view="sentence"]');
  await s.type('#inp', 'Birds can fly high.');
  await s.click('#go');
  await s.until(`/已送出申請/.test(document.getElementById('usageBar').textContent)`, 8000);
  await t.click('.tabs button[data-view="jobs"].admin-only');
  await t.until(`!!document.querySelector('[data-job="reject"]')`, 8000);
  await t.type('.jnote', '這週先不加');
  await t.click('[data-job="reject"]');
  await t.until(`!document.querySelector('[data-job="reject"]')`, 8000);
  await s.click('.tabs button[data-view="jobs"].student-only');
  chk('學生看到「被拒絕」與老師的說明', await s.until(`/被拒絕/.test(document.getElementById('jobsList').textContent) && /老師的說明：這週先不加/.test(document.getElementById('jobsList').textContent)`, 8000));

  section('學生：分析並存成文章 → 送申請');
  await s.click('.tabs button[data-view="article"]'); await s.click('#arTabs button[data-ap="new"]');
  await s.type('#artName', '課文S'); await s.type('#inp', 'Dogs run fast. Cats sleep a lot.');
  await s.click('#go');
  chk('確認框：沒有費用，按鈕是「送出申請」', await s.until(`!!document.getElementById('artGo') && /送出申請/.test(document.getElementById('artGo').textContent) && !/US\\$|\\$\\d/.test(document.getElementById('artConfirm').textContent)`, 8000), await s.evl(`document.getElementById('artConfirm').textContent`));
  await s.click('#artGo');
  chk('送出後提示等老師核准', await s.until(`/已送出申請：2 句/.test(document.getElementById('usageBar').textContent)`, 8000));

  section('學生：申請新增單字表');
  await s.click('.tabs button[data-view="words"]');
  chk('單字頁有「申請新增字表」', await s.until(`getComputedStyle(document.querySelector('#wsNew .student-label')).display !== 'none' && getComputedStyle(document.querySelector('#wsNew .teacher-label')).display === 'none'`, 8000));
  await s.click('#wsNew');
  await s.type('#wsText', 'apple, 蘋果\nbanana, 香蕉');
  await s.click('#wsCreate');
  chk('送出後提示「已送出申請」，字表還沒建', await s.until(`/已送出申請（2 個字）/.test(document.getElementById('wsHint').textContent)`, 8000));
  chk('老師的待審多了一張字表申請', await t.evl(`fetch('/api/jobs?status=pending').then(r => r.json()).then(j => j.jobs.some(x => x.kind === 'wordset'))`));

  section('其他');
  chk('學生沒有 JS 錯誤', s.errors.length === 0, s.errors.join(' | '));
  chk('老師沒有 JS 錯誤', t.errors.length === 0, t.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
