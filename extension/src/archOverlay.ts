// archOverlay.ts — arch (mimari) overlay çözümü.
//
// BU DOSYA vscode'a BAĞIMLI DEĞİLDİR (saf fonksiyon) — testleri düz Node ile koşulur.
// extension.ts import eder; ayarı (debugInspector.arch) orada okur ve buraya geçer.
//
// KURAL: bir nesne, içinde 'common' VEYA aktif arch (örn 'ppc'/'x86') anahtarı taşıyorsa
// bir OVERLAY'dir. Çözüm = 'common' (varsa, taban) üzerine aktif arch bloğu derin-birleştirilir;
// 'common' ve aktif arch DIŞINDAKİ kardeşler (diğer arch blokları) DÜŞER.
//   - 'common' OPSİYONEL: bir bölüm sadece 'ppc', sadece 'x86' ya da herhangi bir alt küme
//     içerebilir. Tek başına "ppc" yazıp arch=ppc seçmek çalışır.
//   - Aktif arch'ın bloğu yoksa ve 'common' da yoksa, o nesne overlay sayılmaz (bölüm çıkmaz).
//   - Aktif arch 'common' (varsayılan) ise sadece 'common' tabanı kullanılır.
// Ne 'common' ne de aktif arch içeren nesneler olduğu gibi kalır -> arch kullanmayan config
// hiç etkilenmez. Her düzeyde çalışır (bölüm + field). Diziler/skalerler birleştirilmez, DEĞİŞİR.
//
// NOT: 'common' ve arch adları (ppc/x86/...) her düzeyde REZERVE anahtardır — bir bölüme ya da
// alana bu adları verme.

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
  const hasArch = active !== ARCH_DEFAULT;                 // 'common' dışında bir arch seçili mi
  const resolve = (node: any): any => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!isObj(node)) return node;
    const isOverlay = ('common' in node) || (hasArch && active in node);
    if (isOverlay) {
      let out: any = ('common' in node) ? resolve(node.common) : {};   // taban (varsa)
      if (hasArch && node[active] !== undefined)
        out = deepMerge(out, resolve(node[active]));                    // aktif arch üstüne
      return out;                                                       // diğer arch kardeşleri düşer
    }
    const out: any = {};                                               // NORMAL düğüm -> içine in
    for (const k of Object.keys(node)) out[k] = resolve(node[k]);
    return out;
  };
  return resolve(cfg);
}

// Debug Inspector şema anahtarları (section + field + level + timeline). Bir OVERLAY nesnesinde
// bu listede OLMAYAN, değeri nesne olan anahtar = arch etiketi. Şemayı büyütürsen buraya ekle,
// yoksa yeni anahtar yanlışlıkla "arch" sanılır.
const SCHEMA_KEYS = new Set<string>([
  // section
  'mode', 'root', 'levels', 'timeline', 'children', 'next', 'start', 'while', 'head', 'nil',
  'count', 'access', 'cast', 'wrap', 'label', 'groupBy', 'selectedFrom', 'hidden', 'max', 'fields',
  // field
  'expr', 'when', 'base', 'bar', 'link', 'badge', 'valueMap', 'flags', 'symbol', 'sourceLine',
  'editable',
  // level (nested_array)
  'name', 'array',
]);

// Config'te TANIMLI arch etiketlerini bul (panelin arch seçicisi bunu listeler).
//
// 'common' DÖNMEZ — o taban, seçicide her zaman ilk seçenek olarak ayrıca sunulur.
//
// Yalnız overlay barındırabilen yerlere inilir: bölüm gövdeleri, 'fields' / 'levels' öğeleri ve
// common/arch bloklarının içi. 'valueMap' / 'badge' / 'flags' / 'bar' / 'link' gibi anahtarların
// İÇİNE İNİLMEZ: onların değerleri de nesne olabilir (örn valueMap {"0": {text,color}}) ve
// "0" gibi uyduruk arch'lar bulunurdu.
export function discoverArchs(cfg: any): string[] {
  const found = new Set<string>();
  const visit = (node: any, depth: number): void => {
    if (!isObj(node) || depth > 12) return;
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (k.startsWith('//')) continue;                 // yorum anahtarı
      if (k === 'common') { visit(v, depth + 1); continue; }   // taban -> içine in
      if (k === 'fields' || k === 'levels') {           // dizi: her öğe section/field-benzeri
        if (Array.isArray(v)) for (const it of v) visit(it, depth + 1);
        continue;
      }
      if (SCHEMA_KEYS.has(k)) continue;                 // bilinen şema anahtarı -> arch değil
      if (isObj(v)) { found.add(k); visit(v, depth + 1); }     // arch etiketi + içine in
    }
  };
  // ÜST DÜZEY: anahtarlar bölüm ADLARIdır (arch değil) -> adı atla, gövdesini gez.
  if (isObj(cfg)) for (const k of Object.keys(cfg)) if (!k.startsWith('//')) visit((cfg as any)[k], 0);
  return [...found].sort();
}
