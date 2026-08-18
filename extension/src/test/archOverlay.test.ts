import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyArchOverlay, ARCH_DEFAULT } from '../archOverlay';

test('common yoksa config aynen döner (geriye dönük uyumlu)', () => {
  const cfg = { timers: { mode: 'array', root: 'g_timers', count: '4', fields: [{ label: 'ID', expr: 'id' }] } };
  assert.deepEqual(applyArchOverlay(cfg, 'ppc'), cfg);
  assert.deepEqual(applyArchOverlay(cfg), cfg);           // arch verilmese de
});

test('bölüm seviyesi: common + aktif arch birleşir, diğer arch düşer', () => {
  const cfg = {
    cs: {
      common: { mode: 'walk', while: '(${expr})!=0' },
      ppc: { start: 'a', next: 'p' },
      x86: { start: 'b', next: 'x' },
    },
  };
  assert.deepEqual(applyArchOverlay(cfg, 'ppc').cs, { mode: 'walk', while: '(${expr})!=0', start: 'a', next: 'p' });
  assert.deepEqual(applyArchOverlay(cfg, 'x86').cs, { mode: 'walk', while: '(${expr})!=0', start: 'b', next: 'x' });
});

test('varsayılan (common): sadece taban, tüm arch blokları düşer', () => {
  const cfg = { cs: { common: { mode: 'walk' }, ppc: { start: 'a' }, x86: { start: 'b' } } };
  assert.deepEqual(applyArchOverlay(cfg, ARCH_DEFAULT).cs, { mode: 'walk' });
  assert.deepEqual(applyArchOverlay(cfg, '').cs, { mode: 'walk' });     // boş -> common
  assert.deepEqual(applyArchOverlay(cfg, '  ').cs, { mode: 'walk' });   // whitespace -> common
});

test('bilinmeyen arch: o blok yok -> sadece common tabanı', () => {
  const cfg = { cs: { common: { mode: 'walk', max: 8 }, ppc: { start: 'a' } } };
  assert.deepEqual(applyArchOverlay(cfg, 'sparc').cs, { mode: 'walk', max: 8 });
});

test('field seviyesi: bir field içinde common + arch', () => {
  const cfg = {
    cs: {
      common: {
        mode: 'walk',
        fields: [
          { label: 'SP', expr: '${expr}', base: 'hex' },
          { common: { label: 'PC', symbol: true, base: 'hex' }, ppc: { expr: 'P' }, x86: { expr: 'X' } },
        ],
      },
    },
  };
  const ppc = applyArchOverlay(cfg, 'ppc').cs;
  assert.deepEqual(ppc.fields[0], { label: 'SP', expr: '${expr}', base: 'hex' });
  assert.deepEqual(ppc.fields[1], { label: 'PC', symbol: true, base: 'hex', expr: 'P' });
  assert.equal(applyArchOverlay(cfg, 'x86').cs.fields[1].expr, 'X');
});

test('dizi birleştirilmez, DEĞİŞTİRİLİR (arch fields tüm diziyi ezer)', () => {
  const cfg = {
    cs: {
      common: { mode: 'array', fields: [{ label: 'A', expr: 'a' }, { label: 'B', expr: 'b' }] },
      ppc: { fields: [{ label: 'A', expr: 'a' }] },
    },
  };
  assert.equal(applyArchOverlay(cfg, 'ppc').cs.fields.length, 1);
  assert.equal(applyArchOverlay(cfg, 'common').cs.fields.length, 2);
});

test('derin birleştirme: iç içe nesneler (bar) key bazında birleşir', () => {
  const cfg = {
    t: {
      common: { fields: [{ label: 'S', expr: 'used', bar: { max: 'size', warn: 75, crit: 90 } }] },
    },
  };
  // field seviyesinde arch override ile bar.warn değişsin
  const cfg2 = {
    t: {
      common: {
        mode: 'array',
        fields: [{ common: { label: 'S', expr: 'used', bar: { max: 'size', warn: 75, crit: 90 } }, ppc: { bar: { warn: 60 } } }],
      },
    },
  };
  const f = applyArchOverlay(cfg2, 'ppc').t.fields[0];
  assert.deepEqual(f.bar, { max: 'size', warn: 60, crit: 90 });   // max/crit korundu, warn ezildi
  assert.ok(applyArchOverlay(cfg, 'ppc'));                        // smoke
});

test("'//' yorum anahtarları korunur", () => {
  const cfg = { '//': 'başlık', '//cs': 'not', cs: { common: { mode: 'walk' }, ppc: { start: 'a' } } };
  const out = applyArchOverlay(cfg, 'ppc');
  assert.equal(out['//'], 'başlık');
  assert.equal(out['//cs'], 'not');
});

test('karışık: bazı bölümler common taşır, bazıları taşımaz', () => {
  const cfg = {
    cs: { common: { mode: 'walk' }, ppc: { start: 'a' } },
    timers: { mode: 'array', root: 'g_timers', fields: [{ label: 'ID', expr: 'id' }] },
  };
  const out = applyArchOverlay(cfg, 'ppc');
  assert.deepEqual(out.cs, { mode: 'walk', start: 'a' });
  assert.deepEqual(out.timers, cfg.timers);   // dokunulmadı
});

test('girdi mutasyona uğratılmaz (saf fonksiyon)', () => {
  const cfg = { cs: { common: { mode: 'walk' }, ppc: { start: 'a' } } };
  const snapshot = JSON.stringify(cfg);
  applyArchOverlay(cfg, 'ppc');
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('gerçekçi callstack: ppc/x86 tam senaryo', () => {
  const cfg = {
    callstack: {
      common: {
        mode: 'walk', selectedFrom: 'threads', max: 32, while: '(${expr})!=0',
        fields: [
          { label: 'SP', expr: '${expr}', base: 'hex' },
          { common: { label: 'PC', symbol: true, base: 'hex' },
            ppc: { expr: '*(unsigned int*)((*(unsigned int*)(${expr}))+4)' },
            x86: { expr: '*(unsigned long*)((${expr})+8)' } },
        ],
      },
      ppc: { start: '(unsigned int)(${selected}->sp)', next: '*(unsigned int*)(${expr})' },
      x86: { start: '(unsigned long)(${selected}->sp)', next: '*(unsigned long*)(${expr})' },
    },
  };
  const p = applyArchOverlay(cfg, 'ppc').callstack;
  assert.equal(p.mode, 'walk');
  assert.equal(p.next, '*(unsigned int*)(${expr})');
  assert.match(p.fields[1].expr, /unsigned int/);
  assert.equal(p.fields[1].symbol, true);
  const x = applyArchOverlay(cfg, 'x86').callstack;
  assert.match(x.fields[1].expr, /unsigned long/);
  assert.ok(!('ppc' in x) && !('x86' in x));   // arch kardeşleri sızmadı
});
