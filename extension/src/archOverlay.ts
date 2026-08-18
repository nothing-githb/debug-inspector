// archOverlay.ts — arch (mimari) overlay çözümü.
//
// BU DOSYA vscode'a BAĞIMLI DEĞİLDİR (saf fonksiyon) — böylece testleri düz Node ile,
// VS Code indirmeden koşabiliriz. extension.ts bunu import eder; ayarı (debugInspector.arch)
// orada okur ve buraya string olarak geçer.
//
// KURAL: 'common' anahtarı taşıyan HER nesne bir OVERLAY'dir. Çözüm = common (taban) üzerine
// aktif arch katmanı derin-birleştirilir; common ve aktif arch DIŞINDAKİ kardeşler (yani diğer
// arch blokları) DÜŞER. 'common' taşımayan nesneler olduğu gibi kalır -> arch kullanmayan
// config'ler hiç etkilenmez (geriye dönük uyumlu). Her düzeyde çalışır (bölüm + field).
// Diziler ve skalerler BİRLEŞTİRİLMEZ, DEĞİŞTİRİLİR (arch bloğu tüm diziyi ezebilir).
//
// NOT: 'common' her düzeyde REZERVE anahtardır — bir bölüme "common" ADINI verme.

export const ARCH_DEFAULT = 'common';

function isObj(x: any): boolean {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

// base üzerine over: nesneler özyinelemeli birleşir; dizi/skaler over ile DEĞİŞİR.
function deepMerge(base: any, over: any): any {
  if (!isObj(base) || !isObj(over)) return over;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

// cfg içindeki tüm overlay'leri aktif arch'a göre çöz. arch boş/verilmezse 'common' (yalnız taban).
export function applyArchOverlay(cfg: any, arch?: string): any {
  const active = ((arch ?? '').trim()) || ARCH_DEFAULT;
  const resolve = (node: any): any => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!isObj(node)) return node;
    if ('common' in node) {                                   // OVERLAY düğümü
      let out = resolve((node as any).common);
      if (active !== ARCH_DEFAULT && (node as any)[active] !== undefined)
        out = deepMerge(out, resolve((node as any)[active]));
      return out;                                             // diğer arch kardeşleri düşer
    }
    const out: any = {};                                      // NORMAL düğüm -> içine in
    for (const k of Object.keys(node)) out[k] = resolve((node as any)[k]);
    return out;
  };
  return resolve(cfg);
}
