import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyArchOverlay, discoverArchs } from './archOverlay';

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------
interface FieldCfg {
  label: string; expr: string; hidden?: boolean; base?: string;   // hidden: başlangıçta gizli; base: "dec"|"hex"|"bin"
  bar?: string | { max?: string; warn?: number; crit?: number };  // kullanım çubuğu: expr=used, bar.max=toplam (eleman-ifadesi veya sabit), warn/crit eşikleri (%)
  link?: { section: string; match?: string };  // çapraz-referans: değeri hedef bölümün 'match' kolonuyla eşleştir; tıklayınca oraya git (match yoksa hedefin ilk kolonu)
  when?: string;  // koşullu alan: eleman üzerinde GDB bool ifadesi; yanlışsa hücre boş kalır (değer çekilmez). ${expr}/${wrapped_expr} kullanılabilir. Variant/tagged-union: aynı discriminator'a bağlı birkaç 'when'li alan.
  editable?: boolean;  // sağ-tık 'Edit value' ile düzenlenebilir (GDB 'set var' ile debuggee'ye YAZAR). Sadece atanabilir (L-value) ifadeler; aksi halde GDB hata verir.
  wrap?: string;  // alana ERİŞTİKTEN SONRA değeri dönüştür; ${expr} = erişilen alan değeri. Örn expr "data" + wrap "((widget_t *)${expr})->x" -> ((widget_t *)(elem.data))->x. Sonuç hücreye yazılır.
  badge?: Record<string, string>;  // değer -> renk rozet eşlemesi (case-insensitive tam eşleşme); renk adı (green/blue/red/amber/purple/cyan/gray) veya #rrggbb. Verilirse built-in State/Discipline heuristic'i yerine bu kullanılır.
  valueMap?: Record<string, string | { text?: string; color?: string }>;  // değer -> görüntü. Düz string verilirse görüntülenecek METİN; {text,color} ile metin ve/veya renk. color: renk adı veya #rrggbb. badge'den farkı: badge yalnız renklendirir, valueMap METNİ de değiştirir (örn 2 -> "XXX" + #ff0000). Tablo hücresinde ve graph kartında uygulanır.
  flags?: Record<string, string | { text?: string; color?: string }>;  // BAYRAK alanı: anahtar = bit MASKESİ (hex 0x04 veya dec 4); integer değerin set olan bitleri çözülüp isimleri gösterilir ((val & mask) == mask). Düz string = isim; {text,color} ile renk. Eşlenmeyen kalan bitler sonda +0x.. olarak gösterilir.
  symbol?: boolean;  // SEMBOL alanı: değeri bir KOD ADRESİ kabul et; GDB 'print/a' ile çöz ve 'func+off' sembolünü göster (çözülemezse adres). Örn callstack PC -> hangi fonksiyon. Salt-okunur gösterim (base/edit/watch uygulanmaz).
  sourceLine?: boolean;  // KAYNAK KONUM alanı: değeri bir KOD ADRESİ kabul et; GDB 'info line *(...)' ile çöz ve "dosya:satır" göster (satır bilgisi yoksa boş). Örn callstack PC -> hangi kaynak satırı. symbol gibi salt-okunur; tıklanınca o dosya/satır editörde açılır.
}
// nested_array SEVİYESİ: çok boyutlu dizinin bir boyutu. levels[0] = EN DIŞ, son seviye = SATIRLAR.
// 'name' verilirse ifadelerde ${<name>} = o seviyenin elemanı, ${<name>_index} = subscript'i (örn ${core}, ${core_index}).
interface LevelCfg {
  name?: string;    // seviyenin adı -> isimli token'lar (${core}/${core_index}); benzersiz + rezerve olmamalı
  array?: string;   // bu seviyenin dizisi: levels[0]'da tam ifade; sonrakilerde PARENT elemana göre parça (accessor | sabit | "::global" | ${expr} şablonu; "${expr}" tek başına = parent'ın kendisi)
  count?: string;   // eleman sayısı: levels[0]'da tam ifade; sonrakilerde parça sözdizimi
  access?: string;  // BU seviyenin elemanına alan erişimi "." (default) | "->" (çocuk dizi/label/alanlar bunu kullanır)
  label?: string;   // grup başlığı parçası: accessor (GDB ile okunur) ya da '${' içeren METİN şablonu
  cast?: string;    // bu seviyenin dizisini cast'le: ((cast)(dizi))[i]
  wrap?: string;    // bu seviyenin elemanını sarmala; ${expr} = eleman
}
// ⏱ timeline.set: bir BLOK elemanının alt dizisi (device/id kümesi). Tek nesne VEYA dizi (birden çok küme) verilebilir.
interface TlSetDef { array: string; count: string | number; access?: string; label?: string; title?: string; dashWhen?: string | number | boolean; max?: number }
interface SectionCfg {
  mode: 'linked_list' | 'array' | 'index_list' | 'tree' | 'walk' | 'nested_array';
  root: string;   // nested_array: levels[0].array verilmemişse DIŞ dizi buradan alınır
  levels?: LevelCfg[];  // nested_array: seviye listesi (>=2; son seviye SATIRLAR). Parça sözdizimi (array/count): accessor ("items") | sabit ("4") | "::global" | ${expr} şablonu (${expr} = PARENT eleman; "${expr}" tek başına = parent'ın kendisi dizi kökü, örn struct_my* array[N] -> array[i][j])
  timeline?: { lane?: string; order?: string; label?: string; color?: string; width?: string; start?: string; total?: string | number; totalLabel?: string; unit?: string; chart?: string; scale?: 'proportional' | 'fit'; set?: TlSetDef | TlSetDef[] };  // ⏱ timeline: lane=şerit kolonu (yoksa grup başlığı), start=blokların EKSEN KONUMU kolonu (verilirse konumlu mod: aralar boş kalabilir; order yok sayılır), width=süre/genişlik kolonu, total=eksen sonu, konumlu modda ZORUNLU — SAYI (tüm grafiklerde sabit) YA DA KOLON adı (her grafiğin total'ı kendi satırlarından; hesaplama yok); totalLabel=total için eksende gösterilecek ETİKET metni (verilmezse VARSAYILMAZ, sadece sayı+birim yazılır; örn "major frame" -> "major frame: 200 ms"); chart=grafik bölme kolonu (her farklı değer AYRI grafik+eksen); scale='proportional'(varsayılan, uzun timeline fiziksel uzun) | 'fit'(hepsi tam genişlik); unit=eksen birimi (örn "ms"), order=ardışık modda sıralama, label=blok metni, color=renk anahtarı. set=TEK küme nesnesi YA DA DİZİ ([{...},{...}] birden çok küme; her biri kendi chip satırı; title VERİLMİŞSE chip'lerin soluna caption yazılır — tek set'te de). Her küme={array,count,access?,label?,title?,dashWhen?,max?}=bir BLOK elemanının ALT dizisi (örn part'ın device id kümesi) -> blok içinde chip olarak gösterilir; array/count parça sözdizimi (accessor | sabit | "::global" | "${expr}" şablonu; PARENT = blok elemanı), label = her alt elemanda okunacak alan (yoksa elemanın kendisi), access = alt eleman erişimi "." | "->", title = tooltip'teki küme BAŞLIĞI (verilmezse isim yazılmaz, sadece "(N): ...") — varsayılmaz, sen verirsin, dashWhen = kesikli-kenar KOŞULU (doğruysa chip kenarı KESİKLİ; field 'when' ile aynı boş/0/false/NULL=false kuralı): true/false = SABİT (GDB'siz, hepsi/hiçbiri) | "1"/"0" gibi eleman-bağımsız ifade = BİR KEZ | accessor "off" / "${expr}" şablonu (${expr}=cihaz elemanı) = HER eleman için, max = alt eleman tavanı (varsayılan 64). Bloğa sığmayan chip'ler otomatik gizlenir + sona "+N" rozeti (tam liste tooltip'te; zoom'da genişleyince daha fazlası görünür)
  children?: string[];   // tree: çocuk pointer alan adları (örn ["left","right"]); varsayılan ["left","right"]
  next?: string;      // linked_list: sonraki node pointer alanı | index_list: sonraki index alanı | walk: ${expr} (kürsör) -> sonraki kürsör (örn "*(unsigned long*)(${expr})")
  start?: string;     // walk: başlangıç kürsörü (adres/değer ifadesi; root yoksa bunu kullanır)
  while?: string;     // walk: devam KOŞULU (boolean ${expr} şablonu); false olunca durur (örn sınır içinde kalma)
  head?: string;      // index_list: başlangıç index ifadesi
  nil?: string;       // index_list: gezinmeyi bitiren index (varsayılan "-1")
  count?: string;     // array
  access?: string;    // array/index_list eleman erişimi: "." (default) veya "->"
  cast?: string;      // array: void*/generic buffer'a cast (tam yaz, örn "widget_t *") -> ((cast)(root))[i]
  wrap?: string;      // elemanı field'a erişmeden ÖNCE sarmala; ${expr}=eleman. Örn "((T*)${expr})" -> ((T*)(elem))->field
  label?: string;     // (master) ağaç düğüm başlığı için ifade; groupBy hedefi bunu kullanır
  groupBy?: string;   // bu bölümü adı verilen master bölüme göre ağaç olarak grupla; root'ta ${master}
  selectedFrom?: string;   // TALEP-ÜZERİNE DETAY bölümü: adı verilen master bölümün BİR satırı sağ-tıklanıp "Show detailed info" seçilince kurulur. Sekme olarak GÖRÜNMEZ. Bu bölümün ifadelerinde ${selected} = seçilen master satırın kararlı eleman ifadesi (örn callstack: start "${selected}->fp"); ${selected_index} = seçilen satırın index'i (yalnız master 'array'/'index_list' ise); ${selected_master_index} = seçilen satırın ait olduğu GRUBUN master index'i (yalnız master gruplu + groupBy hedefi 'array'/'index_list' ise). Koşullar sağlanmazsa detay AÇIK hata gösterir.
  hidden?: boolean;   // bölüm (sekme) başlangıçta gizli (kullanıcı Sections menüsünde seçim yapana kadar)
  max?: number;
  fields: FieldCfg[];
}
type SyncCfg = Record<string, unknown>;

type Row = Record<string, string>;
interface Group { label: string; key: string; rows: Row[]; }
interface Section {
  name: string; columnsAll: string[]; hidden: string[]; rows: Row[]; summary: string;
  bases?: Record<string, string>;   // kolon -> config sayı tabanı (dec/hex/bin)
  bars?: Record<string, { warn: number; crit: number }>;   // kolon -> kullanım çubuğu eşikleri (max değeri row['__bar__'+kolon]'da)
  links?: Record<string, { section: string; match?: string }>;   // kolon -> çapraz-referans hedefi (section + match kolonu)
  badges?: Record<string, Record<string, string>>;   // kolon -> değer->renk rozet eşlemesi
  valueMap?: Record<string, Record<string, { text?: string; color?: string }>>;   // kolon -> değer -> {metin, renk} görüntü eşlemesi (badge'in metin değiştiren üst kümesi)
  flags?: Record<string, Record<string, { text?: string; color?: string }>>;   // kolon -> bit MASKESİ (string) -> {metin, renk}; integer'ın set bitleri çözülür
  needsSelection?: boolean;   // gruplu bölüm: master bölüm boş/bulunamadı
  error?: string;             // detay bölümü: çözülemeyen durum (örn ${selected_index}, array/index_list olmayan master'da) -> panelde uyarı göster
  grouped?: boolean;          // groupBy ile ağaç olarak gruplanmış
  groups?: Group[];           // her master elemanı için bir grup
  kind?: 'linked' | 'array' | 'index' | 'tree';   // graph view: zincir (next) / ızgara (array) / hiyerarşi (tree) yerleşimi
  timeline?: { lane?: string; order?: string; label?: string; color?: string; width?: string; start?: string; total?: string | number; totalLabel?: string; unit?: string; chart?: string; scale?: 'proportional' | 'fit'; set?: TlSetDef | TlSetDef[] };   // ⏱ timeline görünümü ayarları (sunum meta'sı; cfg.timeline'dan)
}
interface ColPref { order: string[]; hidden: string[]; }

// ---------------------------------------------------------------------------
// Global durum
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;
let lastStopped: { session: vscode.DebugSession; threadId: number; frameId?: number } | undefined;
// Talep-üzerine açık detaylar (selectedFrom + ${selected}). master satırı sağ-tıklanıp açılınca eklenir;
// her durakta yeniden çekilir; kapatılınca/panel taşınınca temizlenir. sel = seçilen satırın kararlı eleman ifadesi.
let openDetails: Array<{ master: string; sel: string; section: string; selIndex?: string; selMasterIndex?: string; selOuterIndex?: string }> = [];
let printSetupFor: vscode.DebugSession | undefined;   // #3: kompakt print ayarları bu oturumda yapıldı mı
// Output: config-driven seviyeli logger (debugInspector.logLevel)
// Seçilebilir seviyeler: off / info / debug. trace -> debug tier, warn/error -> info tier.
const LOG_LEVELS: Record<string, number> = { debug: 20, trace: 20, info: 30, warn: 30, error: 30, off: 100 };
let logChannel: vscode.OutputChannel | undefined;
let logThreshold = LOG_LEVELS.info;
function readLogLevel(): number {
  const v = String(vscode.workspace.getConfiguration('debugInspector').get('logLevel') ?? 'info').toLowerCase();
  return LOG_LEVELS[v] ?? LOG_LEVELS.info;
}
function emit(sev: number, tag: string, msg: string) {
  if (!logChannel || sev < logThreshold) return;
  // 'log' dili gramerinin renklendirebilmesi için: ISO tarih-saat + BÜYÜK seviye
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  logChannel.appendLine(`${stamp} [${tag.toUpperCase().padEnd(5)}] ${msg}`);
}
const log = {
  trace: (m: string) => emit(LOG_LEVELS.trace, 'trace', m),
  debug: (m: string) => emit(LOG_LEVELS.debug, 'debug', m),
  info:  (m: string) => emit(LOG_LEVELS.info, 'info', m),
  warn:  (m: string) => emit(LOG_LEVELS.warn, 'warn', m),
  error: (m: string) => emit(LOG_LEVELS.error, 'error', m),
  show:  () => logChannel?.show()
};
let configWatcher: vscode.FileSystemWatcher | undefined;
let extContext: vscode.ExtensionContext | undefined;
let columnPrefs: Record<string, ColPref> = {};
const COLPREF_KEY = 'debugInspector.columnPrefs';
let sectionPrefs: { order: string[]; hidden: string[]; touched?: boolean } = { order: [], hidden: [] };  // sekme sırası + gizli sekmeler; touched=kullanıcı seçim yaptı (config hidden artık yoksayılır)
const SECPREF_KEY = 'debugInspector.sectionPrefs';
let paused = false;                         // duraklatılınca durakta otomatik yenileme yapılmaz
const PAUSED_KEY = 'debugInspector.paused';
// Arch (mimari) seçimi: panelin üst barındaki seçici. Config'te TANIMLI arch etiketleri
// keşfedilir (discoverArchs) ve kullanıcı oradan seçer -> workspace'te hatırlanır.
// archPref undefined = kullanıcı henüz seçmedi -> 'debugInspector.arch' ayarı (varsayılan 'common').
// Seçim yapıldıktan sonra AYAR YOKSAYILIR (bölüm/kolon tercihlerindeki 'touched' mantığının aynısı).
let archPref: string | undefined;
const ARCHPREF_KEY = 'debugInspector.archPref';
let availableArchs: string[] = [];          // config'te bulunan arch etiketleri ('common' hariç)

// Etkin arch: UI seçimi > ayar > 'common'. Seçim artık config'te yoksa (dosya değişti) 'common'a düş.
function activeArch(): string {
  const setting = (vscode.workspace.getConfiguration('debugInspector').get<string>('arch') || '').trim();
  const want = (archPref ?? setting ?? '').trim() || 'common';
  if (want !== 'common' && availableArchs.length && !availableArchs.includes(want)) {
    log?.warn(`arch "${want}" config'te tanımlı değil (bulunanlar: ${availableArchs.join(', ') || '-'}) → 'common' kullanılıyor`);
    return 'common';
  }
  return want;
}

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  columnPrefs = context.workspaceState.get<Record<string, ColPref>>(COLPREF_KEY) ?? {};
  sectionPrefs = context.workspaceState.get<{ order: string[]; hidden: string[]; touched?: boolean }>(SECPREF_KEY) ?? { order: [], hidden: [] };
  paused = context.workspaceState.get<boolean>(PAUSED_KEY) ?? false;
  archPref = context.workspaceState.get<string>(ARCHPREF_KEY) ?? undefined;

  logChannel = vscode.window.createOutputChannel('Debug Inspector', 'log'); // 'log' dili = renkli
  logThreshold = readLogLevel();
  context.subscriptions.push(logChannel);
  log.info(`Debug Inspector activated (log level: ${vscode.workspace.getConfiguration('debugInspector').get('logLevel') ?? 'info'})`);

  context.subscriptions.push(
    vscode.commands.registerCommand('debugInspector.open', () => {
      log.debug('command: open panel');
      openPanel(context);
      // doRefresh() KULLAN — doğrudan refresh() DEĞİL: doğrudan çağrı debounce/gen-guard/gdbAcquire mutex'ini
      // atlar ve webview'in yüklenince gönderdiği 'ready' tetiklediği refresh ile YARIŞIR (çift fetch + paylaşılan
      // $ri_* cursor çakışması). doRefresh ikisini tek koşuya indirger. (Yeni panelde 'ready' zaten tetikler;
      // bu satır mevcut panel REVEAL edilince —webview yeniden yüklenmez, 'ready' gelmez— gereklidir.)
      if (lastStopped) doRefresh();
    }),
    vscode.commands.registerCommand('debugInspector.showLog', () => log.show()),
    vscode.commands.registerCommand('debugInspector.openConfig', async () => {
      log.debug('command: open config');
      const file = configFilePath();
      if (!file) { vscode.window.showWarningMessage('Debug Inspector: open a workspace folder so the config path can be resolved.'); return; }
      try {
        if (!fs.existsSync(file)) {
          const pick = await vscode.window.showInformationMessage(`Debug Inspector: no config file at ${file}`, 'Create starter', 'Cancel');
          if (pick !== 'Create starter') return;
          fs.writeFileSync(file, STARTER_CONFIG, 'utf8');
          log.info(`created starter config: ${file}`);
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Debug Inspector: could not open config — ${e?.message ?? e}`);
      }
    })
  );

  const types: string[] =
    vscode.workspace.getConfiguration('debugInspector').get('debugTypes') ?? ['cppdbg'];

  for (const type of types) {
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterTrackerFactory(type, {
        createDebugAdapterTracker(session) {
          return {
            onDidSendMessage(msg: any) {
              if (msg.type !== 'event') return;
              if (msg.event === 'stopped') {
                const threadId = msg.body?.threadId ?? 0;
                lastStopped = { session, threadId };
                log?.debug(`debug stopped (thread ${threadId})${paused ? ' [paused — skipping refresh]' : ''}`);
                if (!paused) doRefresh();   // debounced + iptal: hızlı adımlamada önceki refresh'ler atlanır
              } else if (msg.event === 'continued') {
                log?.trace('debug continued');
                cancelRefresh();            // çalışmaya devam etti: bekleyen refresh'i iptal et (durmuşken çekemeyiz)
                if (!paused) panel?.webview.postMessage({ type: 'running' });
              }
            }
          };
        }
      })
    );
  }

  // Debug oturumu bittiğinde paneli kapat (izlenen oturum sona erince stale veri/spinner kalmasın)
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(s => {
      if (!panel) return;
      const tracked = lastStopped?.session;
      if (tracked && tracked !== s) return;   // bizim izlediğimiz oturum değil -> dokunma
      log?.info('debug session terminated → closing panel');
      lastStopped = undefined; printSetupFor = undefined; watchpoints = {}; cancelRefresh();
      panel.dispose();   // onDidDispose -> panel = undefined
    })
  );

  // config dosyası değişince (debugger durmuşsa ve panel açıksa) otomatik yenile
  setupConfigWatcher(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('debugInspector.configPath')) setupConfigWatcher(context);
      if (e.affectsConfiguration('debugInspector.arch')) {
        const s = vscode.workspace.getConfiguration('debugInspector').get('arch') ?? 'common';
        if (archPref !== undefined) {
          // Panelin arch seçicisinden seçim yapılmış -> ayar YOKSAYILIR (bölüm/kolon
          // tercihlerindeki 'touched' mantığının aynısı). Ayar artık yalnız İLK varsayılan;
          // değiştirmek için panelin seçicisini kullan.
          log.info(`arch setting changed to "${s}" but the panel's arch picker ("${archPref}") wins — ignored`);
        } else {
          log.info(`arch changed: ${s} → re-resolving config`);
          onConfigChange();   // config semantiği değişti (yeni arch) -> veri/sunum farkına göre yenile
          sendArchs();
        }
      }
      if (e.affectsConfiguration('debugInspector.logLevel')) {
        logThreshold = readLogLevel();
        log.info(`log level changed: ${vscode.workspace.getConfiguration('debugInspector').get('logLevel') ?? 'info'}`);
      }
    })
  );
}

export function deactivate() {}

// configPath ayarına göre config dosyasını izle; değişince paneli tazele
function setupConfigWatcher(context: vscode.ExtensionContext) {
  configWatcher?.dispose();
  const rel: string =
    vscode.workspace.getConfiguration('debugInspector').get('configPath') ?? 'debug-inspector.json';
  let pattern: vscode.RelativePattern;
  if (path.isAbsolute(rel)) {
    pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(rel)), path.basename(rel));
  } else {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    pattern = new vscode.RelativePattern(folder, rel);
  }
  configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
  configWatcher.onDidChange(onConfigChange);
  configWatcher.onDidCreate(onConfigChange);
  context.subscriptions.push(configWatcher);
}

// Config kaydedildiğinde: VERİYİ etkileyen bir şey değiştiyse yeniden çek; yalnız SUNUM (base/bar eşiği/link/badge)
// değiştiyse GDB'ye hiç gitme — istemci-tarafı yeniden çiz. "Her zaman her şeyi çekme" optimizasyonu.
function onConfigChange() {
  if (!panel || !lastStopped) return;
  masterWarned.clear();   // config değişti -> ${master} uyarısı düzeltildiyse tekrar uyarma; hâlâ yanlışsa bir kez daha uyar
  const cfg = loadConfig();
  sendArchs();   // dosya elle düzenlendi -> arch etiket listesi de değişmiş olabilir
  if (!cfg) { doRefresh(); return; }   // okunamadı/şema bozuk -> güvenli tam yenile
  const secs = extractSections(cfg);
  const fp = fingerprintOf(secs, resolveLayout(secs));
  if (fp !== lastFingerprint) {
    log?.info('config change: data-affecting → refetch');
    doRefresh();   // veri/sıra/gizli/alan değişti -> normal (öncelikli streaming) yenile (lastFingerprint'i günceller)
    return;
  }
  // yalnız sunum değişmiş: GDB yok, her bölümün base/bar/link/badge'ini istemciye gönder
  log?.info('config change: presentation-only → no GDB refetch');
  for (const { name, cfg: scfg } of secs) {
    panel.webview.postMessage({
      type: 'presentationUpdate', section: name,
      bases: fieldBases(scfg.fields), bars: fieldBars(scfg.fields),
      links: fieldLinks(scfg.fields), badges: fieldBadges(scfg.fields), valueMap: fieldValueMap(scfg.fields), flags: fieldFlags(scfg.fields), srcCols: fieldSrcCols(scfg.fields), timeline: scfg.timeline
    });
  }
}

// --- debounce + iptal: hızlı arka arkaya istekler (config kaydı, hızlı adımlama)
// tek bir refresh'e indirgenir; çalışan refresh yeni istek gelince geçersiz olur ve
// en güncel state ile bir kez daha koşulur (önceki refresh'ler iptal/atlanır) ---
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let pendingRefresh = false;
let refreshGen = 0;                 // her istek artar; refresh bunu izleyip eskiyi iptal eder
const REFRESH_DEBOUNCE_MS = 140;
let activeTab: string | undefined;  // webview'in o anki aktif sekmesi -> refresh önce onu çeker, sekme değişince öncelik değişir
let watchpoints: Record<string, number> = {};   // izlenen l-value ifadesi -> GDB watchpoint no (★ işareti + kaldırma için)
let wpCounter = 0;                               // her watchpoint'e benzersiz convenience var ($di_wp<N>) için sayaç
function sendWatchpoints() { panel?.webview.postMessage({ type: 'watchpoints', exprs: Object.keys(watchpoints) }); }
// Arch seçicisini besle: config'te bulunan etiketler + o an etkin olan. Config dosyası
// değişince etiket listesi de değişebileceği için her yenilemede/değişimde gönderilir.
function sendArchs() {
  panel?.webview.postMessage({ type: 'archs', archs: availableArchs, active: activeArch() });
}
// GDB watchpoint numarasını 'info watchpoints'tan bul (cppdbg 'watch' çıktısında numarayı her zaman echo'lamaz).
// Önce 'What' sütunu expr ile eşleşen satır; yoksa en yüksek numara (en son eklenen).
async function findWatchNum(session: vscode.DebugSession, frameId: number | undefined, expr: string): Promise<number> {
  const out = (await gdbExec(session, 'info watchpoints', frameId)).toString();
  let best = NaN;
  for (const ln of out.split(/\r?\n/)) {
    const m = ln.match(/^\s*(\d+)\s+.*watchpoint/i);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (ln.includes(expr)) return num;
    best = num;
  }
  return best;
}

// GDB işlem MUTEX'i: refresh / refreshTarget / refreshRow asla İÇ İÇE çalışmasın.
// (Hepsi $ri_*/$rg_* convenience cursor'larını paylaşıyor; eşzamanlı akarlarsa biri diğerinin
//  cursor'unu ezer -> $cursor->next hatalı/NULL okur -> geçici ⚠ hücreler. Serileştirme bunu önler.)
let gdbChain: Promise<unknown> = Promise.resolve();
async function gdbAcquire(): Promise<() => void> {
  let release: () => void = () => {};
  const next = new Promise<void>(r => { release = r; });
  const prev = gdbChain;
  gdbChain = next;
  await prev;        // önceki işlem bitene kadar bekle
  return release;
}

function doRefresh() {
  refreshGen++;                     // bekleyen/çalışan refresh'i geçersiz kıl
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void runRefresh(); }, REFRESH_DEBOUNCE_MS);
}
function cancelRefresh() {          // program devam edince: planlanan refresh'i iptal et + çalışanı geçersiz kıl
  refreshGen++;
  // KUYRUĞA ALINMIŞ re-run'ı da düşür: çalışan bir refresh sırasında ikinci bir tetik pendingRefresh=true
  // yapmış olabilir; bunu temizlemezsek runRefresh'in do/while'ı (lastStopped hâlâ dolu) 'continued'den SONRA
  // bir tam refresh daha koşar (gen yeni bump'landığı için stale de değil) -> koşan program üstünde stale çekim/⚠.
  pendingRefresh = false;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
}
async function runRefresh() {
  if (refreshing) { pendingRefresh = true; return; }   // zaten çalışıyor -> bitince en günceliyle bir kez daha
  if (!panel || !lastStopped) return;
  refreshing = true;
  try {
    do {
      pendingRefresh = false;
      const rel = await gdbAcquire();   // hedefli işlemlerle iç içe geçmesin
      try { await refresh(lastStopped.session, lastStopped.threadId, refreshGen); }
      finally { rel(); }
      await refreshAllDetails();   // açık talep-üzerine detayları da bu durakta tazele (refreshDetail kendi kilidini alır)
    } while (pendingRefresh && !!lastStopped);
  } finally {
    refreshing = false;
  }
}

// Hedefli yenileme: tek bölüm (section reveal) veya tek kolon (column show) — tüm paneli yeniden çekmeden.
// label verilirse SADECE o field çekilir ve mevcut satırlara merge edilir; verilmezse tüm bölüm (aktif kolonlarıyla) kurulur.
async function refreshTarget(section: string, label?: string) {
  if (!panel || !lastStopped) return;   // durmuş değilse veri yok; sonraki durakta dolar
  const session = lastStopped.session;
  const frameId = lastStopped.frameId;
  const cfg = loadConfig(); if (!cfg) return;
  const secs = extractSections(cfg);
  const idx = secs.findIndex(s => s.name === section);
  if (idx < 0) return;
  const scfg = secs[idx].cfg;
  const rel = await gdbAcquire();   // refresh / diğer hedefli işlemlerle iç içe geçmesin (cursor çakışması -> ⚠)
  try {

  // grouped bölüm için master'ı kur (sadece bu bölüm + master fetch edilir, diğer bölümlere dokunulmaz)
  let masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }> = {};
  if (isGrouped(scfg)) {
    const mName = scfg.groupBy as string;
    const mIdx = secs.findIndex(s => s.name === mName);
    if (mIdx < 0) return;
    const mSec = await buildSection(session, secs[mIdx].cfg, frameId, '$ri_' + mIdx, mName);
    masters[mName] = { sec: mSec, selExprs: masterSelExprs(mSec, secs[mIdx].cfg), cfg: secs[mIdx].cfg };
  }
  const ts = new Date().toLocaleTimeString();

  if (label) {
    // TEK KOLON: yalnız bu field'ı çek -> satır sırasıyla merge için gönder
    const oneField = scfg.fields.find(f => f.label === label);
    if (!oneField) return;
    const subCfg: SectionCfg = { ...scfg, fields: [oneField] };
    let rows: Row[];
    if (isMultiArray(scfg)) {
      const g = await buildArrayNd(session, frameId, section, subCfg);
      rows = (g.groups || []).reduce<Row[]>((a, gr) => a.concat(gr.rows), []);
    } else if (isGrouped(scfg)) {
      const g = await buildGrouped(session, frameId, idx, section, subCfg, masters);
      rows = (g.groups || []).reduce<Row[]>((a, gr) => a.concat(gr.rows), []);
    } else {
      rows = await collectSection(session, subCfg, frameId, '$ri_' + idx, section);
    }
    log?.debug(`refreshTarget: column "${section}.${label}" -> ${rows.length} value(s)`);
    panel.webview.postMessage({ type: 'patchColumn', section, label, rows, ts });
  } else {
    // TEK BÖLÜM: tüm aktif kolonlarıyla yeniden kur
    const sec = isMultiArray(scfg)
      ? await buildArrayNd(session, frameId, section, scfg)
      : isGrouped(scfg)
        ? await buildGrouped(session, frameId, idx, section, scfg, masters)
        : await buildSection(session, scfg, frameId, '$ri_' + idx, section);
    // kolon tercihleri KURULUM sırasında değişmiş olabilir (örn kullanıcı yeniden-kurulum sürerken Hide all yaptı):
    // build başındaki snapshot'ı gönderirsek webview'in taze gizleme durumu ESKİYE döner. Post ANINDA etkin tercihleri uygula.
    const effNow = effectiveColumns(section, scfg.fields);
    sec.columnsAll = effNow.order; sec.hidden = effNow.hidden;
    log?.debug(`refreshTarget: section "${section}" rebuilt`);
    panel.webview.postMessage({ type: 'patchSection', section, sec, ts });
  }
  } finally { rel(); }
}

// Talep-üzerine DETAY (selectedFrom): seçilen master satırı (sel = kararlı eleman ifadesi) için detay bölümünü kur ve gönder.
// ${selected} -> (sel) tüm ifadelerde. Sekme akışından bağımsız; kendi GDB kilidini alır (cursor çakışması olmasın).
async function refreshDetail(d: { master: string; sel: string; section: string; selIndex?: string; selMasterIndex?: string; selOuterIndex?: string }): Promise<void> {
  if (!panel || !lastStopped) return;
  const cfg = loadConfig(); if (!cfg) return;
  const secs = extractSections(cfg);
  const dNode = secs.find(s => s.name === d.section);
  if (!dNode || !isDetail(dNode.cfg)) return;
  const ts = new Date().toLocaleTimeString();
  const failDetail = (emsg: string) => {   // detay panelinde AÇIK uyarı göster (GDB'ye kriptik hata sarkıtma)
    log?.warn(`refreshDetail "${d.section}": ${emsg}`);
    panel!.webview.postMessage({ type: 'patchDetail', master: d.master, sel: d.sel, section: d.section, sec: { name: d.section, columnsAll: [], hidden: [], rows: [], summary: '', error: emsg }, ts });
  };
  // ${selected_index}: yalnız master 'array' / 'index_list' / 'nested_array' ise anlamlı (gerçek subscript;
  // nested_array'de SATIR/en iç subscript). Değilse veya index yoksa AÇIK hata.
  if (usesSelectedIndex(dNode.cfg)) {
    const mMode = secs.find(s => s.name === (dNode.cfg.selectedFrom as string))?.cfg.mode;
    if (mMode !== 'array' && mMode !== 'index_list' && mMode !== 'nested_array') {
      failDetail(`\${selected_index} yalnız 'array', 'index_list' veya 'nested_array' master bölümde kullanılabilir; "${dNode.cfg.selectedFrom}" modu: ${mMode ?? 'bilinmiyor'}.`); return;
    }
    if (d.selIndex == null || d.selIndex === '') {
      failDetail(`\${selected_index} çözülemedi: seçilen satırın index'i yok (master "${dNode.cfg.selectedFrom}").`); return;
    }
  }
  // ${selected_master_index}: seçilen satırın PARENT'ının index'i. Anlamlı olduğu durumlar:
  // (a) master bölüm 'nested_array' (satırın PARENT seviyesinin subscript'i), ya da (b) master gruplu (groupBy)
  // VE groupBy hedefi 'array'/'index_list'. Değilse AÇIK hata.
  if (usesSelectedMasterIndex(dNode.cfg)) {
    const mCfg = secs.find(s => s.name === (dNode.cfg.selectedFrom as string))?.cfg;
    if (mCfg?.mode !== 'nested_array') {
      const gName = mCfg?.groupBy as string | undefined;
      if (!gName) {
        failDetail(`\${selected_master_index} için master bölüm ("${dNode.cfg.selectedFrom}") gruplu (groupBy) ya da 'nested_array' olmalı.`); return;
      }
      const gMode = secs.find(s => s.name === gName)?.cfg.mode;
      if (gMode !== 'array' && gMode !== 'index_list') {
        failDetail(`\${selected_master_index} yalnız groupBy hedefi 'array' veya 'index_list' ise kullanılabilir; "${gName}" modu: ${gMode ?? 'bilinmiyor'}.`); return;
      }
    }
    if (d.selMasterIndex == null || d.selMasterIndex === '') {
      failDetail(`\${selected_master_index} çözülemedi: seçilen satırın master index'i yok.`); return;
    }
  }
  // ${selected_outer_index}: seçilen satırın DIŞ (1. seviye) index'i — yalnız 'nested_array' (>=3 seviye) master.
  if (usesSelectedOuterIndex(dNode.cfg)) {
    const mMode = secs.find(s => s.name === (dNode.cfg.selectedFrom as string))?.cfg.mode;
    if (mMode !== 'nested_array') {
      failDetail(`\${selected_outer_index} yalnız 'nested_array' (>=3 seviye) master bölümde kullanılabilir; "${dNode.cfg.selectedFrom}" modu: ${mMode ?? 'bilinmiyor'}.`); return;
    }
    if (d.selOuterIndex == null || d.selOuterIndex === '') {
      failDetail(`\${selected_outer_index} çözülemedi: seçilen satırın dış index'i yok.`); return;
    }
  }
  const session = lastStopped.session;
  const frameId = lastStopped.frameId;
  const subCfg = substituteSelected(dNode.cfg, d.sel, d.selIndex, d.selMasterIndex, d.selOuterIndex);
  // ALAN ifadelerindeki ${selected*} token'ları satır anında çözülür (ön-yerleştirme değil — bkz substituteSelected)
  const selVars: Record<string, string> = { selected: '(' + d.sel + ')' };
  if (d.selIndex != null) selVars['selected_index'] = d.selIndex;
  if (d.selMasterIndex != null) selVars['selected_master_index'] = d.selMasterIndex;
  if (d.selOuterIndex != null) selVars['selected_outer_index'] = d.selOuterIndex;
  const rel = await gdbAcquire();
  try {
    const sec = isMultiArray(subCfg)
      ? await buildArrayNd(session, frameId, d.section, subCfg, undefined, undefined, selVars)   // çok seviyeli detay da desteklenir
      : await buildSection(session, subCfg, frameId, '$rd_' + d.section, d.section, undefined, undefined, selVars);
    log?.debug(`refreshDetail: "${d.section}" of [${d.sel}] (idx=${d.selIndex ?? '-'}) -> ${sec.rows.length} row(s)`);
    panel.webview.postMessage({ type: 'patchDetail', master: d.master, sel: d.sel, section: d.section, sec, ts });
  } finally { rel(); }
}
// Tüm açık detayları yeniden çek (her durak sonunda, ana yenileme bittikten SONRA). Geçersiz (config'ten kalkmış) olanları ayıkla.
async function refreshAllDetails(): Promise<void> {
  if (!openDetails.length || !panel || !lastStopped) return;
  const cfg = loadConfig();
  const names = cfg ? new Set(extractSections(cfg).filter(s => isDetail(s.cfg)).map(s => s.name)) : new Set<string>();
  openDetails = openDetails.filter(d => names.has(d.section));
  for (const d of openDetails.slice()) await refreshDetail(d);
}

// Edit value sonrası: SADECE düzenlenen satırı yeniden çek (tüm bölüm/panel değil).
// array: ((cast)root)[i] (O(1)); linked_list: root(->next)^i (tek print, zincir GDB içinde).
// index_list/grouped/tree/walk -> kararlı O(1) satır ifadesi yok, bölüm yenile (fallback).
async function refreshRow(section: string, rowIndex: number | null) {
  if (!panel || !lastStopped) return;
  const cfg = loadConfig(); if (!cfg) return;
  const node = extractSections(cfg).find(s => s.name === section);
  if (!node) return;
  const scfg = node.cfg;
  if (rowIndex == null || rowIndex < 0 || isGrouped(scfg) || isMultiArray(scfg) || scfg.mode === 'index_list' || scfg.mode === 'tree' || scfg.mode === 'walk') { refreshTarget(section); return; }
  const rel = await gdbAcquire();   // tekil satır fetch'i de refresh / diğer işlemlerle iç içe geçmesin
  try {
  const session = lastStopped.session;
  const frameId = lastStopped.frameId;
  const eff = effectiveColumns(section, scfg.fields);
  const effFields = eff.active.map(l => scfg.fields.find(f => f.label === l)).filter((f): f is FieldCfg => !!f);
  let rawElem: string, access: string;
  if (scfg.mode === 'array') {
    const base = scfg.cast ? `((${scfg.cast})(${scfg.root}))` : `(${scfg.root})`;
    rawElem = `${base}[${rowIndex}]`;
    access = scfg.access ?? '.';
  } else {   // linked_list: root->next->...->next (rowIndex kez)
    let e = scfg.root; const nx = scfg.next ?? 'next';
    for (let k = 0; k < rowIndex; k++) e = e + '->' + nx;
    rawElem = e; access = '->';
  }
  const elem = scfg.wrap ? '(' + scfg.wrap.split('${expr}').join('(' + rawElem + ')') + ')' : rawElem;
  blobGuard = { off: false, decided: false, len: 0, resolved: 0 };   // tek-satır yenileme: bölüm dışı bayat blob kararı sızmasın
  const row = await collectRowFields(session, effFields, frameId, rawElem, elem, access, rawElem, elem, scfg.mode === 'array' ? rowIndex : undefined);   // ${index} sadece array'de (linked'de gerçek dizi index'i yok)
  log?.debug(`refreshRow: ${section}[${rowIndex}] -> ${Object.keys(row).filter(k => k.indexOf('__') !== 0).length} field(s)`);
  panel.webview.postMessage({ type: 'patchRow', section, rowIndex, row });
  } finally { rel(); }
}

// ---------------------------------------------------------------------------
// GDB ile konuşma
// ---------------------------------------------------------------------------
async function gdbExec(
  session: vscode.DebugSession,
  command: string,
  frameId?: number
): Promise<string> {
  try {
    const resp = await session.customRequest('evaluate', {
      expression: `-exec ${command}`,
      context: 'repl',
      frameId
    });
    const out = (resp?.result ?? '').toString();
    // #7: log kapalıysa (off) her sonuçta regex temizleme + hata-tespiti yapma (sıcak yol)
    if (logThreshold < LOG_LEVELS.off) {
      const clean = out.replace(/\s+/g, ' ').trim();
      log.debug(`gdb ▸ ${command}`);                 // hazırlanan erişim string'i
      log.trace(`gdb ◂ ${clean}`);                   // sonuç
      if (/no symbol|cannot|not (defined|available)|incomplete|error/i.test(clean))
        log.warn(`gdb access failed: ${command}  ⇒  ${clean}`);
    }
    return out;
  } catch (e: any) {
    log?.warn(`gdb access error: ${command}  ⇒  ${e?.message ?? e}`);
    return `<<error: ${e?.message ?? e}>>`;
  }
}

// "$N = VALUE" -> "VALUE"; "(gdb) " prompt gürültüsüne de dayanıklı
// Sabit boyutlu char dizileri: GDB sondaki NUL'lari da basar ("abc\000\000" veya
// "abc", '\000' <repeats N times>). Sadece ilk \000'a kadarini goster, gerisini at.
function trimCString(s: string): string {
  const t = s.trim();
  if (/^'\\000'(\s*<repeats\s+\d+\s+times>)?$/.test(t)) return '""';        // tamamen NUL -> bos
  const m = t.match(/^"((?:[^"\\]|\\.)*)"/);                                 // bastaki tirnakli string
  if (m) {
    const nul = m[1].indexOf('\\000');
    if (nul !== -1) return '"' + m[1].slice(0, nul) + '"';                   // ilk NUL'da kes
    if (t.length > m[0].length) return m[0];                                 // tirnak sonrasi <repeats>/NUL'lari at
  }
  return s;
}

function cleanValue(raw: string): string {
  let s = (raw ?? '').toString().trim();
  s = s.replace(/\(gdb\)\s*/g, ' ').trim();
  const m = s.match(/\$\d+\s*=\s*([\s\S]*)$/);
  if (m) s = m[1];
  return trimCString(s.trim());
}

function isNull(v: string): boolean {
  return v === '' || /\b0x0\b/.test(v);
}

// 'print/a' çıktısından sembolü çıkar. GDB bir kod adresini "0x.. <func+off>" diye etiketler;
// <...> içini döndür (örn "inspect_point+7"); sembol yoksa (çözülemeyen adres) ham değeri (adresi) döndür.
function symbolizeAddr(v: string): string {
  const m = (v ?? '').match(/<([^>]+)>/);
  return m ? m[1] : (v ?? '').trim();
}

// 'info line *(...)' çıktısından "dosya:satır" çıkar (symbolizeAddr'ın kardeşi; adres -> kaynak konumu).
// GDB çıktısı: 'Line 156 of "threads_demo.c" starts at address 0x.. <mk_thread> and ends at 0x.. <mk_thread+23>.'
// Satır bilgisi yoksa: 'No line number information available for address 0x..' -> boş döndür (hücre boş kalır).
// Dönen değer HAM gdbExec çıktısıdır (cleanValue UYGULANMAZ; bu çıktı "$N = ..." biçiminde değildir).
function fileLineOf(v: string): string {
  const m = (v ?? '').match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
  if (!m) return '';                                   // "No line number information" / hata -> boş
  const base = m[2].split(/[\\/]/).pop() || m[2];      // tam yol gelebilir -> HÜCREDE yalnız dosya adı göster
  return base + ':' + m[1];                            // "threads_demo.c:156"
}
// Aynı çıktıdan NAVİGASYON için GDB'nin verdiği TAM/relative yolu koru ("sub/threads_demo.c:156").
// GDB dosyayı DWARF'taki gibi (comp_dir'e göre relative, ya da mutlak) basar; basename'e indirgemek
// aynı adlı dosyalarda yanlış dosyayı açtırır -> tıklama hedefi için ham yolu saklarız.
function fileLinePath(v: string): string {
  const m = (v ?? '').match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
  return m ? m[2] + ':' + m[1] : '';
}
// GDB'nin verdiği dosya referansını (relative / cygwin-abs / windows-abs / basename) açılabilir adaylara çevir.
// SAF fonksiyon (fs/workspace erişimi YOK -> test edilebilir); dosyayı bulmak çağırana kalır.
function sourceRefCandidates(fileRef: string): { abs?: string; rel?: string; globs: string[]; base: string } {
  let f = (fileRef || '').trim();
  const cyg = f.match(/^\/cygdrive\/([A-Za-z])\/(.*)$/);   // /cygdrive/c/x/foo.c -> c:/x/foo.c (cppdbg cygwin gdb)
  if (cyg) f = cyg[1] + ':/' + cyg[2];
  f = f.replace(/\\/g, '/');                               // ayraçları normalle
  const isAbs = /^[A-Za-z]:\//.test(f) || f.startsWith('/');
  // yol bileşenleri; '.'/boş/'..' at (glob'da yukarı çıkılamaz; DWARF'taki fazladan ÖNEK zaten sonek denemesiyle atlanacak)
  const parts = f.split('/').filter(p => p && p !== '.' && p !== '..');
  const base = parts[parts.length - 1] || f;
  // SONEK glob'ları, en UZUNDAN en kısaya: "build/obj/src/foo.c" -> **/build/obj/src/foo.c, **/obj/src/foo.c, **/src/foo.c, **/foo.c
  // GDB yolunun BAŞINDA workspace'te olmayan fazladan bir dizin (build klasörü, proje/obj adı, prefix-map) olabilir;
  // en uzun eşleşen soneki alarak o öneki atlarız (ve en spesifik eşleşme aynı adlı dosyalarda doğruyu seçer).
  const seen = new Set<string>();
  const globs: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const g = '**/' + parts.slice(i).join('/');
    if (!seen.has(g)) { seen.add(g); globs.push(g); }
  }
  return { abs: isAbs ? f : undefined, rel: !isAbs ? parts.join('/') : undefined, globs, base };
}
// Çözülmüş kaynak yolları cache'i: GDB "yol" (satırsız) -> fsPath. Tekrar tıklama ANINDA açar (yeni tarama yok).
const sourceUriCache = new Map<string, string>();
// Aday dosya yollarından, GDB'nin verdiği yolla EN UZUN ortak soneki paylaşanı seç (aynı adlı dosyalarda en doğru).
// SAF fonksiyon (test edilebilir). Ortak sonek = sondan başa eşleşen yol bileşeni sayısı; büyük-küçük harf duyarsız.
function bestSuffixMatch(gdbPath: string, candidates: string[]): string | undefined {
  const g = gdbPath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean).reverse();
  let best: string | undefined, bestScore = -1;
  for (const c of candidates) {
    const parts = c.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean).reverse();
    let n = 0; while (n < g.length && n < parts.length && g[n] === parts[n]) n++;
    if (n > bestScore) { bestScore = n; best = c; }
  }
  return best;
}

// --- #5 per-element batch: bir elemanı TEK 'print' ile çekip alanları parse et ---
// Düz üye yolu mu? (sadece ad/iç-içe ad: "id", "link.idx"; ${expr}/cast/operatör/[i] DEĞİL)
function isPlainExpr(expr: string): boolean {
  return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test((expr ?? '').trim());
}
// GDB struct çıktısını derinlik/tırnak-duyarlı, üst-düzey virgülle böl
function splitTopLevel(s: string): string[] {
  const parts: string[] = []; let depth = 0, q = '', buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      buf += c;
      // kapanış tırnağı: önündeki ardışık \ TEK ise escape'li (kapanmaz), ÇİFT/0 ise gerçekten kapanır
      // ("C:\\" gibi ters-bölü ile biten string'ler doğru kapansın — trimCString ile aynı kaçış kuralı)
      if (c === q) { let n = 0; for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++; if (n % 2 === 0) q = ''; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; buf += c; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') parts.push(buf);
  return parts;
}
// "{a = 1, name = 0x.. \"x\", tag = \"ab\\000\", sub = {b = 2}}" -> { a:"1", name:'0x.. "x"', ... }
// (char dizisi gibi virgül içeren değerler, 'ad =' ile başlamayan parçalar öncekine eklenerek korunur)
function parseStruct(blob: string): Record<string, string> | null {
  if (!blob) return null;
  const a = blob.indexOf('{'); const b = blob.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  const parts = splitTopLevel(blob.slice(a + 1, b));
  const map: Record<string, string> = {}; let last: string | null = null;
  for (const p of parts) {
    const m = p.match(/^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);
    if (m) { map[m[1]] = m[2].trim(); last = m[1]; }
    // ANONİM üye (isimsiz union/struct: "{x = 2, y = 3}") -> önceki üyeyi BOZMA, atla. (Eskiden 'last'a eklenip
    // bir önceki alanı sessizce bozuyordu; o alan blob'dan yanlış okunup fallback de etmiyordu.) Bu alanlar zaten
    // ada göre adreslenmez; gösterilirse structMember miss -> hedefli 'print' fallback'i doğru değeri getirir.
    else if (/^\s*\{/.test(p)) { /* skip */ }
    else if (last) { map[last] += ',' + p; }   // virgüllü değerin GERÇEK devamı (char dizisi / <repeats>)
  }
  return map;
}
// parse edilmiş üst-düzey haritadan nokta'lı yolu çöz (iç-içe struct'a iner)
function structMember(map: Record<string, string> | null, path: string): string | undefined {
  if (!map) return undefined;
  const keys = path.split('.');
  let v: string | undefined = map[keys[0]];
  for (let i = 1; i < keys.length && v !== undefined; i++) {
    const nm = parseStruct(v); if (!nm) return undefined; v = nm[keys[i]];
  }
  return v;
}
// PERF: 'when' koşulunu, zaten çekilmiş struct blob'undan değerlendirmeyi dene (satır başına ayrı 'print' yerine).
// Yalnız GÜVENLİ alt küme: (a) çıplak üye "locked" -> condTrue(blob.locked); (b) "${expr}.locked == 0" gibi
// üye-vs-TAMSAYI-SABİTİ karşılaştırması (üye düz ondalık int ise). Çözülemezse undefined -> çağıran GDB'ye düşer.
function evalWhenFromBlob(whenExpr: string, parsed: Record<string, string> | null): boolean | undefined {
  if (!parsed) return undefined;
  const w = (whenExpr ?? '').trim();
  // (a) çıplak düz üye (ad / iç-içe ad) -> truthiness (int/enum/0x0 hepsi condTrue ile GDB ile aynı sonucu verir)
  if (isPlainExpr(w)) {
    const m = structMember(parsed, w);
    return m === undefined ? undefined : condTrue(cleanValue(m));
  }
  // (b) ${expr}.üye / ${expr}->üye / çıplak üye  <op>  <tamsayı sabiti>
  const cmp = w.match(/^(?:\$\{expr\}(?:\.|->))?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(==|!=|<=|>=|<|>)\s*(-?\d+)$/);
  if (cmp) {
    const m = structMember(parsed, cmp[1]);
    if (m === undefined) return undefined;
    const lhsRaw = cleanValue(m).trim();
    if (!/^-?\d+$/.test(lhsRaw)) return undefined;   // hex/pointer/enum-adı -> GDB'ye düş (yanlış yorumlama riski yok)
    const lhs = parseInt(lhsRaw, 10), rhs = parseInt(cmp[3], 10);
    switch (cmp[2]) {
      case '==': return lhs === rhs;
      case '!=': return lhs !== rhs;
      case '<':  return lhs < rhs;
      case '>':  return lhs > rhs;
      case '<=': return lhs <= rhs;
      case '>=': return lhs >= rhs;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PERF sayaçları — kaydedilen GDB round-trip'lerini logla (GDB seri olduğundan aynı anda tek bölüm
// kurulur -> modül düzeyi sayaç güvenli). Bölüm başında sıfırla, sonunda debug; yenileme sonunda info.
// ---------------------------------------------------------------------------
const perf = { fieldsFromBlob: 0, blobPrints: 0, whenFromBlob: 0, barFromBlob: 0 };
let perfRefreshSaved = 0;
function perfSectionStart() { perf.fieldsFromBlob = 0; perf.blobPrints = 0; perf.whenFromBlob = 0; perf.barFromBlob = 0; }
function perfSectionEnd(name: string) {
  // tasarruf = (blob'dan okunan düz alan) - (blob print sayısı) + when-from-blob + bar-from-blob
  const saved = Math.max(0, perf.fieldsFromBlob - perf.blobPrints) + perf.whenFromBlob + perf.barFromBlob;
  if (saved > 0) {
    perfRefreshSaved += saved;
    log.debug(`perf "${name}": ~${saved} fewer GDB round-trip(s) — blob-batched ${perf.fieldsFromBlob} field(s) via ${perf.blobPrints} blob print(s), ${perf.whenFromBlob} when-from-blob, ${perf.barFromBlob} bar-max-from-blob`);
  }
}

// "Tüm elemanı çek + parse et" (blob) yöntemi GENİŞ struct'larda zarara döner: gösterilmeyen bir büyük dizi
// blob'u devasa yapar; GDB tüm struct'ı (yavaş hatta tüm baytları) okuyup biçimler. Ölçüm: id+name gösterilen
// data[1024]'lük bir struct'ta blob ~34x daha yavaş (2.4ms vs 0.07ms/satır, yerelde). Bu yüzden UYARLAMALI:
// bölümün ilk satırında blob'u dene; KULLANILAN alan başına çok fazla karakter taşıyorsa (yani çoğu boşa),
// kalan satırlarda blob'u kapat → hedefli oku. Hata-payı bağımsız: oran "ne kadarını boşa taşıdığını" ölçer.
const BLOB_CHARS_PER_FIELD_MAX = 200;   // blob uzunluğu / blob'dan çözülen alan sayısı bu eşiği aşarsa blob kapatılır
function blobTooLarge(blobLen: number, resolved: number): boolean {
  return resolved <= 0 ? true : (blobLen / resolved) > BLOB_CHARS_PER_FIELD_MAX;
}
// Bölüm boyu blob kararı (GDB seri -> modül düzeyi güvenli). collectSection başında sıfırlanır; ilk satırda karar verilir.
let blobGuard = { off: false, decided: false, len: 0, resolved: 0 };

// Bir satırın alanlarını topla. #5: >=2 düz-üye alan varsa elemanı TEK 'print' ile çekip
// parse eder (eşleşmezse alan-alan fallback). when/wrap/bar/${expr}/computed alanlar her zaman alan-alan.
async function collectRowFields(
  session: vscode.DebugSession, fields: FieldCfg[], frameId: number | undefined,
  rawElem: string, wrapElem: string, access: string,
  editRaw: string = rawElem, editWrap: string = wrapElem,   // __edit__ l-value için KARARLI eleman (linked'de cursor değil root->next^i)
  index?: number,   // ${index}: array subscript / index_list slot subscript (linked/tree/walk'ta YOK) -> expr/wrap/when/bar içinde her yerde çözülür
  depth?: number,   // ağaç derinliği (kök=0) -> ${depth} (yalnız tree modunda anlamlı)
  master?: string,   // gruplu/nested_array bölümde master (parent) eleman ifadesi -> ${master}
  masterIdx?: string,   // master'ın subscript'i -> ${master_index} + __midx__ (nested_array; grouped'da groupBy hedefi array/index_list ise)
  outer?: string,    // nested_array (>=3 seviye): DIŞ (1. seviye) eleman ifadesi -> ${outer}
  outerIdx?: string,  // nested_array (>=3 seviye): DIŞ subscript -> ${outer_index} + __oidx__
  extraVars?: Record<string, string>   // nested_array İSİMLİ token'lar: '${<ad>}' -> değer (eleman parantezli, index çıplak); uzun anahtar önce değiştirilir
): Promise<Row> {
  // wrap içindeki ${index}/${depth}/${master}/${master_index}/${outer}/${outer_index} (resolveFieldExpr expr'i zaten çözer)
  const subVars = (s: string) => { let r = s; if (extraVars) for (const k2 of Object.keys(extraVars).sort((x, y) => y.length - x.length)) r = r.split('${' + k2 + '}').join(extraVars[k2]); if (masterIdx != null) r = r.split('${master_index}').join(masterIdx); if (master != null) r = r.split('${master}').join('(' + master + ')'); if (outerIdx != null) r = r.split('${outer_index}').join(outerIdx); if (outer != null) r = r.split('${outer}').join('(' + outer + ')'); if (index != null) r = r.split('${index}').join(String(index)); if (depth != null) r = r.split('${depth}').join(String(depth)); return r; };
  const row: Row = {};
  row['__el__'] = editWrap;   // satırın KARARLI eleman ifadesi -> "watch ifadesi olarak kopyala" (tüm modlarda geçerli)
  if (index != null) row['__idx__'] = String(index);   // array subscript / index_list slot index -> selectedFrom detayında ${selected_index} (yalnız bu modlarda dolu)
  if (masterIdx != null) row['__midx__'] = masterIdx;   // master'ın subscript'i -> ${selected_master_index}
  if (outerIdx != null) row['__oidx__'] = outerIdx;   // DIŞ subscript (nested_array >=3 seviye) -> ${selected_outer_index}
  let parsed: Record<string, string> | null = null;
  let blobLen = 0, blobResolved = 0;
  const plainCount = fields.filter(f => isPlainExpr(f.expr) && !f.wrap && !f.symbol && !f.sourceLine).length;   // symbol/sourceLine alanı ayrı komut ister (print/a, info line) -> batch dışı
  if (plainCount >= 2 && !blobGuard.off) {   // blobGuard.off: bu bölümde blob GENİŞ bulundu -> hedefliye düşüldü
    const blobExpr = access === '->' ? `*(${wrapElem})` : `(${wrapElem})`;
    const raw = (await gdbExec(session, `print ${blobExpr}`, frameId)).toString();
    blobLen = raw.length;
    parsed = parseStruct(raw);
    perf.blobPrints++;
  }
  for (const f of fields) {
    if (f.when) {
      // PERF: önce blob'dan çöz (çıplak üye / üye-vs-int); çözülemezse ayrı 'print' (eski yol)
      let wv = evalWhenFromBlob(f.when, parsed);
      if (wv === undefined) wv = condTrue(cleanValue(await gdbExec(session, `print ${resolveFieldExpr(f.when, rawElem, wrapElem, access, index, depth, master, masterIdx, outer, outerIdx, extraVars)}`, frameId)));
      else perf.whenFromBlob++;   // blob'dan çözüldü -> ayrı 'print' yok
      if (!wv) { row[f.label] = ''; continue; }
    }
    let accExpr = resolveFieldExpr(f.expr, rawElem, wrapElem, access, index, depth, master, masterIdx, outer, outerIdx, extraVars);
    if (f.wrap) accExpr = subVars(f.wrap.split('${expr}').join('(' + accExpr + ')'));
    let val: string | undefined;
    if (parsed && !f.wrap && !f.symbol && !f.sourceLine && isPlainExpr(f.expr)) {
      const m = structMember(parsed, f.expr);
      if (m !== undefined) { val = cleanValue(m); perf.fieldsFromBlob++; blobResolved++; }   // batch'ten (ayrı 'print' yok)
    }
    if (val === undefined) {
      if (f.symbol) val = symbolizeAddr(cleanValue(await gdbExec(session, `print/a ${accExpr}`, frameId)));   // adres -> 'func+off' sembolü
      else if (f.sourceLine) {
        const ilOut = await gdbExec(session, `info line *(${accExpr})`, frameId);   // adres -> kaynak konumu (ham çıktı; cleanValue YOK)
        val = fileLineOf(ilOut);                                                    // HÜCRE: "dosya:satır" (yalnız dosya adı)
        const full = fileLinePath(ilOut);                                           // NAVİGASYON: GDB'nin TAM/relative yolu "yol:satır"
        if (full && full !== val) row['__src__' + f.label] = full;                  // yol basename'den farklıysa yan-kanalda taşı (doğru dosya)
      }
      else val = cleanValue(await gdbExec(session, `print ${accExpr}`, frameId));   // fallback
    }
    row[f.label] = val;
    if (f.editable) {
      // __edit__ KARARLI eleman üzerinden (geçici cursor değil) -> set var gerçek alanı değiştirir
      let editExpr = resolveFieldExpr(f.expr, editRaw, editWrap, access, index, depth, master, masterIdx, outer, outerIdx, extraVars);
      if (f.wrap) editExpr = subVars(f.wrap.split('${expr}').join('(' + editExpr + ')'));
      row['__edit__' + f.label] = editExpr;
    }
    // __lv__ = düz üye alanının KARARLI l-value'su (watchpoint hedefi: 'watch <lvalue>'). Sadece düz üye (computed/wrap değil).
    if (isPlainExpr(f.expr) && !f.wrap && !f.symbol && !f.sourceLine) row['__lv__' + f.label] = resolveFieldExpr(f.expr, editRaw, editWrap, access, index, depth, master, masterIdx, outer, outerIdx, extraVars);
    if (f.bar) {
      const mx = barMaxExpr(f);
      if (mx) {
        let bv: string | undefined;
        if (/^\d+$/.test(mx)) bv = mx;   // sabit max
        // PERF: bar max düz bir üye ise (örn stack_size) zaten çekilmiş struct blob'undan oku -> satır başına ekstra 'print' turu YOK
        else if (parsed && isPlainExpr(mx)) { const pm = structMember(parsed, mx); if (pm !== undefined) { bv = cleanValue(pm); perf.barFromBlob++; } }
        if (bv === undefined) bv = cleanValue(await gdbExec(session, `print ${resolveFieldExpr(mx, rawElem, wrapElem, access, index, depth, master, masterIdx, outer, outerIdx, extraVars)}`, frameId));
        row['__bar__' + f.label] = bv;
      }
    }
  }
  // UYARLAMALI blob kararı: ilk blob'lu satırda, taşınan karakter / kullanılan alan oranı yüksekse (geniş struct,
  // çoğu boşa) kalan satırlarda blob'u kapat -> hedefli oku. Bir kez karar verilir, bölüm sonuna kadar geçerli.
  if (blobLen > 0 && !blobGuard.decided) {
    blobGuard.decided = true;
    if (blobTooLarge(blobLen, blobResolved)) {
      blobGuard.off = true; blobGuard.len = blobLen; blobGuard.resolved = blobResolved;
      log.debug(`perf: blob too wide (${blobLen} chars / ${blobResolved} field(s) used per row) → targeted reads for this section's remaining rows`);
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// "Create starter" ile yazılan asgari örnek config (yeni kullanıcı boş başlamasın)
const STARTER_CONFIG = `{
  "//": "Debug Inspector config — her veri yapısını burada tanımla. Tüm seçenekler için README'ye bak.",
  "example": {
    "mode": "array",
    "root": "g_my_array",
    "count": "g_my_count",
    "access": ".",
    "fields": [
      { "label": "ID",   "expr": "id" },
      { "label": "Name", "expr": "name" }
    ]
  }
}
`;
// configPath mutlaksa doğrudan; göreliyse workspace köküne göre çözülür
function configFilePath(): string | undefined {
  const rel: string =
    vscode.workspace.getConfiguration('debugInspector').get('configPath') ?? 'debug-inspector.json';
  if (path.isAbsolute(rel)) return rel;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return path.join(folder.uri.fsPath, rel);
}

function loadConfig(): SyncCfg | undefined {
  const file = configFilePath();
  if (!file) return undefined;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw = JSON.parse(text) as SyncCfg;
    // HAM config'ten arch etiketlerini keşfet (panelin arch seçicisi bunu listeler) — çözümden
    // ÖNCE yapılmalı, çünkü çözüm aktif olmayan arch bloklarını düşürür.
    availableArchs = discoverArchs(raw);
    // Arch overlay: 'common' + etkin arch çözülür. Sonuç DÜZ config -> extractSections ve
    // gerisi hiç değişmeden çalışır.
    const arch = activeArch();
    log?.debug(`config loaded: ${file} (arch="${arch}", available=[${availableArchs.join(', ') || '-'}])`);
    return applyArchOverlay(raw, arch);
  } catch (e: any) {
    log?.warn(`could not read/parse config: ${file} — ${e?.message ?? e}`);
    vscode.window.showWarningMessage(`Debug Inspector: could not read config (${file})`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bir bölümü (thread / semaphore) topla — config-driven, generic
// ---------------------------------------------------------------------------
async function collectSection(
  session: vscode.DebugSession,
  cfg: SectionCfg,
  frameId: number | undefined,
  cursor: string,
  name: string = '',
  isStale?: () => boolean,   // iptal kancası: continue/yeni durak gelince satır döngüsünü erken bırak (çalışan hedefe print atma)
  masterExpr?: string,   // gruplu/nested_array bölümde bu grubun master (parent) eleman ifadesi -> field expr'lerinde ${master}
  masterIdx?: string,    // master'ın subscript'i -> ${master_index} + __midx__ (nested_array; grouped'da master array/index_list ise)
  outerExpr?: string,    // nested_array (>=3 seviye): DIŞ eleman ifadesi -> ${outer}
  outerIdx?: string,     // nested_array (>=3 seviye): DIŞ subscript -> ${outer_index} + __oidx__
  extraVars?: Record<string, string>,   // İSİMLİ seviye token'ları (nested_array): '${<ad>}' -> değer (eleman ifadesi parantezli / index çıplak)
  rowName?: string,      // nested_array: SATIR seviyesinin adı -> her satırda ${<ad>} = eleman, ${<ad>_index} = i
  onProgress?: (rows: Row[]) => void   // satır akışı: satırlar biriktikçe (throttle'lı) çağrılır -> webview kısmi tabloyu çizer
): Promise<Row[]> {
  const rows: Row[] = [];
  if ((cfg.mode as string) === 'nested_array') {   // nested_array buildArrayNd ile kurulur; buraya düşmesi = groupBy master / düz bölüm yanlış kullanımı
    log?.warn(`"${name}": nested_array bölüm groupBy master'ı olarak ya da düz bölüm gibi kullanılamaz`);
    return rows;
  }
  const max = cfg.max ?? 1024;
  blobGuard = { off: false, decided: false, len: 0, resolved: 0 };   // bölüm başı: blob kararını sıfırla (ilk satırda yeniden verilir)
  // Akış: her satırdan sonra, en çok ~her STREAM_MS bir kez, o ana kadarki satırları yayınla (postMessage selini önler).
  let lastEmit = 0;
  const emit = () => { if (!onProgress || !rows.length) return; const now = Date.now(); if (now - lastEmit >= 80) { lastEmit = now; onProgress(rows); } };

  if (cfg.mode === 'array') {
    const access = cfg.access ?? '.';
    // cast verilirse void*/generic buffer cast edilir (cast'i tam yaz, örn "widget_t *"): ((cast)(root))[i]
    const base = cfg.cast ? `((${cfg.cast})(${cfg.root}))` : `(${cfg.root})`;
    const countRaw = await gdbExec(session, `print ${cfg.count}`, frameId);
    const count = parseInt(cleanValue(countRaw), 10) || 0;
    log.debug(`array "${name}": count(${cfg.count})="${cleanValue(countRaw)}" → ${count}; element = ${base}[i]${access}<field>, access="${access}"`);
    for (let i = 0; i < Math.min(count, max); i++) {
      if (isStale && isStale()) break;   // continue/yeni durak -> çalışan hedefe print atma, erken bırak
      // eleman: ((cast*)root)[i]; field'a erişmeden ÖNCE wrap ile sarmalanır
      const elemRaw = `${base}[${i}]`;
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + elemRaw + ')') + ')' : elemRaw; // (wrap)<access>field
      // isimli SATIR token'ı (nested_array): ${<rowName>} = bu satırın elemanı, ${<rowName>_index} = i
      const rowVars = rowName ? { ...(extraVars || {}), [rowName]: '(' + elem + ')', [rowName + '_index']: String(i) } : extraVars;   // eleman WRAPPED haliyle (grup token'ları ve ${master} ile tutarlı)
      rows.push(await collectRowFields(session, cfg.fields, frameId, elemRaw, elem, access, elemRaw, elem, i, undefined, masterExpr, masterIdx, outerExpr, outerIdx, rowVars));   // ${index} = i (dizi index'i)
      emit();
    }
  } else if (cfg.mode === 'index_list') {
    // Dizi içinde index ile bağlı liste: head index'inden başla, next alanı sonraki index'i verir
    const access = cfg.access ?? '.';
    const base = cfg.cast ? `((${cfg.cast})(${cfg.root}))` : `(${cfg.root})`;
    const toI = (s: string): number => {
      const t = (s ?? '').trim();
      if (!t) return NaN;
      const n = Number(t);
      if (Number.isFinite(n)) return n;
      const m = t.match(/-?\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    };
    const nilNum = toI(cfg.nil ?? '-1');
    const headRaw = cleanValue(await gdbExec(session, `print ${cfg.head}`, frameId));
    let idx = toI(headRaw);
    log.debug(`index_list "${name}": head(${cfg.head})="${headRaw}" → idx ${idx}; element = ${base}[idx], next via ${base}[idx]${access}${cfg.next}, nil=${nilNum}`);
    const seen: Record<number, boolean> = {};
    let guard = 0;
    let reason = 'end';
    while (true) {
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
      if (guard++ >= max) { reason = `max bound (${max})`; break; }
      if (!Number.isFinite(idx)) { reason = 'non-numeric index'; break; }
      if (idx === nilNum) { reason = `reached nil (${nilNum})`; break; }
      if (seen[idx]) { reason = `cycle (idx ${idx} already visited)`; break; }
      seen[idx] = true;
      const fromIdx = idx;
      // ham eleman: ${expr} HEM wrap HEM next şablonunda AYNI bunu görür
      const elemRaw = `${base}[${idx}]`;
      // field'a erişmeden ÖNCE wrap ile sarmalanır (çıktı parantezlenir: (wrap)<access>field)
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + elemRaw + ')') + ')' : elemRaw;
      rows.push(await collectRowFields(session, cfg.fields, frameId, elemRaw, elem, access, elemRaw, elem, fromIdx, undefined, masterExpr, masterIdx, outerExpr, outerIdx, extraVars));   // ${index} = bu slotun dizi index'i
      emit();
      // next şablonu: ${expr}=ham eleman (wrap ile aynı), ${wrapped_expr}=wrap/cast'li eleman; yoksa elem<access>next
      const hasTpl = cfg.next && (cfg.next.indexOf('${expr}') !== -1 || cfg.next.indexOf('${wrapped_expr}') !== -1);
      const nextExpr = hasTpl
        ? cfg.next.split('${wrapped_expr}').join('(' + elem + ')').split('${expr}').join('(' + elemRaw + ')')
        : `${elem}${access}${cfg.next}`;
      const nxRaw = cleanValue(await gdbExec(session, `print ${nextExpr}`, frameId));
      idx = toI(nxRaw);
      log.trace(`index_list "${name}" step ${guard - 1}: idx ${fromIdx} → next [ ${nextExpr} ] = "${nxRaw}" → idx ${idx}`);
    }
    log.debug(`index_list "${name}": ${rows.length} row(s); stopped: ${reason}`);
  } else if (cfg.mode === 'tree') {
    // ağaç: kök + çocuk pointer alanları (varsayılan left/right) — BFS; her satır __parent__ (flat index) taşır.
    const childFields = (Array.isArray(cfg.children) && cfg.children.length) ? cfg.children : ['left', 'right'];
    const queue: { expr: string; parent: number; depth: number }[] = [{ expr: cfg.root, parent: -1, depth: 0 }];
    const seen: Record<string, boolean> = {};   // adres -> döngü koruması
    let reason = 'end';
    log.debug(`tree "${name}": root=${cfg.root}, children=[${childFields.join(', ')}], access="->"`);
    while (queue.length) {
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
      if (rows.length >= max) { reason = `max bound (${max})`; break; }
      const node = queue.shift()!;
      const curRaw = cleanValue(await gdbExec(session, `print ${node.expr}`, frameId));
      // NULL veya OKUNAMAZ (hatalı/eksik child alanı, dangling pointer) -> alt-ağacı sonlandır (sahte satır + sonsuz fan-out olmasın)
      if (isNull(curRaw) || /^<<error|no symbol|cannot access memory|<error reading|there is no member|value (has been )?optimized out/i.test(curRaw)) continue;
      const am = curRaw.match(/0x[0-9a-fA-F]+/);
      const key = am ? am[0] : node.expr;
      if (key !== '0x0' && seen[key]) continue;   // aynı düğüm tekrar -> döngü, atla
      seen[key] = true;
      // elemana erişmeden ÖNCE wrap; kararlı yol ifadesi (root->left->right...) edit/watch için
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + node.expr + ')') + ')' : node.expr;
      const myIdx = rows.length;
      const row = await collectRowFields(session, cfg.fields, frameId, node.expr, elem, '->', node.expr, elem, undefined, node.depth, masterExpr, masterIdx, outerExpr, outerIdx, extraVars);   // ağaçta ${index} YOK (gerçek dizi index'i değil); ${depth} = derinlik (kök=0); ${master} grouped ağaçta geçerli
      row['__parent__'] = node.parent < 0 ? '' : String(node.parent);
      rows.push(row);
      emit();
      for (const cf of childFields) queue.push({ expr: `${node.expr}->${cf}`, parent: myIdx, depth: node.depth + 1 });
      log.trace(`tree "${name}" node ${myIdx} (parent ${node.parent}): ${node.expr} = ${curRaw}`);
    }
    log.debug(`tree "${name}": ${rows.length} node(s); stopped: ${reason}`);
  } else if (cfg.mode === 'walk') {
    // KOŞULLU geri-sarma (örn. FP-zinciri callstack): kürsör 'start'tan başlar; 'while' (boolean ${expr}) doğru
    // oldukça satır üretir; 'next' (${expr} -> sonraki kürsör) ile ilerler. ${expr} = o anki kürsör DEĞERİ (adres).
    const startExpr = cfg.start ?? cfg.root;
    const access = cfg.access ?? '.';   // ${wrapped_expr}/varsayılan alan yolunda kullanılır
    // cast (örn "frame_t *") önce kürsöre, sonra wrap uygulanır -> ${wrapped_expr}. cast/wrap yoksa ham kürsör.
    const wrapCur = (cur: string): string => {
      const c = cfg.cast ? '((' + cfg.cast + ')(' + cur + '))' : cur;
      return cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + c + ')') + ')' : c;
    };
    // next/while/alan şablonları: ${wrapped_expr}=cast+wrap'li kürsör, ${expr}=HAM kürsör değeri (önce uzun token).
    const subC = (tpl: string, cur: string): string =>
      tpl.split('${wrapped_expr}').join('(' + wrapCur(cur) + ')').split('${expr}').join('(' + cur + ')');
    const badCur = (v: string): boolean => isNull(v) || /^<<error|no symbol|cannot access memory|<error reading|value (has been )?optimized out/i.test(v);
    let cur = cleanValue(await gdbExec(session, `print ${startExpr}`, frameId));
    // KARARLI sembolik eleman (canlı kürsör ADRESİ değil): 'start'a 'next' şablonu i kez uygulanmış, her durakta
    // yeniden değerlendirilebilir ifade — linked_list'in root(->next)^i karşılığı. __el__/__edit__/__lv__ + master
    // selExpr (groupBy / selectedFrom ${selected}) BUNU kullanır; canlı 'cur' yalnız hızlı alan okuması için.
    // subC ham ifade üzerinde de çalışır: sembolik ifadeyi verince sonraki KARARLI ifadeyi üretir (değer yerine ifade).
    let sRaw = startExpr;
    const seenW: Record<string, boolean> = {};
    let guard = 0, reason = 'end';
    log.debug(`walk "${name}": start(${startExpr})="${cur}", next=${cfg.next}, while=${cfg.while}`);
    while (true) {
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
      if (guard++ >= max) { reason = `max bound (${max})`; break; }
      if (badCur(cur)) { reason = 'unreadable/NULL cursor'; break; }
      if (cfg.while && !condTrue(cleanValue(await gdbExec(session, `print ${subC(cfg.while, cur)}`, frameId)))) { reason = 'while=false (out of bounds)'; break; }
      if (seenW[cur]) { reason = `cycle (cursor ${cur} repeats)`; break; }
      seenW[cur] = true;
      // satır: ${expr}=HAM kürsör DEĞERİ (next/while ile aynı; aritmetik için bozulmaz), ${wrapped_expr}=cast+wrap'li
      // kürsör. Böylece array/linked gibi walk'ta da cast/wrap/${wrapped_expr} geçerli (eskiden sessizce yok sayılırdı).
      // editRaw/editWrap = KARARLI sembolik eleman (sRaw); master selExpr ve "watch ifadesi kopyala" donmuş adres almasın.
      // masterExpr de geçilir -> walk-as-grouped-child alanlarında ${master} çözülür (eskiden geçilmiyordu).
      rows.push(await collectRowFields(session, cfg.fields, frameId, cur, wrapCur(cur), access, sRaw, wrapCur(sRaw), undefined, undefined, masterExpr, masterIdx, outerExpr, outerIdx, extraVars));
      emit();
      if (!cfg.next) { reason = 'no next'; break; }
      const nxw = cleanValue(await gdbExec(session, `print ${subC(cfg.next, cur)}`, frameId));
      log.trace(`walk "${name}" frame ${guard - 1}: cursor=${cur} → next [ ${subC(cfg.next, cur)} ] = "${nxw}"`);
      if (nxw === cur) { reason = 'no progress'; break; }
      cur = nxw;
      sRaw = subC(cfg.next, sRaw);   // sembolik ilerleme: canlı kürsörle AYNI 'next' şablonu, ham KARARLI ifade üzerinde
    }
    log.debug(`walk "${name}": ${rows.length} frame(s); stopped: ${reason}`);
  } else {
    log.debug(`linked_list "${name}": root=${cfg.root}, advance via cursor->${cfg.next}, access="->"`);
    let guard = 0;
    let reason = 'end';
    const nx = cfg.next ?? 'next';
    const needStable = true;   // kararlı zincir (root->next^i): edit l-value VE 'watch ifadesi kopyala' için her satırda gerekli
    const seenL: Record<string, boolean> = {};   // adres -> görüldü: DÖNGÜ koruması (dairesel/bozuk liste max'a kadar sürünmesin; walk/tree'de vardı, linked'de eksikti)
    // #2: cursor=root + ilk değer (null-check) TEK çağrıda; düğüm başına ayrı 'print cursor' turu yok
    let cur = cleanValue(await gdbExec(session, `print ${cursor} = ${cfg.root}`, frameId));
    while (true) {
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
      if (guard++ >= max) { reason = `max bound (${max})`; break; }
      if (isNull(cur)) { reason = 'reached NULL'; break; }
      const amL = cur.match(/0x[0-9a-fA-F]+/);   // düğüm adresi (değer '(T *) 0x.. <sym>' biçiminde)
      if (amL) { if (seenL[amL[0]]) { reason = `cycle (node ${amL[0]} repeats)`; break; } seenL[amL[0]] = true; }
      // node (cursor); field'a erişmeden ÖNCE wrap ile sarmalanır
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + cursor + ')') + ')' : cursor; // (wrap)->field
      // KARARLI eleman (cursor'a bağlı değil): root(->next)^index — edit sonrası set var doğru alana yazsın
      let sRaw = cursor, sElem = elem;
      if (needStable) {
        sRaw = cfg.root; for (let k = 0; k < rows.length; k++) sRaw = sRaw + '->' + nx;
        sElem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + sRaw + ')') + ')' : sRaw;
      }
      rows.push(await collectRowFields(session, cfg.fields, frameId, cursor, elem, '->', sRaw, sElem, undefined, undefined, masterExpr, masterIdx, outerExpr, outerIdx, extraVars));   // linked_list'te ${index} YOK; ${master} grouped'da geçerli
      emit();
      log.trace(`linked_list "${name}" node ${guard - 1}: cursor=${cur} → advance via ${cursor}->${cfg.next}`);
      // #2: advance + sonraki değeri (null-check) TEK çağrıda — eski 'set' + ayrı 'print cursor' yerine
      cur = cleanValue(await gdbExec(session, `print ${cursor} = ${cursor}->${cfg.next}`, frameId));
    }
    log.debug(`linked_list "${name}": ${rows.length} row(s); stopped: ${reason}`);
  }
  return rows;
}

function num(v: string): number {
  const m = (v ?? '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

// Generic özet: satır sayısı + (varsa) State/Count/Waiting kolonlarından çıkarımlar
function summarize(name: string, rows: Row[]): string {
  const parts = [`${rows.length} ${name}`];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  if (cols.indexOf('State') !== -1) {
    const running = rows.filter(r => /run/i.test(r['State'] ?? '')).length;
    if (running) parts.push(`${running} running`);
  }
  if (cols.indexOf('Count') !== -1) {
    const depleted = rows.filter(r => num(r['Count']) === 0).length;
    if (depleted) parts.push(`${depleted} depleted`);
  }
  if (cols.indexOf('Waiting') !== -1) {
    const waiters = rows.filter(r => num(r['Waiting']) > 0).length;
    if (waiters) parts.push(`${waiters} with waiters`);
  }
  return parts.join(' · ');
}

// Config'teki bölümleri (sıra korunarak) çıkar; yorum/anahtar dışı girdileri atla
function extractSections(cfg: SyncCfg): Array<{ name: string; cfg: SectionCfg }> {
  const out: Array<{ name: string; cfg: SectionCfg }> = [];
  if (!cfg || typeof cfg !== 'object') return out;
  for (const key of Object.keys(cfg)) {
    if (key.startsWith('//')) continue; // yorum anahtarlarını atla
    const v = (cfg as any)[key];
    if (v && typeof v === 'object' && Array.isArray(v.fields) && typeof v.mode === 'string') {
      out.push({ name: key, cfg: v as SectionCfg });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sütun tercihleri: kayıtlı sıra/gizli + config alanlarını birleştir
// ---------------------------------------------------------------------------
function effectiveColumns(section: string, fields: FieldCfg[]): { order: string[]; hidden: string[]; active: string[] } {
  const allLabels = fields.map(f => f.label);
  const pref = columnPrefs[section];
  let order: string[];
  let hidden: string[];
  if (pref && Array.isArray(pref.order) && pref.order.length) {
    order = pref.order.filter(l => allLabels.includes(l));
    for (const l of allLabels) if (!order.includes(l)) order.push(l); // config'e yeni eklenenler sona, görünür
    hidden = (pref.hidden ?? []).filter(l => allLabels.includes(l));
  } else {
    order = allLabels.slice();
    hidden = fields.filter(f => f.hidden).map(f => f.label);   // config: "hidden": true olan alanlar başlangıçta gizli
  }
  const active = order.filter(l => !hidden.includes(l));
  return { order, hidden, active };
}

// Kolon -> config sayı tabanı (dec/hex/bin); field.base verilmişse
function fieldBases(fields: FieldCfg[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of fields) if (f.base) m[f.label] = f.base;
  return m;
}
// Kullanım çubuğu: max ifadesi + eşikler
function barMaxExpr(f: FieldCfg): string {
  if (!f.bar) return '';
  return (typeof f.bar === 'string' ? f.bar : (f.bar.max ?? '')) || '';
}
// Alan/bar ifadesini GDB print ifadesine çevir. ${expr}=ham eleman, ${wrapped_expr}=wrap/cast'li eleman
// (wrap/next ile AYNI semantik) -> elemanı birden çok kez referanslayan aritmetik (örn stack_top - stack_base) mümkün.
// Yer tutucu yoksa varsayılan: (wrap'li eleman)<access><ifade>.
function resolveFieldExpr(expr: string, rawElem: string, wrappedElem: string, access: string, index?: number, depth?: number, master?: string, masterIdx?: string, outer?: string, outerIdx?: string, extraVars?: Record<string, string>): string {
  const hasIdx = index != null && expr.indexOf('${index}') !== -1;
  const hasDepth = depth != null && expr.indexOf('${depth}') !== -1;
  const hasMaster = master != null && expr.indexOf('${master}') !== -1;
  const hasMasterIdx = masterIdx != null && expr.indexOf('${master_index}') !== -1;
  const hasOuter = outer != null && expr.indexOf('${outer}') !== -1;
  const hasOuterIdx = outerIdx != null && expr.indexOf('${outer_index}') !== -1;
  // İSİMLİ seviye token'ları (nested_array): expr'de geçen '${<ad>}' anahtarları (uzun anahtar önce -> alt-dizgi çakışması olmaz)
  const evKeys = extraVars ? Object.keys(extraVars).filter(k2 => expr.indexOf('${' + k2 + '}') !== -1).sort((x, y) => y.length - x.length) : [];
  // ${expr}/${wrapped_expr}/${index}/${depth}/${master}/${master_index} -> STANDALONE ifade (elemana eklenmez).
  // ${index} = dizi index'i (array) / slot index'i (index_list) / SATIR subscript'i (nested_array); linked/tree/walk'ta YOK;
  // ${depth} = ağaç derinliği (kök=0); ${master} = satırın AİT OLDUĞU master/dış eleman (erişimi kullanıcı yazar);
  // ${master_index} = master'ın subscript'i (nested_array parent index; grouped'da groupBy hedefi array/index_list ise).
  // Not: '${master}' ile '${master_index}' substring ÇAKIŞMAZ ('master}' vs 'master_') -> sıra önemsiz.
  if (expr.indexOf('${expr}') !== -1 || expr.indexOf('${wrapped_expr}') !== -1 || hasIdx || hasDepth || hasMaster || hasMasterIdx || hasOuter || hasOuterIdx || evKeys.length) {
    let e = expr.split('${wrapped_expr}').join('(' + wrappedElem + ')').split('${expr}').join('(' + rawElem + ')');
    for (const k2 of evKeys) e = e.split('${' + k2 + '}').join(extraVars![k2]);
    if (masterIdx != null) e = e.split('${master_index}').join(masterIdx);
    if (master != null) e = e.split('${master}').join('(' + master + ')');
    if (outerIdx != null) e = e.split('${outer_index}').join(outerIdx);   // nested_array DIŞ subscript — SATIR ANINDA çözülür (ön-yerleştirme değil: token'sız kalan ifade elemana eklenirdi -> ".0" sözdizimi hatası)
    if (outer != null) e = e.split('${outer}').join('(' + outer + ')');   // nested_array DIŞ eleman
    if (index != null) e = e.split('${index}').join(String(index));
    if (depth != null) e = e.split('${depth}').join(String(depth));
    return e;
  }
  return `${wrappedElem}${access}${expr}`;
}
// koşullu alan (field.when) sonucu doğru mu? boş/0/false/NULL -> false
function condTrue(s: string): boolean {
  const t = (s ?? '').trim();
  if (t === '' || t === '0' || /^false$/i.test(t)) return false;
  if (/^(\([^)]*\)\s*)?0x0+$/.test(t)) return false;
  return true;
}
function fieldBars(fields: FieldCfg[]): Record<string, { warn: number; crit: number }> {
  const m: Record<string, { warn: number; crit: number }> = {};
  for (const f of fields) if (f.bar) {
    const o = typeof f.bar === 'string' ? {} : f.bar;
    m[f.label] = { warn: typeof o.warn === 'number' ? o.warn : 75, crit: typeof o.crit === 'number' ? o.crit : 90 };
  }
  return m;
}
// Kolon -> çapraz-referans hedefi (field.link verilmişse)
function fieldLinks(fields: FieldCfg[]): Record<string, { section: string; match?: string }> {
  const m: Record<string, { section: string; match?: string }> = {};
  for (const f of fields) if (f.link && f.link.section) m[f.label] = { section: f.link.section, match: f.link.match };
  return m;
}
// sourceLine kolonlarının etiketleri -> istemci bu kolonların "dosya:satır" hücrelerini tıklanabilir (kaynağa git) yapar
function fieldSrcCols(fields: FieldCfg[]): string[] {
  return fields.filter(f => f.sourceLine).map(f => f.label);
}
// Kolon -> değer->renk rozet eşlemesi (field.badge verilmişse)
function fieldBadges(fields: FieldCfg[]): Record<string, Record<string, string>> {
  const m: Record<string, Record<string, string>> = {};
  for (const f of fields) if (f.badge && typeof f.badge === 'object') m[f.label] = f.badge;
  return m;
}
// config-driven değer eşlemesi: değer -> {metin, renk} (field.valueMap). Düz string -> {text}; nesne -> {text?,color?}.
// "string | {text,color}" haritasını {text?,color?} haritasına normalle (valueMap + flags ortak kullanır)
function normTextColorMap(raw: unknown): Record<string, { text?: string; color?: string }> {
  const m: Record<string, { text?: string; color?: string }> = {};
  if (!raw || typeof raw !== 'object') return m;
  for (const k of Object.keys(raw as object)) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') { m[k] = { text: v }; }
    else if (v && typeof v === 'object') {
      const e: { text?: string; color?: string } = {};
      const vt = (v as { text?: unknown }).text, vc = (v as { color?: unknown }).color;
      if (typeof vt === 'string') e.text = vt;
      if (typeof vc === 'string') e.color = vc;
      if (e.text != null || e.color != null) m[k] = e;
    }
  }
  return m;
}
function fieldValueMap(fields: FieldCfg[]): Record<string, Record<string, { text?: string; color?: string }>> {
  const out: Record<string, Record<string, { text?: string; color?: string }>> = {};
  for (const f of fields) { if (!f.valueMap) continue; const m = normTextColorMap(f.valueMap); if (Object.keys(m).length) out[f.label] = m; }
  return out;
}
// BAYRAK alanı: kolon -> bit maskesi (string) -> {metin, renk}
function fieldFlags(fields: FieldCfg[]): Record<string, Record<string, { text?: string; color?: string }>> {
  const out: Record<string, Record<string, { text?: string; color?: string }>> = {};
  for (const f of fields) { if (!f.flags) continue; const m = normTextColorMap(f.flags); if (Object.keys(m).length) out[f.label] = m; }
  return out;
}

// Yalnız AKTİF sütunları gdb'den çek (pasif sütunlar için print çalıştırılmaz)
// ${master} yalnız gruplu (groupBy) bölümlerde anlamlı. Gruplu OLMAYAN bir bölümün herhangi bir field
// ifadesinde (expr/wrap/when) ${master} varsa: Output'a uyarı + (bölüm başına bir kez) görünür uyarı.
const masterWarned = new Set<string>();
function warnMasterMisuseIfAny(name: string, cfg: SectionCfg) {
  const uses = (cfg.fields || []).some(f =>
    (typeof f.expr === 'string' && f.expr.indexOf('${master}') !== -1) ||
    (typeof f.wrap === 'string' && f.wrap.indexOf('${master}') !== -1) ||
    (typeof f.when === 'string' && f.when.indexOf('${master}') !== -1));
  if (!uses) return;
  log?.warn('section "' + name + '" uses ${master} in a field expression but is not grouped (no "groupBy"); ${master} only resolves in grouped sections, so it will not be substituted.');
  if (!masterWarned.has(name)) {
    masterWarned.add(name);
    vscode.window.showWarningMessage('Debug Inspector: "' + name + '" uses ${master} but is not grouped — add "groupBy" to this section, or remove ${master}.');
  }
}
async function buildSection(
  session: vscode.DebugSession,
  cfg: SectionCfg,
  frameId: number | undefined,
  cursor: string,
  name: string,
  isStale?: () => boolean,
  onStream?: (sec: Section) => void,   // satır akışı: satırlar geldikçe kısmi Section yayınla (sunum salt-okunur; tablo başlığı + çubuk/link meta'sı baştan hazır)
  extraVars?: Record<string, string>   // detay bölümü: ${selected}/${selected_index}/... satır-anı değerleri
): Promise<Section> {
  warnMasterMisuseIfAny(name, cfg);   // gruplu OLMAYAN bölümde ${master} kullanılmışsa uyar (çözülmez)
  const eff = effectiveColumns(name, cfg.fields);
  const effFields = eff.active
    .map(l => cfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const kind: 'linked' | 'array' | 'index' | 'tree' = cfg.mode === 'array' ? 'array' : cfg.mode === 'index_list' ? 'index' : cfg.mode === 'tree' ? 'tree' : 'linked';
  // GDB gerektirmeyen sunum meta'sı (kolonlar + çubuk/link/rozet/...) — bir kez hesapla, hem akışta hem son halde kullan.
  const meta = { columnsAll: eff.order, hidden: eff.hidden, bases: fieldBases(cfg.fields), bars: fieldBars(cfg.fields), links: fieldLinks(cfg.fields), badges: fieldBadges(cfg.fields), valueMap: fieldValueMap(cfg.fields), flags: fieldFlags(cfg.fields), srcCols: fieldSrcCols(cfg.fields), timeline: cfg.timeline, kind };
  const onProgress = onStream ? (rs: Row[]) => onStream({ name, ...meta, rows: rs.slice(), summary: '' }) : undefined;
  perfSectionStart();
  const rows = await collectSection(session, { ...cfg, fields: effFields }, frameId, cursor, name, isStale, undefined, undefined, undefined, undefined, extraVars, undefined, onProgress);
  log?.debug(`section "${name}" (${cfg.mode}, root=${cfg.root}): ${rows.length} row(s); active=[${eff.active.join(', ')}]`);
  perfSectionEnd(name);
  return { name, ...meta, rows, summary: summarize(name, rows) };
}

// ---------------------------------------------------------------------------
// Gruplama (ağaç): ${master} yer tutucusu + master elemanı seçici
// ---------------------------------------------------------------------------
// Master satırın elemanını yeniden seçen ifade (tip-güvenli, adres/cast gerektirmez)
function selectorExpr(cfg: SectionCfg, index: number): string {
  // collectSection'daki eleman üretimiyle birebir: cast + wrap DAHİL işlenmiş eleman.
  // NOT: Bu yalnız SAVUNMA AMAÇLI FALLBACK'tir — master selExpr'leri normalde satırın __el__'inden okunur
  // (masterSelExprs). __el__ TÜM modlarda doğrudur; selectorExpr array/linked/walk'ı yeniden üretebilir ama
  // index_list/tree'nin satır-başına gerçek slot/yolunu bilemez (o yüzden o modlar __el__'e bağımlıdır).
  if (cfg.mode === 'array') {
    const base = cfg.cast ? `((${cfg.cast})(${cfg.root}))` : `(${cfg.root})`;
    let elem = `${base}[${index}]`;
    if (cfg.wrap) elem = cfg.wrap.split('${expr}').join('(' + elem + ')');
    return elem;
  }
  if (cfg.mode === 'walk') {
    // walk: KARARLI sembolik eleman = (start)'a 'next' şablonu index kez uygulanmış (canlı kürsör adresi DEĞİL).
    // collectSection'ın walk dalındaki sRaw/wrapCur ile birebir; linked'in root(->next)^i'sinin walk karşılığı.
    const wrapCur = (e: string): string => {
      const c = cfg.cast ? '((' + cfg.cast + ')(' + e + '))' : e;
      return cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + c + ')') + ')' : c;
    };
    let e = cfg.start ?? cfg.root;
    const nx = cfg.next ?? '';
    for (let k = 0; k < index && nx; k++)
      e = nx.split('${wrapped_expr}').join('(' + wrapCur(e) + ')').split('${expr}').join('(' + e + ')');
    return wrapCur(e);
  }
  // linked_list (doğru) + index_list/tree (yalnız kaba fallback): root(->next)^index
  let e = cfg.root;
  const nx = cfg.next ?? 'next';
  for (let k = 0; k < index; k++) e = e + '->' + nx;
  return cfg.wrap ? cfg.wrap.split('${expr}').join('(' + e + ')') : e;
}
// Master satırların KARARLI eleman ifadeleri (groupBy selExprs + refreshTarget). Her satır collectRowFields'ta
// __el__ taşır (cast+wrap'li kararlı eleman; array/linked/index_list/tree/walk HEPSİNDE doğru — walk'ta
// start+next^i, index_list/tree'de gerçek slot/BFS-yolu). __el__'i tercih et; yoksa selectorExpr'e düş.
function masterSelExprs(sec: Section, cfg: SectionCfg): string[] {
  return sec.rows.map((r, idx) => (typeof r['__el__'] === 'string' && r['__el__']) ? r['__el__'] : selectorExpr(cfg, idx));
}
function isGrouped(cfg: SectionCfg): boolean {
  return typeof cfg.groupBy === 'string' && cfg.groupBy.length > 0;
}
// Çok seviyeli dizi bölümü mü? (nested_array — buildArrayNd ile kurulur; groupBy master'ı olamaz)
function isMultiArray(cfg: SectionCfg): boolean {
  return cfg.mode === 'nested_array';
}
// Talep-üzerine detay bölümü mü? (selectedFrom verilmişse sekme DEĞİL; sağ-tık ile bir master satırı için kurulur)
function isDetail(cfg: SectionCfg): boolean {
  return typeof cfg.selectedFrom === 'string' && cfg.selectedFrom.length > 0;
}
// Detay config'i ${selected_index} / ${selected_master_index} kullanıyor mu? (tüm string alanları tarar — hata kontrolü için)
// Not: '${selected_index}', '${selected_master_index}' içinde substring DEĞİL ('selected_i' vs 'selected_m') -> tespitler bağımsız.
function usesSelectedIndex(cfg: SectionCfg): boolean {
  return JSON.stringify(cfg).indexOf('${selected_index}') !== -1;
}
function usesSelectedMasterIndex(cfg: SectionCfg): boolean {
  return JSON.stringify(cfg).indexOf('${selected_master_index}') !== -1;
}
function usesSelectedOuterIndex(cfg: SectionCfg): boolean {
  return JSON.stringify(cfg).indexOf('${selected_outer_index}') !== -1;
}
// ${selected} = seçilen master satırın kararlı eleman ifadesi (data-el/__el__); ${selected_index} = o satırın index'i
// (array/index_list/nested_array); ${selected_master_index} = satırın GRUBUNUN/parent'ının index'i (gruplu master +
// groupBy hedefi array/index_list, ya da nested_array); ${selected_outer_index} = DIŞ index (yalnız nested_array >=3 seviye).
// Koşullar sağlanmazsa refreshDetail AÇIK hata verir. TÜM ifadelerde değiştir.
// Not: token'lar birbirinin substring'i DEĞİL ('selected}'/'selected_i'/'selected_m'/'selected_o') -> sıra önemsiz.
function substituteSelected(cfg: SectionCfg, sel: string, selIndex?: string, selMasterIndex?: string, selOuterIndex?: string): SectionCfg {
  const sub = (s: string | undefined): string | undefined => {
    if (s == null) return s;
    let r = s.split('${selected}').join('(' + sel + ')');
    if (selIndex != null) r = r.split('${selected_index}').join(selIndex);
    if (selMasterIndex != null) r = r.split('${selected_master_index}').join(selMasterIndex);
    if (selOuterIndex != null) r = r.split('${selected_outer_index}').join(selOuterIndex);
    return r;
  };
  return {
    ...cfg,
    root: sub(cfg.root) as string,
    start: sub(cfg.start), next: sub(cfg.next), while: sub(cfg.while),
    head: sub(cfg.head), nil: sub(cfg.nil), count: sub(cfg.count),
    levels: cfg.levels ? cfg.levels.map(l => ({ ...l, array: sub(l.array), count: sub(l.count), label: sub(l.label), wrap: sub(l.wrap) })) : cfg.levels,   // nested_array detayı: seviye ifadeleri ${selected}* taşıyabilir
    wrap: sub(cfg.wrap), cast: cfg.cast,
    // ALANLARA (expr/wrap/when/bar) BİLEREK dokunulmaz: ${selected*} token'ları satır anında extraVars ile
    // çözülür (refreshDetail -> buildSection/buildArrayNd). Ön-yerleştirme, token'sız kalan ifadeyi
    // elemana ekletip bozuyordu (örn "${selected_index}" -> "5" -> elem.5 GDB sözdizimi hatası).
    fields: cfg.fields
  };
}
function substituteMaster(expr: string, sel: string): string {
  return expr.split('${master}').join('(' + sel + ')');
}
// '0x.. "init"' -> 'init'; aksi halde olduğu gibi (ağaç düğüm başlığı)
function nodeLabel(v: string): string {
  const m = v.match(/"([^"]*)"/);
  return m ? m[1] : v;
}
function firstActiveLabel(sec: Section): string | undefined {
  return sec.columnsAll.find(l => sec.hidden.indexOf(l) === -1);
}
function rowKeyAt(sec: Section, idx: number): string | undefined {
  const fa = firstActiveLabel(sec);
  return fa ? sec.rows[idx]?.[fa] : undefined;
}

// groupBy: her master elemanı için bir grup; root'taki ${master} o elemana çözülür
async function buildGrouped(
  session: vscode.DebugSession,
  frameId: number | undefined,
  i: number,
  name: string,
  scfg: SectionCfg,
  masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }>,
  isStale?: () => boolean,
  onStream?: (sec: Section) => void   // grup akışı: her grup tamamlandıkça kısmi Section yayınla (throttle'lı)
): Promise<Section> {
  const eff = effectiveColumns(name, scfg.fields);
  const effFields = eff.active
    .map(l => scfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  // GDB gerektirmeyen sunum meta'sı — bir kez hesapla (akış emisyonları + son hal aynı meta'yı kullanır).
  const gkind: 'linked' | 'array' | 'index' | 'tree' = scfg.mode === 'array' ? 'array' : scfg.mode === 'index_list' ? 'index' : scfg.mode === 'tree' ? 'tree' : 'linked';
  const meta = { columnsAll: eff.order, hidden: eff.hidden, grouped: true as const, kind: gkind, bases: fieldBases(scfg.fields), bars: fieldBars(scfg.fields), links: fieldLinks(scfg.fields), badges: fieldBadges(scfg.fields), valueMap: fieldValueMap(scfg.fields), flags: fieldFlags(scfg.fields), srcCols: fieldSrcCols(scfg.fields), timeline: scfg.timeline };
  const m = masters[scfg.groupBy as string];
  if (!m || !m.sec.rows.length) {
    log?.warn(`grouped "${name}": master "${scfg.groupBy}" not found or empty`);
    return { name, columnsAll: eff.order, hidden: eff.hidden, rows: [], summary: '', grouped: true, groups: [], needsSelection: true };
  }
  const masterAcc = m.cfg.mode === 'array' ? (m.cfg.access ?? '.') : '->';
  const groups: Group[] = [];
  perfSectionStart();
  let lastEmit = 0;
  const emit = () => { if (!onStream || !groups.length) return; const now = Date.now(); if (now - lastEmit >= 80) { lastEmit = now; onStream({ name, ...meta, rows: [], groups: groups.slice(), summary: '' }); } };
  for (let mi = 0; mi < m.sec.rows.length; mi++) {
    if (isStale && isStale()) break;   // continue/yeni durak -> grupları çekmeyi bırak
    const selExpr = m.selExprs[mi];
    const subCfg: SectionCfg = {
      ...scfg,
      fields: effFields,
      root: substituteMaster(scfg.root, selExpr),
      count: scfg.count ? substituteMaster(scfg.count, selExpr) : scfg.count,
      head: scfg.head ? substituteMaster(scfg.head, selExpr) : scfg.head,
      nil: scfg.nil ? substituteMaster(scfg.nil, selExpr) : scfg.nil,
      // walk-as-grouped-child: start/while/next de ${master} taşıyabilir (örn. start "${master}->cs_fp") -> substitue et
      start: scfg.start ? substituteMaster(scfg.start, selExpr) : scfg.start,
      while: scfg.while ? substituteMaster(scfg.while, selExpr) : scfg.while,
      next: scfg.next ? substituteMaster(scfg.next, selExpr) : scfg.next
    };
    // grubun master satırı bir subscript taşıyorsa (master 'array'/'index_list') satırlara geçir ->
    // field'larda ${master_index} + selectedFrom detayında ${selected_master_index} (collectRowFields __midx__ damgalar)
    const mIdx = (m.sec.rows[mi] || {})['__idx__'];
    const rows = await collectSection(session, subCfg, frameId, '$rg_' + i + '_' + mi, name, isStale, selExpr, mIdx);   // ${master} = bu grubun master elemanı
    const key = rowKeyAt(m.sec, mi) ?? String(mi);
    const label = m.cfg.label
      ? nodeLabel(cleanValue(await gdbExec(session, `print (${selExpr})${masterAcc}${m.cfg.label}`, frameId)))
      : key;
    groups.push({ label, key, rows });
    emit();
  }
  const total = groups.reduce((a, g) => a + g.rows.length, 0);
  log?.debug(`grouped "${name}" by ${scfg.groupBy}: ${groups.length} group(s), ${total} row(s)`);
  perfSectionEnd(name);
  return { name, ...meta, rows: [], summary: `${total} ${name} · ${groups.length} ${scfg.groupBy}`, groups };
}

// ---------------------------------------------------------------------------
// nested_array: ÇOK SEVİYELİ dizi (2, 3, ... N seviye). levels[0] = en dış, SON seviye = SATIRLAR;
// son seviyeden önceki her seviye kombinasyonu bir GRUP olur (başlık: label parçalarının ' › ' birleşimi;
// son grup-seviyesinin label'ı ŞABLONSA başlığın tamamı odur). Ayrı master bölüm GEREKMEZ (groupBy'dan farkı).
// İç toplama collectSection'ın array dalıyla yapılır -> blob batch / satır akışı / iptal (isStale) aynen geçerli.
// Token'lar: ${index}=satır subscript'i, ${master}/${master_index}=satırın PARENT'ı, ${outer}/${outer_index}=en dış
// (>=3 seviyede); 'name' verilen seviyeler için ${<ad>} / ${<ad>_index}. selectedFrom bu bölümü master alırsa:
// ${selected_index}=satır, ${selected_master_index}=parent, ${selected_outer_index}=en dış (>=3 seviye).
// ---------------------------------------------------------------------------
// Parça ifade çözücü: iç dizi kökü / sayaç, PARENT elemana göre.
//  - "${expr}" içeriyorsa şablon (${expr} = parent eleman)      örn "${expr}" -> parent'ın KENDİSİ dizi kökü
//  - tamamı rakamsa sabit                                        örn "4"
//  - "::" ile başlıyorsa GLOBAL ifade (parent'a bağlanmaz)       örn "::g_jobs_per_core"
//  - aksi halde parent üzerinde accessor                         örn "items" -> (parent).items / (parent)->items
function resolvePart(tpl: string, parent: string, access: string): string {
  tpl = String(tpl);   // config'ten JSON SAYISI gelebilir ("innerCount": 4) -> string'e zorla (aksi halde .indexOf TypeError -> tüm refresh ölürdü)
  if (tpl.indexOf('${expr}') !== -1) return tpl.split('${expr}').join('(' + parent + ')');
  if (/^\d+$/.test(tpl)) return tpl;
  if (tpl.startsWith('::')) return tpl.slice(2);
  return `${parent}${access}${tpl}`;
}
// nested_array config'ini seviye listesine çevir (levels[0] = en dış, son = SATIRLAR).
// İlk seviyenin array/count/access/label/cast/wrap'i verilmemişse bölüm kökündeki eşdeğerlerinden tamamlanır.
function normalizeLevels(cfg: SectionCfg): LevelCfg[] | undefined {
  if (cfg.mode === 'nested_array') {
    const ls = Array.isArray(cfg.levels) ? cfg.levels.map(l => ({ ...l })) : [];
    if (ls.length) {
      ls[0].array = ls[0].array ?? cfg.root; ls[0].count = ls[0].count ?? cfg.count;
      ls[0].access = ls[0].access ?? cfg.access; ls[0].label = ls[0].label ?? cfg.label;
      ls[0].cast = ls[0].cast ?? cfg.cast; ls[0].wrap = ls[0].wrap ?? cfg.wrap;
    }
    return ls;
  }
  return undefined;
}
// İsimli seviye token'ları başka anahtarlarla çakışmasın
const RESERVED_TOKEN_NAMES = ['expr', 'wrapped_expr', 'index', 'depth', 'master', 'master_index', 'outer', 'outer_index', 'selected', 'selected_index', 'selected_master_index', 'selected_outer_index'];
async function buildArrayNd(
  session: vscode.DebugSession,
  frameId: number | undefined,
  name: string,
  cfg: SectionCfg,
  isStale?: () => boolean,
  onStream?: (sec: Section) => void,   // grup akışı: her grup tamamlandıkça kısmi Section yayınla (throttle'lı)
  detailVars?: Record<string, string>   // detay bölümü: ${selected*} satır-anı değerleri (isimli seviye token'larıyla birleşir)
): Promise<Section> {
  const eff = effectiveColumns(name, cfg.fields);
  const effFields = eff.active
    .map(l => cfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const meta = { columnsAll: eff.order, hidden: eff.hidden, grouped: true as const, kind: 'array' as const, bases: fieldBases(cfg.fields), bars: fieldBars(cfg.fields), links: fieldLinks(cfg.fields), badges: fieldBadges(cfg.fields), valueMap: fieldValueMap(cfg.fields), flags: fieldFlags(cfg.fields), srcCols: fieldSrcCols(cfg.fields), timeline: cfg.timeline };
  const fail = (emsg: string): Section => { log?.warn(`${cfg.mode} "${name}": ${emsg}`); return { name, ...meta, rows: [], summary: '', groups: [], error: emsg }; };
  const levels = normalizeLevels(cfg);
  if (!levels || levels.length < 2) return fail(`mode "nested_array" requires at least 2 levels in 'levels'`);
  for (let k = 0; k < levels.length; k++) {
    if (levels[k].array == null || levels[k].array === '' || levels[k].count == null || levels[k].count === '') return fail(`level ${k}${levels[k].name ? ` ("${levels[k].name}")` : ''}: 'array' ve 'count' zorunlu`);
  }
  const names = levels.map(l => l.name).filter((s): s is string => !!s);
  if (new Set(names).size !== names.length) return fail(`level 'name' değerleri benzersiz olmalı`);
  // ad kuralları: tanımlayıcı olmalı; rezerve olamaz; '_index' ile BİTEMEZ (türetilmiş ${<ad>_index} token'larını gölgeler);
  // türetilmiş <ad>_index başka bir adla ya da rezerve bir token'la çakışamaz (örn ad "selected_master" -> ${selected_master_index} hijack olurdu)
  const badName = names.find(n2 => RESERVED_TOKEN_NAMES.includes(n2) || !/^[A-Za-z_]\w*$/.test(n2)
    || /_index$/.test(n2) || names.includes(n2 + '_index') || RESERVED_TOKEN_NAMES.includes(n2 + '_index'));
  if (badName) return fail(`level adı "${badName}" kullanılamaz (rezerve token, '_index' soneki ya da geçersiz tanımlayıcı)`);
  const L = levels.length;
  if (levels[L - 1].label) log?.warn(`nested_array "${name}": son seviyeye (satırlar) verilen 'label' yok sayılır — satırların başlığı yoktur (timeline blok metni için 'timeline.label' kullanın)`);
  const max = cfg.max ?? 1024;   // toplam satır sınırı (en iç elemanların toplamı)
  perfSectionStart();
  const groups: Group[] = [];
  let total = 0, lastEmit = 0;
  const emit = () => { if (!onStream || !groups.length) return; const now = Date.now(); if (now - lastEmit >= 80) { lastEmit = now; onStream({ name, ...meta, rows: [], groups: groups.slice(), summary: '' }); } };
  // label ŞABLONU: '${' içeren label GDB'siz METİN şablonudur. Token'lar: her üst seviyenin ${<name>_index}'i,
  // ${index} = etiketlenen elemanın KENDİ subscript'i, ${outer_index} = en dış, ${master_index} = ${index} eş anlamlısı.
  // '${' YOKSA accessor: eleman üzerinde GDB ile okunur. Örn: "core ${core_index} -> job ${job_index}".
  const isLblTpl = (s?: string) => s != null && s.indexOf('${') !== -1;
  const lblText = (tpl: string, idxsInc: number[], k: number): string => {
    let r = tpl;
    for (let j = 0; j <= k; j++) { const nm = levels[j].name; if (nm) r = r.split('${' + nm + '_index}').join(String(idxsInc[j])); }
    return r.split('${outer_index}').join(String(idxsInc[0])).split('${master_index}').join(String(idxsInc[k])).split('${index}').join(String(idxsInc[k]));
  };
  log?.debug(`${cfg.mode} "${name}": ${L} level(s) [${levels.map((l, i) => l.name ?? ('level' + i)).join(' > ')}]`);
  // Genel N-seviye yürüyüş: seviye k'nin dizisini gez; son seviyeden bir ÖNCEKİ seviyenin her elemanı bir GRUP olur,
  // son seviye elemanları o grubun SATIRLARIDIR (collectSection array dalı -> blob batch / akış / iptal aynen geçerli).
  const walk = async (k: number, rootExpr: string, idxs: number[], elems: string[], labelParts: string[]): Promise<void> => {
    const lv = levels[k];
    const parentAcc = k > 0 ? (levels[k - 1].access ?? '.') : '.';
    const cntExpr = k === 0 ? (lv.count as string) : resolvePart(lv.count as string, elems[k - 1], parentAcc);
    const cntRaw = cleanValue(await gdbExec(session, `print ${cntExpr}`, frameId));
    const cnt = parseInt(cntRaw, 10) || 0;
    const base = lv.cast ? `((${lv.cast})(${rootExpr}))` : `(${rootExpr})`;
    for (let i = 0; i < Math.min(cnt, max) && total < max; i++) {   // grup seviyeleri de max ile klemplenir (bozuk sayaç -> sınırsız GDB turu olmasın)
      if (isStale && isStale()) return;   // continue/yeni durak/bölüm kapatıldı -> erken bırak
      const elemRaw = `${base}[${i}]`;
      const elem = lv.wrap ? '(' + lv.wrap.split('${expr}').join('(' + elemRaw + ')') + ')' : elemRaw;
      const gIdxs = [...idxs, i], gElems = [...elems, elem];
      const lbl = lv.label
        ? (isLblTpl(lv.label) ? lblText(lv.label, gIdxs, k)
                              : nodeLabel(cleanValue(await gdbExec(session, `print (${elem})${lv.access ?? '.'}${lv.label}`, frameId))))
        : String(i);
      if (k < L - 2) {
        const childRoot = resolvePart(levels[k + 1].array as string, elem, lv.access ?? '.');
        await walk(k + 1, childRoot, gIdxs, gElems, [...labelParts, lbl]);
        continue;
      }
      // k == L-2: elem = SATIRLARIN parent'ı -> son seviyeyi topla
      const rowLv = levels[L - 1];
      const rowsRoot = resolvePart(rowLv.array as string, elem, lv.access ?? '.');
      const rowsCount = resolvePart(rowLv.count as string, elem, lv.access ?? '.');
      const subCfg: SectionCfg = { mode: 'array', root: rowsRoot, count: rowsCount, access: rowLv.access ?? '.', cast: rowLv.cast, wrap: rowLv.wrap, max: Math.max(0, max - total), fields: effFields };
      // İSİMLİ token'lar: her grup seviyesi j için ${<name>} = eleman, ${<name>_index} = subscript (SATIR seviyesinin
      // isimli token'ları collectSection'da satır başına üretilir). Legacy: ${master}=parent, ${outer}=en dış (3+ seviye).
      const vars: Record<string, string> = { ...(detailVars || {}) };
      for (let j = 0; j < gElems.length; j++) { const nm = levels[j].name; if (nm) { vars[nm] = '(' + gElems[j] + ')'; vars[nm + '_index'] = String(gIdxs[j]); } }
      const rows = await collectSection(session, subCfg, frameId, '$rn_' + gIdxs.join('_'), name, isStale,
        elem, String(i),
        L >= 3 ? gElems[0] : undefined, L >= 3 ? String(gIdxs[0]) : undefined,
        vars, rowLv.name,
        undefined);
      total += rows.length;
      // grup başlığı: SON grup-seviyesinin label'ı ŞABLONSA başlığın tamamıdır (üst indexleri kendisi gömebilir);
      // değilse üst parçalarla ' › ' birleşimi.
      const header = (lv.label && isLblTpl(lv.label)) ? lbl : [...labelParts, lbl].join(' › ');
      groups.push({ label: header, key: gIdxs.join('.'), rows });
      emit();
    }
  };
  try {
    await walk(0, String(levels[0].array), [], [], []);
  } catch (e: any) {
    perfSectionEnd(name);
    return fail(`traversal failed: ${e?.message ?? e}`);
  }
  log?.debug(`${cfg.mode} "${name}": ${groups.length} group(s), ${total} row(s)`);
  perfSectionEnd(name);
  return { name, ...meta, rows: [], summary: `${total} ${name} · ${groups.length} groups`, groups };
}

// ---------------------------------------------------------------------------
// Yenileme
// ---------------------------------------------------------------------------
// Bir bölümün VERİYİ etkileyen imzası (GDB'den ne çekildiğini belirleyen alanlar).
// HARİÇ (yalnız sunum, GDB gerektirmez): base, bar.warn/crit, link, badge.
function dataSig(cfg: SectionCfg): string {
  const barMax = (b: any) => (b == null ? null : (typeof b === 'object' ? b.max : b));
  return JSON.stringify({
    mode: cfg.mode, root: cfg.root, next: cfg.next, head: cfg.head, nil: cfg.nil,
    count: cfg.count, access: cfg.access, cast: cfg.cast, wrap: cfg.wrap,
    start: cfg.start, while: cfg.while,
    levels: cfg.levels,
    tlset: (cfg.timeline && cfg.timeline.set) ? cfg.timeline.set : null,   // timeline.set VERİ çeker (her blok elemanının alt dizisi) -> imzaya dahil (yalnız sunum DEĞİL)
    groupBy: cfg.groupBy, max: cfg.max, label: cfg.label,
    fields: (cfg.fields || []).map(f => ({ l: f.label, e: f.expr, w: f.wrap, wn: f.when, bm: barMax(f.bar), ed: !!f.editable, h: !!f.hidden, sym: !!f.symbol, sl: !!f.sourceLine }))
  });
}
// sekme sırası + etkin gizli küme (refresh ile aynı kurallar)
function resolveLayout(secs: { name: string; cfg: SectionCfg }[]) {
  const allNames = secs.map(s => s.name);
  const order = (sectionPrefs.order || []).filter(n => allNames.includes(n));
  for (const n of allNames) if (!order.includes(n)) order.push(n);
  const configHidden = secs.filter(s => s.cfg.hidden).map(s => s.name);
  const hiddenNames = sectionPrefs.touched ? (sectionPrefs.hidden || []) : configHidden;
  const hiddenSet = new Set(hiddenNames.filter(n => allNames.includes(n)));
  return { order, hiddenSet, visible: order.filter(n => !hiddenSet.has(n)) };
}
// VERİ parmak izi: sıra + gizli küme + her bölümün dataSig'i. Değişmezse config'te yalnız sunum değişmiş demektir.
function fingerprintOf(secs: { name: string; cfg: SectionCfg }[], lay: { order: string[]; hiddenSet: Set<string> }): string {
  return JSON.stringify({ o: lay.order, h: [...lay.hiddenSet].sort(), s: secs.map(x => [x.name, dataSig(x.cfg)]) });
}
let lastFingerprint = '';

// timeline.set'i her zaman DİZİ olarak normalle (tek nesne -> [nesne]); geçersiz/eksik olanları at.
function normalizeSets(set: TlSetDef | TlSetDef[] | undefined): TlSetDef[] {
  const arr = Array.isArray(set) ? set : (set ? [set] : []);
  return arr.filter(s => s && s.array && s.count != null && (s.count as any) !== '');
}
// ⏱ timeline.set: her BLOK satırına, satırın kararlı eleman ifadesi (__el__) üzerinden okunan ALT diziLERİ ekle
// -> row['__tlsets__'] = [{title, items:string[], dashes:boolean[]}] (örn part'ın device/signal kümeleri; BİRDEN ÇOK olabilir).
// Timeline görünümü bunları blok içinde ayrı chip satırları çizer. View toggle client-side -> veri BURADA toplanır, satırla gider.
// PARENT = blok elemanı; array/count parça sözdizimidir (accessor '.' | sabit | "::global" | "${expr}" şablonu; pointer eleman için "${expr}->dizi").
async function attachTimelineSet(session: vscode.DebugSession, frameId: number | undefined, sec: Section, cfg: SectionCfg, isStale?: () => boolean): Promise<void> {
  const sets = normalizeSets(cfg.timeline && cfg.timeline.set);
  if (!sets.length) return;
  const rows: Row[] = sec.grouped ? (sec.groups || []).reduce<Row[]>((a, g) => a.concat(g.rows || []), []) : (sec.rows || []);
  for (const row of rows) {
    if (isStale && isStale()) return;
    const el = row['__el__'];
    if (typeof el !== 'string' || !el) continue;                   // kararlı eleman ifadesi yoksa (olmamalı) atla
    const parent = '(' + el + ')';
    const results: { title: string; items: string[]; dashes: boolean[] }[] = [];
    for (const set of sets) {
      const acc = set.access ?? '.';                               // alt eleman -> label erişimi ("." | "->")
      const cap = (typeof set.max === 'number' && set.max > 0) ? set.max : 64;   // bozuk sayaç -> sınırsız GDB turu olmasın
      const arrRoot = resolvePart(String(set.array), parent, '.'); // blok elemanı -> alt dizi kökü
      const cntExpr = resolvePart(String(set.count), parent, '.');
      let cnt = 0;
      try { cnt = parseInt(cleanValue(await gdbExec(session, `print ${cntExpr}`, frameId)), 10) || 0; } catch { cnt = 0; }
      const items: string[] = [];
      const dashes: boolean[] = [];   // items ile aynı uzunluk; dashWhen yoksa hepsi false (ekstra GDB turu yok)
      // dashWhen çözümü (kesikli-kenar koşulu):
      //  - true/false: GDB'nin C modu bunları BİLMEZ -> JS sabiti (GDB'siz), tüm chip'lere uygulanır.
      //  - ${expr}'siz VE harf/altçizgiyle BAŞLAMAYAN (örn "1","0"): elemandan BAĞIMSIZ standalone ifade
      //    -> GDB'de BİR KEZ değerlendir, tüm chip'lerde kullan (accessor sanıp "(eleman).1" göndermez).
      //  - aksi (accessor "off" / "off == 1" / "${expr}" şablonu): HER eleman için ayrı değerlendirilir.
      const dwRaw = set.dashWhen != null ? String(set.dashWhen).trim() : '';
      let dwConst: boolean | null = /^(true|false)$/i.test(dwRaw) ? /^true$/i.test(dwRaw) : null;   // null = eleman başına
      if (dwConst === null && dwRaw && dwRaw.indexOf('${expr}') === -1 && !/^[A-Za-z_]/.test(dwRaw) && cnt > 0) {
        let dv = ''; try { dv = cleanValue(await gdbExec(session, `print (${dwRaw})`, frameId)); } catch { dv = ''; }
        dwConst = condTrue(dv);   // "1"/"0"/(global ifade) — eleman-bağımsız, bir kez
      }
      for (let i = 0; i < Math.min(cnt, cap); i++) {
        if (isStale && isStale()) return;
        const elemExpr = `(${arrRoot})[${i}]`;
        const readExpr = set.label ? `(${elemExpr})${acc}${set.label}` : elemExpr;   // label verilirse o alan; yoksa elemanın kendisi
        let v = '';
        try { v = nodeLabel(cleanValue(await gdbExec(session, `print ${readExpr}`, frameId))); } catch { v = ''; }
        items.push(v);
        if (dwConst !== null) dashes.push(dwConst);   // sabit / standalone -> per-element tur yok
        else if (dwRaw) {   // accessor ya da ${expr} şablonu -> cihaz elemanına göre truthy ise kenar kesikli
          const dwExpr = dwRaw.indexOf('${expr}') !== -1 ? dwRaw.split('${expr}').join('(' + elemExpr + ')') : `(${elemExpr})${acc}${dwRaw}`;
          let dv = '';
          try { dv = cleanValue(await gdbExec(session, `print ${dwExpr}`, frameId)); } catch { dv = ''; }
          dashes.push(condTrue(dv));
        } else dashes.push(false);
      }
      results.push({ title: (typeof set.title === 'string' ? set.title : ''), items, dashes });
    }
    (row as any)['__tlsets__'] = results;   // Row = Record<string,string> ama __tlsets__ küme-sonuç dizisi taşır (webview'e JSON olarak gider)
  }
}

async function refresh(session: vscode.DebugSession, threadId: number, gen?: number) {
  if (!panel) return;
  const stale = () => gen !== undefined && gen !== refreshGen;   // daha yeni istek geldiyse bu refresh iptal
  const cfg = loadConfig();
  if (!cfg) return;

  // #7: frameId'yi durak başına BİR KEZ çek, lastStopped'ta cache'le (config/edit/manual yenilemelerde stackTrace turu yok)
  const sameStop = lastStopped && lastStopped.session === session && lastStopped.threadId === threadId;
  let frameId: number | undefined = sameStop ? lastStopped!.frameId : undefined;
  if (frameId === undefined) {
    try {
      const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
      frameId = st?.stackFrames?.[0]?.id;
    } catch { /* ignore */ }
    if (sameStop) lastStopped!.frameId = frameId;
  }

  // #3: oturum başına BİR KEZ kompakt/güvenli print ayarları (tutarlı tek-satır çıktı + büyük değerlerde hata yok)
  if (printSetupFor !== session) {
    printSetupFor = session;
    await gdbExec(session, 'set print pretty off', frameId);
    await gdbExec(session, 'set max-value-size unlimited', frameId);
  }

  const allSecs = extractSections(cfg);
  // Talep-üzerine detay bölümleri (selectedFrom) SEKME değildir -> yerleşim/akış dışında tutulur.
  // detailMap: master adı -> bu master'dan açılabilen detay bölüm adları (webview sağ-tık menüsü için).
  const secs = allSecs.filter(s => !isDetail(s.cfg));
  const detailMap: Record<string, string[]> = {};
  for (const s of allSecs) if (isDetail(s.cfg)) { const mn = s.cfg.selectedFrom as string; (detailMap[mn] || (detailMap[mn] = [])).push(s.name); }
  const byName: Record<string, { name: string; cfg: SectionCfg; i: number }> = {};
  secs.forEach((s, i) => { byName[s.name] = { name: s.name, cfg: s.cfg, i }; });
  const lay = resolveLayout(secs);
  const order = lay.order, hiddenSet = lay.hiddenSet, visible = lay.visible;
  // Bir bölüm YÜKLENİRKEN kapatılırsa: setSections mesajı sectionPrefs'i ANINDA günceller (refresh await'leri
  // arasında event-loop işler). isHiddenNow o an gizli mi diye CANLI bakar -> o bölümün yüklemesini iptal edip sıradakine geçeriz.
  const configHiddenNames = secs.filter(s => s.cfg.hidden).map(s => s.name);
  const isHiddenNow = (n: string) => (sectionPrefs.touched ? (sectionPrefs.hidden || []) : configHiddenNames).includes(n);
  lastFingerprint = fingerprintOf(secs, lay);   // sonraki config değişimini "veri mi sunum mu" diye karşılaştırmak için taban
  const ts = new Date().toLocaleTimeString();
  log?.info(`refresh: ${secs.length} section(s); visible=[${visible.join(', ')}] active=${activeTab ?? '-'}`);
  perfRefreshSaved = 0;   // bu yenilemede kaydedilen round-trip'leri say (bölümler perfSectionEnd ile ekler)

  // iskeleti hazırla (ts + layout + kaldırılanları temizle); bölümler aşağıda ÖNCELİKLİ akışla gelir.
  // beginUpdate'ten ÖNCE stale kontrolü: yukarıdaki await'ler (stackTrace / print-setup) sırasında daha yeni bir
  // istek VEYA 'continued' (cancelRefresh) gen'i bump'lamış olabilir. Bu kontrol olmadan eski/iptal koşu paneli
  // SKELETON'a çevirir (beginUpdate) sonra L1655'te bail eder -> endUpdate gelmez -> yarım-yükleme/flaş kalır.
  if (stale()) return;
  panel.webview.postMessage({ type: 'beginUpdate', order, visible, hiddenSections: order.filter(n => hiddenSet.has(n)), details: detailMap, ts });
  sendWatchpoints();   // webview izlenen hücreleri ★ ile işaretlesin (yenileme sonrası da korunur)
  sendArchs();         // arch seçicisi: config'te bulunan etiketler + etkin olan

  // master cache (grouped bölümlerin bağımlılığı); görünür bir master kurulunca hemen gönderilir
  const masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }> = {};
  const built = new Set<string>();
  const sendSec = (name: string, sec: Section) => { built.add(name); panel?.webview.postMessage({ type: 'patchSection', section: name, sec, ts }); };
  // AKIŞ: bir bölüm kurulurken satırlar/gruplar geldikçe kısmi tabloyu gönder (yalnız görünür + henüz son hali verilmemiş + güncel durak).
  const streamPost = (name: string) => (sec: Section) => { if (!stale() && !built.has(name) && visible.includes(name) && !isHiddenNow(name)) panel?.webview.postMessage({ type: 'streamSection', section: name, sec, ts }); };
  const ensureMaster = async (mName: string): Promise<void> => {
    if (masters[mName]) return;
    const mm = byName[mName]; if (!mm) return;
    const msec = await buildSection(session, mm.cfg, frameId, '$ri_' + mm.i, mName, stale, streamPost(mName));
    masters[mName] = { sec: msec, selExprs: masterSelExprs(msec, mm.cfg), cfg: mm.cfg };
    if (visible.includes(mName) && !built.has(mName)) sendSec(mName, msec);   // master aynı zamanda görünür sekme -> hemen göster
  };

  // ÖNCELİKLİ KUYRUK: aktif sekme önce, sonra kalanlar (config sırası). Sekme değişirse (activeTab) sıradaki öncelik değişir.
  const remaining = () => visible.filter(n => !built.has(n) && !isHiddenNow(n));   // yüklenirken kapatılan bölüm kuyruktan düşer
  let rem: string[];
  while ((rem = remaining()).length) {
    if (stale()) return;   // daha yeni durak/istek -> bu (eski) akışı bırak
    const next = (activeTab && rem.includes(activeTab)) ? activeTab : rem[0];
    const node = byName[next];
    // Bu bölüme özel iptal: yeni durak (gen) VEYA bu bölüm kapatıldı. collectSection satır/grup arası kontrol eder -> orta yükte durur.
    const secStale = () => stale() || isHiddenNow(next);
    let sec: Section;
    // Bölüm kurulumu HATA VERSE bile refresh ölmesin: hatalı bölüm boş+hatalı gönderilir, SIRADAKİ bölümler yüklenir.
    // (Örn bozuk bir config değeri tek bölümü etkilemeli; eskiden yakalanmayan istisna tüm akışı sessizce durduruyordu.)
    try {
      if (isMultiArray(node.cfg)) {
        if (node.cfg.groupBy) log?.warn(`${node.cfg.mode} "${next}": groupBy desteklenmez, yok sayıldı`);
        sec = await buildArrayNd(session, frameId, next, node.cfg, secStale, streamPost(next));
      } else if (isGrouped(node.cfg)) {
        await ensureMaster(node.cfg.groupBy as string);
        if (stale()) return;
        if (isHiddenNow(next)) continue;   // master kurulurken kapatıldı -> child'ı hiç kurma, sıradakine geç
        sec = await buildGrouped(session, frameId, node.i, next, node.cfg, masters, secStale, streamPost(next));
      } else if (masters[next]) {
        sec = masters[next].sec;   // başka bir grouped bölüm için zaten (tam) kurulmuş
      } else {
        sec = await buildSection(session, node.cfg, frameId, '$ri_' + node.i, next, secStale, streamPost(next));
        if (!isHiddenNow(next)) masters[next] = { sec, selExprs: masterSelExprs(sec, node.cfg), cfg: node.cfg };   // iptal edildiyse KISMİ sonucu master olarak saklama
      }
    } catch (e: any) {
      log?.warn(`refresh: section "${next}" failed — ${e?.message ?? e}`);
      sec = { name: next, columnsAll: [], hidden: [], rows: [], summary: '', error: `section failed: ${e?.message ?? e}` };
    }
    if (stale()) return;
    if (isHiddenNow(next)) { log?.debug(`refresh: "${next}" yükleme sırasında kapatıldı → iptal, sıradaki bölüme geçiliyor`); continue; }   // gönderme; remaining() bu bölümü düşürür
    // ⏱ timeline.set: blok başına ALT diziyi (device kümesi) her satırın __el__'i üstünden çek + satıra ekle
    // (view toggle client-side -> timeline verisi de burada, son sec ile birlikte gönderilmeli)
    if (node.cfg.timeline && node.cfg.timeline.set && !sec.error) {
      try { await attachTimelineSet(session, frameId, sec, node.cfg, secStale); }
      catch (e: any) { log?.warn(`refresh: "${next}" timeline.set failed — ${e?.message ?? e}`); }
    }
    if (!built.has(next)) sendSec(next, sec);
  }
  if (stale()) return;
  if (perfRefreshSaved > 0) log?.info(`perf: ~${perfRefreshSaved} fewer GDB round-trip(s) this refresh (blob batch + when/bar-max from blob)`);
  panel.webview.postMessage({ type: 'endUpdate', ts });   // akış bitti -> webview aktif sekmeyi son kez boyar (çapraz-link çözülür)
}

// ---------------------------------------------------------------------------
// Webview
// ---------------------------------------------------------------------------
function openPanel(context: vscode.ExtensionContext) {
  // AKTİF editör grubunda TAM-genişlik sekme olarak aç (ViewColumn.Active) — editörü ikiye BÖLMEZ (eski
  // ViewColumn.Beside "yarım pencere" split'i açıyordu). Mevcut panel varsa olduğu kolonda öne getir (reveal()).
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel(
    'debugInspector', 'Debug Inspector', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = undefined; openDetails = []; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    async (msg: any) => {
      if (msg?.type === 'refresh') { log?.debug('webview: manual refresh'); doRefresh(); return; }
      if (msg?.type === 'ready') {
        log?.debug('webview: ready (load/move) — resend data if stopped');
        openDetails = [];
        // Arch seçicisini HEMEN doldur: debugger durmamışsa hiç refresh olmaz, o yüzden
        // config'i burada okuyup etiket listesini gönderiyoruz (yoksa seçici boş kalırdı).
        loadConfig();
        sendArchs();
        if (lastStopped) doRefresh();
        return;
      }
      if (msg?.type === 'setArch' && typeof msg.arch === 'string') {
        const want = msg.arch.trim() || 'common';
        archPref = want;
        log?.info(`webview: arch → "${want}"`);
        extContext?.workspaceState.update(ARCHPREF_KEY, archPref);
        // Config'in ANLAMI değişti (farklı overlay çözümü) -> veri/sunum farkına göre yenile.
        // Debugger durmamışsa onConfigChange erken döner; seçici zaten güncel, sonraki durakta uygulanır.
        onConfigChange();
        sendArchs();
        return;
      }
      if (msg?.type === 'openConfig') { log?.debug('webview: open config'); vscode.commands.executeCommand('debugInspector.openConfig'); return; }
      if (msg?.type === 'openDetail' && typeof msg.master === 'string' && typeof msg.sel === 'string' && typeof msg.section === 'string') {
        // master satırı sağ-tık -> "Show detailed info": detayı kaydet (her durakta tazelenecek) + hemen bir kez çek
        const selIndex = (typeof msg.selIndex === 'string' && msg.selIndex !== '') ? msg.selIndex : undefined;   // ${selected_index}: seçilen satırın index'i (array/index_list/nested_array'de dolu)
        const selMasterIndex = (typeof msg.selMasterIndex === 'string' && msg.selMasterIndex !== '') ? msg.selMasterIndex : undefined;   // ${selected_master_index}: satırın parent index'i (grouped/nested_array)
        const selOuterIndex = (typeof msg.selOuterIndex === 'string' && msg.selOuterIndex !== '') ? msg.selOuterIndex : undefined;   // ${selected_outer_index}: DIŞ index (yalnız nested_array >=3 seviye)
        const ex = openDetails.find(d => d.master === msg.master && d.sel === msg.sel && d.section === msg.section);
        if (ex) { ex.selIndex = selIndex; ex.selMasterIndex = selMasterIndex; ex.selOuterIndex = selOuterIndex; } else openDetails.push({ master: msg.master, sel: msg.sel, section: msg.section, selIndex, selMasterIndex, selOuterIndex });
        log?.info(`detail open: "${msg.section}" of [${msg.sel}] (from ${msg.master}, idx=${selIndex ?? '-'}, midx=${selMasterIndex ?? '-'}, oidx=${selOuterIndex ?? '-'})`);
        void refreshDetail({ master: msg.master, sel: msg.sel, section: msg.section, selIndex, selMasterIndex, selOuterIndex });
        return;
      }
      if (msg?.type === 'closeDetail' && typeof msg.master === 'string' && typeof msg.sel === 'string' && typeof msg.section === 'string') {
        openDetails = openDetails.filter(d => !(d.master === msg.master && d.sel === msg.sel && d.section === msg.section));
        log?.debug(`detail close: "${msg.section}" of [${msg.sel}]`);
        return;
      }
      if (msg?.type === 'activeTab') { if (typeof msg.section === 'string') activeTab = msg.section; return; }
      if (msg?.type === 'setColumns' && typeof msg.section === 'string' && msg.section) {
        log?.debug(`webview: setColumns ${msg.section} hidden=[${(msg.hidden || []).join(', ')}] refetch=${!!msg.refetch}`);
        columnPrefs[msg.section] = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : []
        };
        extContext?.workspaceState.update(COLPREF_KEY, columnPrefs);
        // yeni bir sütun aktifleştirildiyse SADECE o field'ı çek (bilinmiyorsa o bölümü), tüm paneli değil
        if (msg.refetch) {
          if (typeof msg.shown === 'string' && msg.shown) refreshTarget(msg.section, msg.shown);
          else refreshTarget(msg.section);
        }
      } else if (msg?.type === 'setPaused') {
        paused = !!msg.paused;
        log?.info(`webview: ${paused ? 'paused' : 'resumed'}`);
        extContext?.workspaceState.update(PAUSED_KEY, paused);
        if (!paused && lastStopped) doRefresh();
      } else if (msg?.type === 'copy' && typeof msg.text === 'string') {
        vscode.env.clipboard.writeText(msg.text);
        log?.debug(`webview: copied ${msg.text.length} chars to clipboard`);
      } else if (msg?.type === 'openSource' && typeof msg.loc === 'string' && msg.loc) {
        // sourceLine hücresine tıklandı: "yol:satır" -> DOĞRU dosyayı editörde aç + o satıra git.
        // msg.loc, GDB'nin verdiği yolu taşır (relative/abs/basename) -> aynı adlı dosyaları ayırt eder.
        const mm = msg.loc.match(/^(.*):(\d+)$/);   // satır = SON iki nokta üstünden (Windows "C:\...\f.c:12" da doğru)
        if (!mm) { log?.warn(`openSource: unparseable loc "${msg.loc}"`); return; }
        const line = Math.max(0, parseInt(mm[2], 10) - 1);   // GDB 1-tabanlı -> VS Code 0-tabanlı
        const ref = mm[1];
        // GEÇ AÇILMA FIX'i: pahalı yol workspace-genişliğinde findFiles taramasıdır. Sırayla:
        //   0) cache (tekrar tıklama anında)  1) mutlak yol  2) HIZLI yerel stat (her kök × her sonek, tarama YOK)
        //   3) SON ÇARE tek findFiles(basename) + en iyi sonek eşleşmesi. Çoğu tık 0/2'de biter -> anında.
        let fsPath = sourceUriCache.get(ref);
        if (fsPath && !fs.existsSync(fsPath)) fsPath = undefined;   // dosya taşınmış/silinmiş -> yeniden çöz
        if (!fsPath) {
          const cand = sourceRefCandidates(ref);
          const folders = (vscode.workspace.workspaceFolders || []).map(w => w.uri.fsPath);
          const suffixes = cand.globs.map(g => g.replace(/^\*\*\//, ''));   // uzun..kısa (basename dahil)
          // 1) mutlak yol (cygwin -> windows'a çevrilmiş) + mevcutsa
          if (cand.abs && fs.existsSync(cand.abs)) fsPath = cand.abs;
          // 2) HIZLI: her workspace kökü altında her soneki yerel fs.existsSync ile dene (index taraması YOK -> anında)
          if (!fsPath) for (const folder of folders) {
            for (const suf of suffixes) { const p = path.join(folder, suf); if (fs.existsSync(p)) { fsPath = p; break; } }
            if (fsPath) break;
          }
          // 3) SON ÇARE (dosya kökün doğrudan altında değil): TEK findFiles(basename) + en uzun sonek eşleşmesini seç
          if (!fsPath) {
            const hits = await vscode.workspace.findFiles('**/' + cand.base, '**/node_modules/**', 100);
            const best = bestSuffixMatch(ref, hits.map(h => h.fsPath));
            if (best) fsPath = best;
          }
          if (fsPath) sourceUriCache.set(ref, fsPath);
        }
        if (!fsPath) { vscode.window.showWarningMessage(`Debug Inspector: source file not found — ${ref}`); return; }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
        const pos = new vscode.Position(line, 0);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
        log?.info(`openSource: ${msg.loc} → ${fsPath}:${line + 1}`);
      } else if (msg?.type === 'watchpoint' && typeof msg.expr === 'string' && msg.expr) {
        // GDB veri-watchpoint'i: değer değişince program durur (bellek YAZMAZ; sadece break davranışı). Opt-in (sağ-tık).
        if (!lastStopped) { vscode.window.showWarningMessage('Debug Inspector: debugger not stopped — cannot set a watchpoint.'); return; }
        if (watchpoints[msg.expr] !== undefined) { sendWatchpoints(); return; }   // zaten izleniyor
        const sess = lastStopped.session, fid = lastStopped.frameId;
        // ADRES-YAKALAMA: ifadenin adresini bir convenience var'a al, sonra 'watch *$w'. Sabit adres izlenir,
        // erişim yolundaki pointer'lar izlenmez -> deref'li (->) ifade bile TEK HW register harcar (hardware, hızlı).
        wpCounter++;
        const wv = '$di_wp' + wpCounter;
        const addrRes = (await gdbExec(sess, `print ${wv} = &(${msg.expr})`, fid)).toString().replace(/\s+/g, ' ').trim();
        // adres alınamazsa (bitfield/register/optimize) ifadeyi doğrudan izle (fallback)
        const target = /no symbol|cannot|invalid|bit-?field|<<error/i.test(addrRes) ? msg.expr : ('*' + wv);
        // ek güvenlik: HW limiti aşılırsa (varsayılan 2) software'e düş -> 'continue' "too many" ile patlamasın
        const hwLimit = Number(vscode.workspace.getConfiguration('debugInspector').get('maxHardwareWatchpoints') ?? 2);
        const useSoftware = Object.keys(watchpoints).length >= hwLimit;
        if (useSoftware) await gdbExec(sess, 'set can-use-hw-watchpoints 0', fid);
        const res = (await gdbExec(sess, `watch ${target}`, fid)).toString().replace(/\s+/g, ' ').trim();
        if (useSoftware) await gdbExec(sess, 'set can-use-hw-watchpoints 1', fid);
        log?.info(`watchpoint: watch ${target} [${msg.expr}] (${useSoftware ? 'software' : 'hardware'})  ⇒  ${res || 'ok'}`);
        if (/no symbol|cannot|invalid|<<error/i.test(res)) {
          vscode.window.showErrorMessage(`Debug Inspector: watchpoint failed — ${res}`);
        } else {
          // HATA YOKSA izlenmiş işaretle (★) — numara parse'ına bağlı DEĞİL (cppdbg numarayı echo'lamayabilir).
          const m = res.match(/[Ww]atchpoint (\d+):/);
          let n = m ? parseInt(m[1], 10) : await findWatchNum(sess, fid, target);
          watchpoints[msg.expr] = Number.isFinite(n) ? n : -1;   // -1: numara bulunamadı ama izleniyor
          sendWatchpoints();
          vscode.window.showInformationMessage(`Debug Inspector: watchpoint set on ${msg.expr}${Number.isFinite(n) ? ' (#' + n + ')' : ''}${useSoftware ? ' (software — beyond the hardware limit)' : ''} — program stops when it changes.`);
        }
      } else if (msg?.type === 'unwatchpoint' && typeof msg.expr === 'string' && msg.expr) {
        // watchpoint'i kaldır (GDB 'delete <no>'); numara bilinmiyorsa info watchpoints'tan bul
        let n = watchpoints[msg.expr];
        if (lastStopped && (n === undefined || !Number.isFinite(n) || n < 0)) n = await findWatchNum(lastStopped.session, lastStopped.frameId, msg.expr);
        if (lastStopped && Number.isFinite(n) && n >= 0) await gdbExec(lastStopped.session, `delete ${n}`, lastStopped.frameId);
        delete watchpoints[msg.expr];
        sendWatchpoints();
        log?.info(`watchpoint removed: ${msg.expr} (#${n})`);
        vscode.window.showInformationMessage(`Debug Inspector: watchpoint removed — ${msg.expr}`);
      } else if (msg?.type === 'copyWatch' && typeof msg.text === 'string' && msg.text) {
        // VS Code'da watch ifadesi EKLEMEK için public API yok -> panoya kopyala, kullanıcı Watch'a yapıştırır
        vscode.env.clipboard.writeText(msg.text);
        log?.info(`watch expr copied: ${msg.text}`);
        vscode.window.showInformationMessage(`Watch expression copied — paste it into the Watch panel (Add Expression): ${msg.text}`);
      } else if (msg?.type === 'setSections') {
        sectionPrefs = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : [],
          touched: true   // kullanıcı seçim yaptı: bundan sonra config "hidden" yoksayılır
        };
        log?.debug(`webview: setSections order=[${sectionPrefs.order.join(', ')}] hidden=[${sectionPrefs.hidden.join(', ')}] reveal=${msg.reveal || '-'}`);
        extContext?.workspaceState.update(SECPREF_KEY, sectionPrefs);
        // reorder/hide tamamen istemci-tarafı (GDB yok); SADECE gösterilen bölüm(ler)i çek (tüm paneli değil).
        // reveal TEK ad YA DA DİZİ olabilir ("Show all": tüm yeni görünenler) -> sırayla refreshTarget (gdb mutex serileştirir).
        // Döngü canlı duruma saygılı olmalı (refresh()'in isHiddenNow/gen korumalarının karşılığı):
        //  - gen değişti (yeni durak/continued/config) -> kalanları BIRAK (tam refresh zaten kuracak / koşan programdan okunmaz)
        //  - öğe bu arada yeniden GİZLENDİ (Show all -> hemen Hide all) -> atla ("gizli asla çekilmez" invariantı)
        //  - bir öğe patlarsa kalanlar yüklensin (refresh()'in per-section try/catch'inin karşılığı) + pane'e açık hata
        const rv = Array.isArray(msg.reveal) ? msg.reveal : (msg.reveal ? [msg.reveal] : []);
        const revealGen = refreshGen;
        for (const r of rv) {
          if (typeof r !== 'string' || !r) continue;
          if (revealGen !== refreshGen) { log?.debug('reveal: cancelled (new stop/continue/config)'); break; }
          if ((sectionPrefs.hidden || []).includes(r)) { log?.debug(`reveal: "${r}" re-hidden mid-loop → skipped`); continue; }
          try { await refreshTarget(r); }
          catch (e: any) {
            log?.warn(`reveal: section "${r}" failed — ${e?.message ?? e}`);
            panel?.webview.postMessage({ type: 'patchSection', section: r, sec: { name: r, columnsAll: [], hidden: [], rows: [], summary: '', error: `section failed: ${e?.message ?? e}` }, ts: new Date().toLocaleTimeString() });
          }
        }
      } else if (msg?.type === 'editValue' && typeof msg.expr === 'string' && msg.expr) {
        // sağ-tık 'Edit value' -> GDB 'set var' ile debuggee'ye YAZ (yalnız editable alanlar)
        if (!lastStopped) { vscode.window.showWarningMessage('Debug Inspector: debugger not stopped — cannot edit.'); return; }
        const cur = typeof msg.current === 'string' ? msg.current : '';
        const val = await vscode.window.showInputBox({
          title: 'Debug Inspector — edit value (writes to the program!)',
          prompt: `set var ${msg.expr} =`,
          value: cur
        });
        if (val === undefined || val === '') return;   // iptal
        const frameId = lastStopped.frameId;   // durakta cache'li; ekstra stackTrace turu yok
        const res = (await gdbExec(lastStopped.session, `set var ${msg.expr} = ${val}`, frameId)).toString().replace(/\s+/g, ' ').trim();
        log?.info(`edit: set var ${msg.expr} = ${val}  ⇒  ${res || 'ok'}`);
        const errored = /no symbol|cannot|lvalue|error|invalid|<<error/i.test(res);
        if (errored) {
          vscode.window.showErrorMessage(`Debug Inspector: edit failed — ${res}`);
        } else if (msg.section && typeof msg.rowIndex === 'number' && typeof msg.label === 'string') {
          // ANINDA geri-bildirim: girilen değeri hücreye hemen yaz (re-fetch arka planda doğrular + bağımlı hücreleri yeniler)
          panel?.webview.postMessage({ type: 'patchRow', section: msg.section, rowIndex: msg.rowIndex, row: { [msg.label]: String(val) } });
        }
        // SADECE düzenlenen satırı yeniden çek (tüm paneli değil); bilinmiyorsa eski davranışa düş
        if (typeof msg.section === 'string' && msg.section) refreshRow(msg.section, typeof msg.rowIndex === 'number' ? msg.rowIndex : null);
        else doRefresh();
      } else if (msg?.type === 'export' && typeof msg.json === 'string') {
        // tüm görünür bölümlerin verisini JSON dosyasına dışa aktar
        const folder = vscode.workspace.workspaceFolders?.[0];
        const def = folder ? vscode.Uri.joinPath(folder.uri, 'debug-inspector-export.json') : vscode.Uri.file('debug-inspector-export.json');
        const uri = await vscode.window.showSaveDialog({ defaultUri: def, filters: { JSON: ['json'] }, saveLabel: 'Export' });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.json, 'utf8'));
        log?.info(`exported sections to ${uri.fsPath} (${msg.json.length} chars)`);
        vscode.window.showInformationMessage(`Debug Inspector: exported to ${uri.fsPath}`);
      }
    },
    null,
    context.subscriptions
  );
  panel.webview.html = getHtml();
}

function getHtml(): string {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0;
  }
  .topbar {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }
  .topbar h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: 0.2px; }
  .grow { flex: 1; }
  .pill {
    font-size: 11px; padding: 3px 10px; border-radius: 999px; font-weight: 600;
    background: rgba(46,204,113,0.18); color: #2ecc71;
  }
  .pill.run { background: rgba(241,196,15,0.20); color: #f1c40f; }
  .pill.paused { background: rgba(120,120,128,0.28); color: var(--vscode-foreground); opacity: 0.85; }
  .ts { font-size: 11px; opacity: 0.6; }
  .btn {
    appearance: none; cursor: pointer; font-family: inherit; font-size: 11px;
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .btn:hover { background: var(--vscode-list-hoverBackground); }

  /* arch seçici: üst barda 'arch' etiketi + açılır liste. Config'te arch bloğu yoksa gizli. */
  .archwrap { display: inline-flex; align-items: center; gap: 4px; }
  .archlbl { font-size: 10px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.4px; }
  .archsel { padding: 3px 6px; max-width: 140px; }

  .cols-menu {
    position: fixed; z-index: 50; min-width: 210px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
    border-radius: 8px; padding: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  .cols-menu.hidden { display: none; }
  .cols-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.55; padding: 2px 6px 6px; }
  .cols-item {
    display: flex; align-items: center; justify-content: flex-start;
    gap: 8px; padding: 5px 6px; border-radius: 5px;
  }
  .cols-item:hover { background: var(--vscode-list-hoverBackground); }
  .cols-item[draggable="true"] { cursor: grab; }
  .cols-item.row-dragging { opacity: 0.4; }
  .cols-item.drop-row {
    box-shadow: inset 0 3px 0 #3b9eff;
    background: rgba(59,158,255,0.22);
  }
  .cols-grip { opacity: 0.45; font-size: 12px; cursor: grab; user-select: none; }
  .cm-item { padding: 6px 12px; cursor: pointer; border-radius: 5px; white-space: nowrap; font-size: 12px; }
  .cm-item:hover { background: var(--vscode-list-hoverBackground); }
  /* Sections/Columns menüsü toplu aksiyonları: Show all / Hide all (iki menüde ORTAK görünüm) */
  .cols-actions { display: flex; gap: 4px; padding: 2px 4px 6px; border-bottom: 1px solid var(--vscode-widget-border, #333); margin-bottom: 4px; }
  .cols-actions .cm-item { flex: 1; text-align: center; border: 1px solid var(--vscode-widget-border, #3a3a3a); padding: 3px 8px; }
  .cols-item label { display: flex; align-items: center; gap: 7px; cursor: pointer; font-size: 12.5px; }
  .cols-move button {
    appearance: none; cursor: pointer; border: none; background: transparent;
    color: var(--vscode-foreground); font-size: 12px; padding: 2px 6px; border-radius: 4px;
  }
  .cols-move button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .cols-move button:disabled { opacity: 0.3; cursor: default; }

  .tabs { display: flex; gap: 4px; padding: 10px 12px 0; }
  .tab {
    appearance: none; border: none; cursor: pointer;
    font-family: inherit; font-size: 12.5px; font-weight: 600;
    padding: 7px 14px; border-radius: 8px 8px 0 0;
    color: var(--vscode-foreground); opacity: 0.6;
    background: transparent; border-bottom: 2px solid transparent;
  }
  .tab .badge-count {
    font-size: 11px; opacity: 0.8; margin-left: 6px;
    padding: 0 6px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .tab.active {
    opacity: 1;
    background: var(--vscode-list-hoverBackground);
    border-bottom: 2px solid var(--vscode-focusBorder, #3498db);
  }
  .tab.hidden { display: none; }
  .tab.drop-target { box-shadow: inset 0 -3px 0 #3b9eff; background: rgba(59,158,255,0.18); }

  .pane { padding: 0 16px 20px; }
  .pane.hidden { display: none; }
  .summary { font-size: 12px; opacity: 0.7; margin: 12px 2px 10px; }

  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td {
    text-align: left; padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
    white-space: nowrap;
  }
  th {
    position: sticky; top: 0; z-index: 1;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.16));
    color: var(--vscode-foreground);
    font-size: 11.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; opacity: 1;
    border-bottom: 2px solid var(--vscode-focusBorder, #3b9eff);
    cursor: pointer; user-select: none;
  }
  th:hover { background: var(--vscode-list-hoverBackground); }
  th.sorted { background: rgba(59,158,255,0.22); color: var(--vscode-foreground); }
  tbody td.sortcol { background: rgba(59,158,255,0.07); }
  th.dragging { opacity: 0.4; }
  th.drop-target {
    box-shadow: inset 4px 0 0 #3b9eff;
    background: rgba(59,158,255,0.22) !important;
  }
  th[draggable="true"] { cursor: pointer; }
  .sort-ind { font-size: 11px; margin-left: 4px; color: #3b9eff; font-weight: 700; }
  tbody tr:nth-child(even) td { background: rgba(128,128,128,0.05); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; opacity: 0.95; }
  td.idcol { font-weight: 700; opacity: 0.9; }
  .dash { opacity: 0.4; }
  .dash.err { opacity: 0.9; color: var(--vscode-errorForeground, #e74c3c); cursor: help; }
  .wp-star { color: #f1c40f; margin-right: 4px; font-size: 11px; }
  td[data-wp] { box-shadow: inset 2px 0 0 #f1c40f; }
  .grp-bar { margin: 10px 2px 6px; }
  .grp-toggle { font-size: 11px; }
  .collapse-all { font-size: 11px; }
  tr.grphdr td {
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.13)) !important;
    font-weight: 700; font-size: 12px; cursor: pointer;
  }
  tr.grphdr td:hover { background: var(--vscode-list-hoverBackground) !important; }
  tr.grphdr .caret { display: inline-block; width: 12px; opacity: 0.8; }
  .grpcnt {
    font-size: 11px; opacity: 0.85; margin-left: 6px; padding: 0 6px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 600;
  }

  /* per-tab tablo araç çubuğu: filtre / changed-only / sayı tabanı / kopya */
  .tbl-bar { display: flex; align-items: center; gap: 6px; margin: 10px 2px 8px; flex-wrap: wrap; }
  .tbl-filter {
    flex: 0 0 210px; font-family: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    background: var(--vscode-input-background, transparent);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
  }
  .tbl-filter::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.7)); }
  .btn.on { background: rgba(59,158,255,0.22); border-color: #3b9eff; color: var(--vscode-foreground); }

  /* sayısal kolonlar sağa hizalı + tabular figürler (tam değer her hücrede title'da) */
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* başlık içeriği: etiket solda, taban düğmesi sağda — FLEX (float değil) ki th genişliği düğmeye de yer ayırsın -> üst üste binmez */
  .thc { display: flex; align-items: center; gap: 8px; }
  .thc .th-name { flex: 1 1 auto; white-space: nowrap; }
  th.num .thc .th-name { text-align: right; }
  /* başlık sağ üstü: per-kolon sayı tabanı düğmesi (tıkla: raw→10→16→2) */
  .hb {
    flex: 0 0 auto; cursor: pointer; padding: 0 4px; border-radius: 3px;
    font-size: 9px; font-weight: 700; opacity: 0.5;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .hb:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .hb.on { opacity: 1; background: rgba(59,158,255,0.28); color: var(--vscode-foreground); }

  /* kullanım çubuğu (stack/progress) */
  .bar { position: relative; min-width: 120px; height: 16px; border-radius: 4px;
    background: rgba(128,128,128,0.18); overflow: hidden; }
  .barfill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
  .barfill.bok   { background: rgba(46,204,113,0.55); }
  .barfill.bwarn { background: rgba(241,196,15,0.6); }
  .barfill.bcrit { background: rgba(231,76,60,0.65); }
  .barlbl { position: relative; z-index: 1; display: block; text-align: center; font-size: 11px;
    line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* çapraz-referans link + hedef satır vurgusu */
  .xref { color: var(--vscode-textLink-foreground, #3b9eff); cursor: pointer; text-decoration: none; }
  .xref:hover { text-decoration: underline; }
  .srcref { color: var(--vscode-textLink-foreground, #3b9eff); cursor: pointer; text-decoration: none; }
  .srcref:hover { text-decoration: underline; }
  /* ⏱ timeline (round-robin / konumlu) görünümü — dataviz kuralları: çekinik eksen+grid, mürekkep etiket, legend */
  .tl-wrap { padding: 10px 12px 14px; overflow-x: auto; }
  .tl-lane { display: flex; align-items: stretch; padding: 2px 0; border-radius: 4px; }
  .tl-lane.tl-alt { background: rgba(255,255,255,0.02); }
  .tl-lname { flex: 0 0 130px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; color: #9da7b3; padding: 7px 10px 0 0; text-align: right; position: sticky; left: 0; z-index: 2; background: var(--vscode-editor-background, #161b22); }
  .tl-track { flex: 1 1 auto; display: flex; gap: 2px; min-height: 28px; border-left: 1px solid #2b3138; padding-left: 4px; }
  .tl-blk { display: flex; align-items: center; justify-content: center; min-width: 26px; border: 1px solid; border-radius: 3px; padding: 2px 6px; overflow: hidden; cursor: pointer; }
  .tl-blk:hover { filter: brightness(1.35); }
  .tl-blk > span { font-size: 11px; color: var(--vscode-foreground, #ccc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl-track.tl-pos { display: block; position: relative; height: 28px; overflow: hidden; }
  .tl-blk.tl-abs { position: absolute; top: 3px; bottom: 3px; min-width: 8px; box-sizing: border-box; }
  /* ⏱ timeline.set: bloklar alt-dizi (device kümesi) chip'i taşıyınca lane/blok yükselir + dikey düzen */
  .tl-track.tl-hasset { min-height: 56px; }
  .tl-track.tl-pos.tl-hasset { height: 56px; }
  .tl-blk.tl-hasset { flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 2px; padding: 3px 5px; }
  .tl-blk.tl-hasset > .tl-lbl { flex: 0 0 auto; }
  .tl-setrow { display: flex; align-items: flex-start; gap: 4px; flex: 1 1 0; min-height: 0; overflow: hidden; }   /* bir küme (device/signal) satırı; birden çok küme dikey paylaşır */
  .tl-scap { flex: 0 0 auto; font-size: 9.5px; line-height: 1.5; color: #8b949e; white-space: nowrap; }   /* küme başlığı (title verilmişse; chip'lerin solunda, dev/sig) */
  .tl-set { display: flex; flex-wrap: wrap; gap: 3px; overflow: hidden; align-content: flex-start; min-height: 0; flex: 1 1 auto; }
  .tl-chip { font-size: 9.5px; line-height: 1.45; border: 1px solid; border-radius: 3px; padding: 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; box-sizing: border-box; }
  .tl-chip.tl-more { color: #9da7b3; border-color: rgba(139,148,158,0.4); background: transparent !important; font-variant-numeric: tabular-nums; }   /* taşan device sayısı rozeti (+N) */
  .tl-chip.tl-chip-dash { border-style: dashed; }   /* set.dashWhen: koşul doğruysa cihaz chip'inin kenarı kesikli */
  .tl-grid { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed rgba(139,148,158,0.16); pointer-events: none; }
  .tl-lane.tl-axis { margin-bottom: 2px; }
  .tl-axistrack { border-left: none !important; border-bottom: 1px solid #2b3138; height: 16px !important; min-height: 16px; overflow: visible !important; }
  .tl-tick { position: absolute; bottom: 2px; font-size: 10px; color: #7d8590; font-variant-numeric: tabular-nums; }
  /* ⏱ timeline: blok tıklama -> detay kartı (graph gv-detail deseni), seçili blok, legend başlığı, total etiketi */
  .tl-blk.tl-sel { box-shadow: inset 0 0 0 2px var(--vscode-focusBorder, #58a6ff); z-index: 3; }
  .tl-detail { margin: 8px 0 4px 140px; max-width: min(460px, calc(100% - 152px)); background: var(--vscode-editor-background, #161b22); border: 1px solid #2b3138; border-radius: 6px; padding: 9px 11px; position: relative; }
  .tl-detail h4 { margin: 0 0 7px; font-size: 13px; font-weight: 500; padding-right: 14px; word-break: break-all; color: var(--vscode-foreground, #e6edf3); }
  .tl-detail .grow2 { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 2px 0; color: var(--vscode-descriptionForeground, #8a8a8a); font-size: 12px; }
  .tl-detail .grow2 b { color: var(--vscode-foreground, #e6edf3); font-weight: 500; text-align: right; display: inline-flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; align-items: center; overflow-wrap: anywhere; }
  .tl-dclose { position: absolute; top: 6px; right: 9px; cursor: pointer; opacity: 0.6; }
  .tl-dclose:hover { opacity: 1; }
  .tl-tcap { font-size: 11px; color: #9da7b3; margin: 2px 0 3px 140px; font-variant-numeric: tabular-nums; }
  .tl-lgcap { font-size: 11px; color: #c9d1d9; font-weight: 600; margin-right: 2px; }
  .tl-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 10px 0 0 140px; align-items: center; }
  .tl-lgitem { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #9da7b3; }
  .tl-lgsw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .tl-lgmore { color: #7d8590; }
  .tl-chart { display: inline-block; vertical-align: top; min-width: 260px; box-sizing: border-box; padding: 4px 12px 8px 0; }
  .tl-ctitle { font-size: 12px; font-weight: 600; color: #c9d1d9; margin: 2px 0 4px 140px; }
  .tl-ctot { color: #7d8590; font-weight: 400; }
  .tl-zoomgrp { display: inline-flex; align-items: center; gap: 2px; }
  .tl-zoomlbl { font-size: 11px; color: #8b949e; min-width: 26px; text-align: center; font-variant-numeric: tabular-nums; }
  .tl-hint { font-size: 11px; color: #8b949e; align-self: center; }
  @keyframes rowflash { from { background: rgba(59,158,255,0.55); } to { background: transparent; } }
  tbody tr.rowflash td { animation: rowflash 1.6s ease-out; }

  .badge { font-size: 11px; padding: 2px 9px; border-radius: 5px; font-weight: 600; display: inline-block; }
  .vmap { font-weight: 500; }   /* renksiz valueMap metni (yalnız metin değiştirildi) */
  .flags { display: inline-flex; gap: 4px; align-items: center; flex-wrap: wrap; }   /* bayrak alanı: set bitlerin rozetleri */
  .flag-res { font-size: 11px; opacity: 0.55; }   /* eşlenmeyen kalan bitler (+0x..) */
  .s-run   { background: rgba(46,204,113,0.18); color: #2ecc71; }
  .s-ready { background: rgba(52,152,219,0.18); color: #3498db; }
  .s-block { background: rgba(231,76,60,0.18);  color: #e74c3c; }
  .s-wait  { background: rgba(241,196,15,0.20); color: #f1c40f; }
  .disc    { background: rgba(155,89,182,0.18); color: #b07cc6; }
  .warn { color: #f1c40f; font-weight: 700; }
  .crit { color: #e74c3c; font-weight: 700; }

  .empty { opacity: 0.55; padding: 28px 4px; font-size: 13px; }
  .empty.loading { font-style: italic; animation: di-pulse 1.2s ease-in-out infinite; }
  /* akış önizlemesi başlığı: satırlar gelirken "Loading… N rows" (yükleme sürdüğünü belirtir) */
  .summary.loading { opacity: 1; animation: di-pulse 1.2s ease-in-out infinite; }
  .summary.loading::before { content: "⟳ "; display: inline-block; }
  @keyframes di-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.7; } }
  @keyframes di-spin { to { transform: rotate(360deg); } }
  .btn.busy { opacity: 0.75; }
  .btn .ricon { display: inline-block; }
  .btn.busy .ricon { animation: di-spin 0.8s linear infinite; }
  .tab.updating::after { content: '⟳'; display: inline-block; margin-left: 5px; opacity: 0.7; font-size: 11px; animation: di-spin 0.8s linear infinite; }

  .pill.chg { background: rgba(241,196,15,0.20); color: #f1c40f; }
  td.changed {
    background: rgba(241,196,15,0.16) !important;
    box-shadow: inset 2px 0 0 #f1c40f;
  }
  .old { opacity: 0.45; font-size: 11px; margin-left: 7px; text-decoration: line-through; }
  .drag-ghost {
    position: fixed; top: -1000px; left: -1000px; pointer-events: none;
    background: #3b9eff; color: #fff; font-size: 12px; font-weight: 700;
    padding: 5px 11px; border-radius: 6px; box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    white-space: nowrap;
  }
  .tab.haschg .badge-count { background: #f1c40f; color: #1e1e1e; }

  /* ---- Graph view (Phase 1) ---- */
  .gv-wrap { position: relative; margin-top: 4px; }
  .gv-svg {
    width: 100%; height: 70vh; min-height: 340px; display: block;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    border-radius: 10px; cursor: grab; user-select: none;
  }
  .gv-svg.panning { cursor: grabbing; }
  .gnode { cursor: grab; transition: opacity 0.12s; }
  .gnode.gv-dragging { cursor: grabbing; }
  .gnode.gv-dragging .card { stroke: var(--vscode-focusBorder, #3b9eff); stroke-width: 2; }
  .gnode .card {
    fill: var(--vscode-editorWidget-background, rgba(128,128,128,0.10));
    stroke: var(--vscode-panel-border, rgba(128,128,128,0.4)); stroke-width: 1;
    transition: stroke 0.12s;
  }
  .gnode:hover .card, .gnode.sel .card { stroke: var(--vscode-focusBorder, #3b9eff); }
  .gnode.sel .card { stroke-width: 2; }
  .gnode.gv-group .card { fill: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.18)); }
  .gnode .gtitle { fill: var(--vscode-foreground); font-size: 12.5px; font-weight: 600; }
  .gnode .gsub { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 10.5px; }
  .gnode .flab { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 10.5px; }
  .gnode .fval { fill: var(--vscode-foreground); font-size: 10.5px; }
  .gnode.dim { opacity: 0.16; }
  .gedge { fill: none; stroke: #7d8590; stroke-width: 1.5; transition: opacity 0.12s, stroke 0.12s, stroke-width 0.12s; }
  .gedge.dim { opacity: 0.1; }
  .gedge.ehl { stroke: #3b9eff; stroke-width: 2.5; }
  .gedge.link { stroke: #b07cc6; stroke-dasharray: 5 4; }
  .gedge.link.ehl { stroke: #c79fda; stroke-width: 2.5; }
  .gnode.gv-ghost .card { fill: rgba(176,124,198,0.10); stroke: #b07cc6; stroke-dasharray: 4 3; }
  .gnode.gv-ghost:hover .card, .gnode.gv-ghost.sel .card { stroke: #c79fda; stroke-dasharray: none; }
  .ghdr { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
  .gbarbg { fill: rgba(128,128,128,0.24); }
  .gpct { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 9.5px; }
  .gv-detail {
    position: absolute; top: 12px; right: 12px; width: auto; min-width: 232px; max-width: calc(100% - 24px);
    max-height: calc(100% - 28px); overflow: auto;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    border-radius: 9px; padding: 11px 13px; font-size: 12px; display: none;
    box-shadow: 0 4px 18px rgba(0,0,0,0.4);
  }
  .gv-detail h3 { margin: 0 0 7px; font-size: 13px; padding-right: 14px; word-break: break-all; }
  /* etiket solda, değer sağda; değer büyürse panel YANA genişler (max-width'e kadar), sonra ALTA sarar -> veri kesilmez */
  .gv-detail .grow2 { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 2px 0; color: var(--vscode-descriptionForeground, #8a8a8a); }
  .gv-detail .grow2 > span { flex: 0 0 auto; }
  .gv-detail .grow2 b { color: var(--vscode-foreground); font-weight: 500; overflow-wrap: anywhere; text-align: right; display: inline-flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; align-items: center; }
  .gv-detail .gd-int { color: var(--vscode-descriptionForeground, #8a8a8a); font-weight: 400; }
  .gv-detail .close { position: absolute; top: 7px; right: 10px; cursor: pointer; opacity: 0.6; }
  .gv-detail .close:hover { opacity: 1; }
  .gv-banner { font-size: 11px; opacity: 0.7; margin: 6px 2px; }
  .gv-empty { opacity: 0.55; padding: 28px 4px; font-size: 13px; }
  /* graph paneli detay gösterirken yana genişler (sub-table sığsın) */
  .gv-detail.gv-detail-wide { max-width: min(560px, calc(100% - 24px)); }

  /* ---- Talep-üzerine detay (selectedFrom + \${selected}) ---- */
  .detrow > td { padding: 0 !important; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06)); }
  .det-wrap { padding: 6px 10px 9px 22px; border-left: 3px solid var(--vscode-focusBorder, #3b9eff); }
  .det-head { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0 6px; }
  .det-head b { font-weight: 600; }
  .det-cnt { opacity: 0.6; font-size: 11px; }
  .det-x { cursor: pointer; opacity: 0.55; margin-left: auto; padding: 0 4px; }
  .det-x:hover { opacity: 1; }
  .det-wrap table { width: 100%; }
  .det-load, .det-empty { opacity: 0.6; font-size: 12px; padding: 4px 0; }
  .det-ingraph { padding: 4px 0 0; border-left: 0; }
  .det-ingraph table { font-size: 11px; }

  /* ---- Graph Phase 3: search / minimap / level-of-detail ---- */
  .gv-search {
    flex: 0 0 150px; font-family: inherit; font-size: 12px; padding: 3px 9px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    background: var(--vscode-input-background, transparent);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
  }
  .gv-search::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.7)); }
  .gv-srch-n { font-size: 11px; opacity: 0.7; min-width: 26px; }
  .gnode.gv-hit .card { stroke: #f1c40f; stroke-width: 2; }
  .gnode.gv-fade { opacity: 0.12; }
  .gedge.gv-fade { opacity: 0.06; }
  .gnode.gv-cur .card { stroke: #f39c12; stroke-width: 3; filter: drop-shadow(0 0 5px rgba(241,196,15,0.7)); }
  .gnode.gv-blink .card { animation: gvblink 1.6s ease-out; }
  @keyframes gvblink { 0%,30%,60% { stroke: #3b9eff; stroke-width: 4; } 15%,45%,100% { stroke: #3b9eff; stroke-width: 1; } }
  .gv-mini {
    position: absolute; left: 12px; bottom: 12px; width: 180px; height: 120px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,0.45); cursor: pointer; opacity: 0.94; overflow: hidden;
  }
  .gv-mini.hidden { display: none; }
  .gv-mini .mnode { opacity: 0.8; }
  .gv-mini .mnode.gm-hit { fill: #f1c40f; opacity: 1; }
  .gv-mini .gv-vp { fill: rgba(59,158,255,0.16); stroke: #3b9eff; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .gv-wrap.lod-far .gnode .gtitle, .gv-wrap.lod-far .gnode .gsub, .gv-wrap.lod-far .gnode .gpct,
  .gv-wrap.lod-far .gnode .flab, .gv-wrap.lod-far .gnode .fval,
  .gv-wrap.lod-far .gnode .gbarbg, .gv-wrap.lod-far .gnode .gbarfill, .gv-wrap.lod-far .gnode circle { display: none; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Debug Inspector</h1>
    <span id="status" class="pill">—</span>
    <span id="changes" class="pill chg hidden"></span>
    <span class="grow"></span>
    <span id="ts" class="ts"></span>
    <span id="arch-wrap" class="archwrap hidden"><span class="archlbl">arch</span><select id="arch-sel" class="btn archsel" title="Active architecture overlay — resolves 'common' + this arch in the config. Only shown when the config defines arch blocks."></select></span>
    <button id="config-btn" class="btn" title="Open the config file (debug-inspector.json)">⚙ Config</button>
    <button id="sections-btn" class="btn" title="Show / hide sections (tabs)">▤ Sections</button>
    <button id="export-btn" class="btn" title="Export all sections' data as JSON">⤓ JSON</button>
    <button id="pause" class="btn" title="Pause/resume auto-refresh on each stop">⏸ Pause</button>
    <button id="refresh" class="btn" title="Re-read config and refresh now"><span class="ricon">⟳</span> <span class="rlabel">Refresh</span></button>
  </div>
  <div class="cols-menu hidden" id="sections-menu"></div>

  <div class="tabs" id="tabs"></div>
  <div id="panes">
    <div class="empty" style="padding: 28px 18px;">Sections from your config appear here when the debugger stops.</div>
  </div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const tsEl = document.getElementById('ts');
  const tabsEl = document.getElementById('tabs');
  const panesEl = document.getElementById('panes');

  const secState = {};       // name -> {sec, sortCol, sortDir, changed, changeCount, order, hidden}
  let currentNames = [];     // görünür sekme adları (DOM index'leriyle eşleşir)
  let watchedExprs = new Set();   // watchpoint kurulu l-value ifadeleri (★ + menüde Add/Remove)
  let hiddenSections = [];   // gizli sekme adları (Sections menüsünden açılabilir)
  let sectionOrder = [];     // TEK interleaved sıra (görünür+gizli), gerçek konumda
  let detailDefs = {};       // master adı -> [detay bölüm adı]; sağ-tık "Show detailed info" menüsü için (beginUpdate ile gelir)
  let openDet = [];          // açık talep-üzerine detaylar: [{master, sel, detail, sec}] (sel = seçilen satırın kararlı eleman ifadesi)
  function findDet(master, sel, detail) { return openDet.find(function (d) { return d.master === master && d.sel === sel && d.detail === detail; }); }
  let activeName = null;

  let refreshFallback = null;
  function setRefreshing(on) {
    const b = document.getElementById('refresh');
    if (!b) return;
    b.classList.toggle('busy', !!on);
    const lbl = b.querySelector('.rlabel');
    if (lbl) lbl.textContent = on ? 'Refreshing…' : 'Refresh';
  }
  document.getElementById('refresh').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'refresh' });
    setRefreshing(true);   // anında görsel geri-bildirim (beginUpdate gelene kadar)
    if (refreshFallback) clearTimeout(refreshFallback);
    refreshFallback = setTimeout(() => setRefreshing(false), 4000);   // durmuş değil / akış gelmezse temizle
  });

  let paused = ${paused};
  const pauseBtn = document.getElementById('pause');
  function updatePauseUI() {
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    pauseBtn.title = paused ? 'Resume auto-refresh on each stop' : 'Pause auto-refresh on each stop';
    if (paused) { statusEl.textContent = 'paused'; statusEl.className = 'pill paused'; }
  }
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    vscodeApi.postMessage({ type: 'setPaused', paused: paused });
    if (!paused) { statusEl.textContent = '—'; statusEl.className = 'pill'; }
    updatePauseUI();
  });
  updatePauseUI();

  function cap(s) { s = String(s); return s.length ? s[0].toUpperCase() + s.slice(1) : s; }
  function idxOf(name) { return currentNames.indexOf(name); }
  function bodyEl(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('body-' + i); }
  function colsMenuEl(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('cols-' + i); }
  function tabElOf(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('tab-' + i); }
  function cntElOf(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('cnt-' + i); }

  function ensureLayout(names) {
    if (JSON.stringify(names) === JSON.stringify(currentNames)) return;
    currentNames = names.slice();
    if (!names.length) {
      tabsEl.innerHTML = '';
      panesEl.innerHTML = '<div class="empty" style="padding:28px 18px;">No sections found in the config.</div>';
      activeName = null;
      return;
    }
    tabsEl.innerHTML = names.map((n, i) =>
      '<button class="tab" data-idx="' + i + '" id="tab-' + i + '" draggable="true" title="Click: switch  ·  Drag: reorder">' + esc(cap(n)) +
      '<span class="badge-count" id="cnt-' + i + '">0</span></button>').join('');
    panesEl.innerHTML = names.map((n, i) =>
      '<div class="pane' + (i === 0 ? '' : ' hidden') + '" data-idx="' + i + '" id="pane-' + i + '">' +
        '<div class="cols-menu hidden" id="cols-' + i + '"></div>' +
        '<div class="pane-body" id="body-' + i + '"></div>' +
      '</div>').join('');
    if (idxOf(activeName) === -1) activeName = names[0];
    applyActive();
    notifyActive();   // uzantı o anki aktif sekmeyi bilsin (öncelik için)
  }

  function applyActive() {
    for (const t of tabsEl.querySelectorAll('.tab'))
      t.classList.toggle('active', currentNames[+t.dataset.idx] === activeName);
    for (const p of panesEl.querySelectorAll('.pane'))
      p.classList.toggle('hidden', currentNames[+p.dataset.idx] !== activeName);
  }

  function notifyActive() { if (activeName) vscodeApi.postMessage({ type: 'activeTab', section: activeName }); }
  function switchTab(name) {
    activeName = name;
    const t = tabElOf(name);
    if (t) t.classList.remove('haschg');
    applyActive();
    if (secState[name] && secState[name].sec) paint(name);   // taze boya: çapraz-link eşleşmesi + sıralama korunur
    notifyActive();   // uzantı sıradaki öncelik için bu sekmeyi öne alsın
  }

  // çapraz-referans: hedef bölüme git ve 'match' kolonu 'value' olan satırı vurgula
  function gotoXref(targetSec, matchCol, value) {
    if (!targetSec) return;
    if (currentNames.indexOf(targetSec) === -1) {
      // hedef gizli: göster (veri async gelir; bu turda vurgulanamaz)
      if (sectionOrder.indexOf(targetSec) !== -1) {
        hiddenSections = hiddenSections.filter(x => x !== targetSec);
        buildSectionsMenu(); sendSections(targetSec);
      }
      return;
    }
    const st = secState[targetSec];
    if (st && st.sec && st.view === 'timeline') { st.view = 'table'; paint(targetSec); }   // timeline'da satır vurgusu yok -> tabloya geç
    if (st && st.sec) {
      const vis = st.order.filter(l => st.hidden.indexOf(l) === -1);
      if (!matchCol) matchCol = vis[0];
      // gruplu ağaçta: eşleşen satırın grubunu (kapalıysa) aç ki DOM'da render olsun
      if (st.sec.grouped && !st.flat) {
        for (const g of (st.sec.groups || [])) {
          if ((g.rows || []).some(r => String(r[matchCol]) === String(value))) {
            const ci = (st.collapsed || []).indexOf(g.key);
            if (ci !== -1) { st.collapsed.splice(ci, 1); paint(targetSec); }
            break;
          }
        }
      }
    }
    switchTab(targetSec);
    const tst = secState[targetSec];
    if (tst && tst.view === 'graph' && typeof tst._focusNode === 'function') tst._focusNode(matchCol, value);   // graph hedefi: node'a merkezlen + blink (tablo satırı yerine)
    else highlightRow(targetSec, matchCol, value);
  }
  function highlightRow(targetSec, matchCol, value) {
    const body = bodyEl(targetSec); const st = secState[targetSec];
    if (!body || !st) return;
    const vis = st.order.filter(l => st.hidden.indexOf(l) === -1);
    let idx = matchCol ? vis.indexOf(matchCol) : 0; if (idx < 0) idx = 0;
    const tbl = body.querySelector('table'); if (!tbl) return;
    for (const tr of tbl.querySelectorAll('tbody tr')) {
      if (tr.classList.contains('grphdr')) continue;
      const cell = tr.children[idx];
      if (cell && (cell.getAttribute('title') === String(value) || cell.textContent.trim() === String(value))) {
        if (tr.scrollIntoView) tr.scrollIntoView({ block: 'center' });
        tr.classList.add('rowflash');
        setTimeout(() => tr.classList.remove('rowflash'), 1600);
        return true;
      }
    }
    return false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }
  function stateClass(v) {
    const s = String(v).toLowerCase();
    if (s.includes('run'))   return 's-run';
    if (s.includes('ready')) return 's-ready';
    if (s.includes('block')) return 's-block';
    if (s.includes('wait'))  return 's-wait';
    return '';
  }
  // config-driven rozet: değer -> renk (field.badge)
  var BADGE_COLORS = { green:'#2ecc71', blue:'#3498db', red:'#e74c3c', amber:'#f1c40f', yellow:'#f1c40f', orange:'#e67e22', purple:'#b07cc6', cyan:'#1abc9c', gray:'#9aa0a6', grey:'#9aa0a6' };
  function badgeHex(name) {
    if (!name) return null;
    var k = String(name).toLowerCase();
    if (BADGE_COLORS[k]) return BADGE_COLORS[k];
    return /^#[0-9a-fA-F]{6}$/.test(name) ? name : null;
  }
  function matchBadge(map, val) {
    if (!map) return null;
    var v = String(val).trim().toLowerCase();
    for (var k in map) { if (String(k).trim().toLowerCase() === v) return map[k]; }
    return null;
  }
  // config-driven değer eşlemesi: değer -> {text?, color?}. Önce ham değeri, sonra tırnaksız (shortVal) biçimi dener (enum char* "init" gibi).
  function matchValueMap(map, val) {
    if (!map) return null;
    var v = String(val).trim().toLowerCase();
    for (var k in map) { if (String(k).trim().toLowerCase() === v) return map[k]; }
    var sv = String(shortVal(val)).trim().toLowerCase();
    if (sv !== v) { for (var k2 in map) { if (String(k2).trim().toLowerCase() === sv) return map[k2]; } }
    return null;
  }
  // valueMap girdisini render edilebilir {text, hex} ikilisine çevir (color adı veya #rrggbb -> hex)
  function valueMapEntry(map, val, fallbackText) {
    var vm = matchValueMap(map, val);
    if (!vm) return null;
    var text = (vm.text != null && vm.text !== '') ? vm.text : fallbackText;
    return { text: text, hex: badgeHex(vm.color) };
  }
  function asNum(v){ const m=String(v).match(/-?\\d+/); return m?parseInt(m[0],10):NaN; }
  // BAYRAK: değeri ve maske anahtarlarını int'e çevir (hex 0x.. veya dec)
  function toBits(v){ var s=String(v==null?'':v).trim(); var h=s.match(/^[+-]?0x[0-9a-fA-F]+/); if(h) return parseInt(h[0],16); var d=s.match(/-?\\d+/); return d?parseInt(d[0],10):NaN; }
  // integer'ın set bitlerini maske haritasına göre çöz: { items:[{text,hex}], residual } | null
  function flagDecode(map, raw){
    if(!map) return null;
    var n=toBits(raw); if(isNaN(n)) return null;
    var nu=n>>>0, items=[], covered=0;
    var keys=Object.keys(map).map(function(k){ return { k:k, m:(toBits(k)>>>0) }; }).filter(function(x){ return x.m>0; }).sort(function(a,b){ return a.m-b.m; });
    keys.forEach(function(x){ if((nu & x.m)===x.m){ var e=map[x.k]; items.push({ text:(e.text!=null&&e.text!=='')?e.text:('0x'+x.m.toString(16)), hex:badgeHex(e.color) }); covered=(covered|x.m)>>>0; } });
    var residual=(nu & ~covered)>>>0;
    if(!items.length && !residual) return null;   // değer 0 / hiç bit yok -> ham göster
    return { items:items, residual:residual };
  }
  function flagsHtml(map, raw){
    var d=flagDecode(map, raw); if(!d) return null;
    var h='';
    d.items.forEach(function(it){ h += it.hex ? '<span class="badge" style="background:'+it.hex+'30;color:'+it.hex+'">'+esc(it.text)+'</span>' : '<span class="vmap">'+esc(it.text)+'</span>'; });
    if(d.residual) h += '<span class="flag-res">+0x'+d.residual.toString(16)+'</span>';
    return '<span class="flags">'+h+'</span>';
  }
  function flagsText(map, raw){
    var d=flagDecode(map, raw); if(!d) return null;
    var parts=d.items.map(function(it){ return it.text; });
    if(d.residual) parts.push('+0x'+d.residual.toString(16));
    return parts.join(' ');
  }
  // graph kartı için flag'leri RENKLİ <tspan>'lar olarak çiz (her flag kendi rengiyle); maxc karakter bütçesi -> flag sınırında … ile kısalt
  function flagsTspans(map, raw, maxc){
    var d=flagDecode(map, raw); if(!d) return null;
    var spans='', used=0, first=true, trunc=false;
    for(var i=0;i<d.items.length;i++){
      var it=d.items[i], piece=(first?'':' ')+it.text;
      if(!first && used+piece.length>maxc){ trunc=true; break; }
      spans += '<tspan'+(it.hex?' fill="'+it.hex+'"':'')+'>'+esc(piece)+'</tspan>';
      used+=piece.length; first=false;
    }
    if(!trunc && d.residual){ var rp=(first?'':' ')+'+0x'+d.residual.toString(16); if(first||used+rp.length<=maxc){ spans+='<tspan fill="#8a8a8a">'+esc(rp)+'</tspan>'; } else trunc=true; }
    if(trunc) spans+='<tspan fill="#8a8a8a">…</tspan>';
    return spans;
  }

  // Erişilemeyen (gdb hata/erişim yok) veya NULL pointer (0x0) -> "-"
  function isUnreadable(v) {
    const s = v == null ? '' : String(v);
    return /^<<error/i.test(s) || /cannot access memory|no symbol|optimized out|<error reading/i.test(s);
  }
  function isNullPtr(v) {
    const t = (v == null ? '' : String(v)).trim();
    return /^(\\([^)]*\\)\\s*)?0x0+$/.test(t);   // 0x0, 0x00, "(tcb_t *) 0x0"
  }
  function isDash(v) { return isUnreadable(v) || isNullPtr(v); }

  // Stiller artık bölüm türüne değil, KOLON ADINA göre uygulanır (generic)
  function cell(col, val) {
    // erişilemeyen/HATA -> kırmızı ⚠ (tooltip'te temiz mesaj); NULL/0x0 -> sade '-' (ayrı görünür)
    if (isUnreadable(val)) {
      const msg = String(val).replace(/^<<error:\\s*/, '').replace(/>>$/, '').trim() || 'unreadable';
      return '<span class="dash err" title="' + esc(msg) + '">⚠</span>';
    }
    if (isNullPtr(val)) return '<span class="dash" title="' + esc(val) + '">-</span>';
    const lc = String(col).toLowerCase();
    if (lc.includes('state') || lc.includes('durum'))
      return '<span class="badge ' + stateClass(val) + '">' + esc(val) + '</span>';
    if (lc.includes('discipline'))
      return '<span class="badge disc">' + esc(val) + '</span>';
    if (lc === 'id') return '<span class="idcol">' + esc(val) + '</span>';
    return esc(val);
  }

  function isMono(col) {
    const lc = String(col).toLowerCase();
    return lc.includes('stack') || lc.includes('sp') || lc.includes('name') ||
           lc.includes('addr') || lc.includes('ptr');
  }

  function parseNum(v) {
    const s = String(v).trim();
    if (/^[-+]?0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^[-+]?\\d+(\\.\\d+)?$/.test(s)) return parseFloat(s);
    return NaN;
  }
  function compareVals(a, b) {
    const na = parseNum(a), nb = parseNum(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // Satır kimliği = ilk kolonun değeri (genelde ID). Değişen hücreleri bulur.
  function rowKeyOf(row, columns) {
    return columns.length ? String(row[columns[0]] ?? '') : '';
  }
  function computeChanges(prevRows, newRows, columns) {
    const map = {};
    let count = 0;
    if (!prevRows) return { map, count };
    const prevByKey = {};
    for (const r of prevRows) prevByKey[rowKeyOf(r, columns)] = r;
    for (const r of newRows) {
      const p = prevByKey[rowKeyOf(r, columns)];
      if (!p) continue; // yeni satır: vurgulama
      for (const c of columns) {
        const nv = String(r[c] ?? ''), pv = String(p[c] ?? '');
        if (nv !== pv) {
          map[rowKeyOf(r, columns) + '\\u0000' + c] = pv;  // eski değeri sakla
          count++;
        }
      }
    }
    return { map, count };
  }

  // --- sayısal kolon algısı + hex/dec biçimleme ---
  function isNumStr(v) { const t = String(v).trim(); return /^-?\\d+$/.test(t) || /^0x[0-9a-fA-F]+$/.test(t); }
  function toIntVal(v) { const t = String(v).trim(); if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16); if (/^-?\\d+$/.test(t)) return parseInt(t, 10); return null; }
  function fmtNum(v, base) {
    if (!base || base === 'raw') return v;
    const n = toIntVal(v); if (n === null) return v;
    if (base === 'hex') return (n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16));
    if (base === 'bin') return (n < 0 ? '-0b' + (-n).toString(2) : '0b' + n.toString(2));
    return String(n); // dec
  }
  function nextBase(b) { return b === 'raw' ? 'bin' : b === 'bin' ? 'dec' : b === 'dec' ? 'hex' : 'raw'; }   // raw → 2 → 10 → 16 → raw
  function baseLbl(b) { return (b === 'dec' || b === 'hex' || b === 'bin') ? b : 'raw'; }
  function numericCols(columns, rows) {
    const set = {};
    for (const c of columns) {
      let n = 0, tot = 0;
      for (const r of rows) { const v = r[c]; if (v == null || v === '' || isDash(v)) continue; tot++; if (isNumStr(v)) n++; }
      if (tot > 0 && n / tot >= 0.6) set[c] = true;
    }
    return set;
  }
  // Bu bölümün GİDEN (kendi link alanları) VEYA GELEN (başka bölüm buna link veriyor) linki var mı
  function sectionHasLinks(secObj) {
    if (secObj.links && Object.keys(secObj.links).length) return true;
    var nm = secObj.name;
    for (var k in secState) { var os = secState[k]; if (os && os.sec && os.sec.links) { for (var c in os.sec.links) if (os.sec.links[c].section === nm) return true; } }
    return false;
  }
  // --- araç çubuğu (filtre / changed-only / kopya); sayı tabanı artık per-kolon (▦ Columns) ---
  function toolbarHtml(st) {
    let h = '<div class="tbl-bar">';
    if (st.view === 'timeline') {
      const t = st.sec.timeline || {};
      h += '<span class="tl-hint" title="timeline config: lane/start/width/total/order/label/color">⏱ ' + esc(t.lane ? ('lane: ' + t.lane) : (st.sec.grouped ? 'lane: group' : 'single lane')) + (t.start ? (' · start: ' + esc(t.start)) : (t.order ? (' · order: ' + esc(t.order)) : '')) + (t.width ? (' · width: ' + esc(t.width)) : '') + (t.chart ? (' · chart: ' + esc(t.chart)) : '') + (t.total != null ? (' · total: ' + esc(String(t.total)) + (t.unit ? (' ' + esc(String(t.unit))) : '')) : '') + '</span>';
      // Çoklu grafik (t.chart) varsa ÖLÇEK toggle'ı: proportional (gerçek uzunluk oranı) <-> normalize (her grafik tam genişlik).
      // Bazı grafikler orantılı modda çok küçük kaldığında normalize okunur kılar. Varsayılan config'teki t.scale; kullanıcı anlık çevirir.
      if (t.chart) {
        const fit = st.tlFit != null ? st.tlFit : (t.scale === 'fit');
        h += '<button class="btn tl-fit-toggle' + (fit ? ' on' : '') + '" title="' + (fit ? 'Normalized: every chart uses the full width. Click for proportional (width scaled to total).' : 'Proportional: each chart width scaled to its total. Click to normalize (every chart full width).') + '">' + (fit ? '◱ Normalized' : '⤢ Normalize') + '</button>';
      }
      if (t.start) {   // YATAY ZOOM (konumlu mod): pane'e sigdirmak yerine genislet -> kucuk bloklar okunur, yatay scroll
        const z = (st.tlZoom && st.tlZoom > 1) ? st.tlZoom : 1;
        h += '<span class="tl-zoomgrp"><button class="btn tl-zoom-out" title="Zoom out (narrower)"' + (z <= 1 ? ' disabled' : '') + '>−</button>';
        h += '<span class="tl-zoomlbl" title="Horizontal zoom (fit-to-width at 1×)">' + (z > 1 ? (z + '×') : 'Fit') + '</span>';
        h += '<button class="btn tl-zoom-in" title="Zoom in (wider — small blocks readable)">+</button></span>';
      }
      h += '<span class="grow"></span>';
      h += '<button class="btn view-toggle" data-view="table" title="Switch back to the table view">▤ Table</button>';
      h += '<button class="btn view-toggle" data-view="graph" title="Show this section as a node graph">◉ Graph</button>';
      h += '<button class="btn cols-btn" title="Show / hide / reorder columns (label/tooltip fields)">▦ Columns</button>';
      h += '</div>';
      return h;
    }
    if (st.view === 'graph') {
      h += '<button class="btn graph-fit" title="Fit the graph to the view">⤢ Fit</button>';
      if (sectionHasLinks(st.sec)) h += '<button class="btn links-toggle' + ((st.gv && st.gv.links) ? ' on' : '') + '" title="Show cross-section relationship links (purple) — outgoing and incoming">⇄ Links</button>';
      h += '<input class="gv-search" type="text" placeholder="Find — text or field>=3" value="' + esc((st.gv && st.gv.q) || '') + '" title="Find nodes by text, or a field test like count>=3 / state=running (operators > >= < <= = !=). Enter / Shift+Enter to cycle, Esc to clear">';
      h += '<span class="gv-srch-n"></span>';
      h += '<span class="grow"></span>';
      h += '<button class="btn view-toggle" data-view="table" title="Switch back to the table view">▤ Table</button>';   // görünüm butonları her görünümde SAĞDA
      if (st.sec.timeline) h += '<button class="btn view-toggle" data-view="timeline" title="Show this section as a round-robin timeline">⏱ Timeline</button>';
      h += '<button class="btn map-toggle' + ((st.gv && st.gv.mini) ? ' on' : '') + '" title="Show / hide the minimap">◉ Map</button>';
      h += '<button class="btn cols-btn" title="Show / hide / reorder the fields shown on cards">▦ Fields</button>';
      h += '</div>';
      return h;
    }
    h += '<input class="tbl-filter" type="text" placeholder="Filter — text or PID>=3" value="' + esc(st.filter || '') + '" title="Filter rows by text, or a field test like PID>=3 / state=running (operators > >= < <= = !=); combine several">';
    if (st.sec.grouped) {
      h += '<button class="btn grp-toggle">' + (st.flat ? '⊞ Tree' : '☰ Flat') + '</button>';
      if (!st.flat) {
        var grps = st.sec.groups || [], col = st.collapsed || [];
        var allCol = grps.length > 0 && grps.every(function (g) { return col.indexOf(g.key) !== -1; });
        h += '<button class="btn collapse-all" title="Collapse or expand all groups">' + (allCol ? '⊞ Expand all' : '⊟ Collapse all') + '</button>';
      }
    }
    else if (st.changeCount > 0) h += '<button class="btn chg-only' + (st.changedOnly ? ' on' : '') + '" title="Show only changed rows">Δ Changed</button>';
    h += '<span class="grow"></span>';
    h += '<button class="btn view-toggle" data-view="graph" title="Show this section as a node graph">◉ Graph</button>';
    if (st.sec.timeline) h += '<button class="btn view-toggle" data-view="timeline" title="Show this section as a round-robin timeline (lanes/order/label from the timeline config)">⏱ Timeline</button>';   // yalnız config'te "timeline" tanımlı bölümlerde
    h += '<button class="btn cols-btn" title="Show / hide / reorder columns">▦ Columns</button>';
    h += '<button class="btn copy-csv" title="Copy table as CSV">⧉ CSV</button>';
    h += '<button class="btn copy-md" title="Copy table as Markdown">⧉ MD</button>';
    h += '</div>';
    return h;
  }
  // filtre + changed-only'i DOM'da gizleyerek uygula (yeniden çizim yok -> input odağı korunur)
  function applyFilter(name) {
    const st = secState[name]; const body = bodyEl(name);
    if (!st || !body) return;
    const tb = body.querySelector('tbody'); if (!tb) return;
    // filtre artık düz metin + ALAN PREDİKATLARI (PID>=3, state=running ...) — graph aramasıyla aynı kurallar
    const pq = parseSearch(st.filter || '');
    const chgOnly = st.changedOnly && !st.sec.grouped && st.changeCount > 0;
    const active = pq.active || chgOnly;                 // herhangi bir gizleme kriteri var mı
    const cols = displayCols(st);
    const allRows = st.sec.grouped ? st.sec.groups.reduce((a, g) => a.concat(g.rows), []) : st.sec.rows;
    const collapsed = st.collapsed || [];
    let grp = null, grpVisible = false, grpKey = null;
    // grup başlığını yalnız FİLTRE/changed-only ile (tüm satırları elenince) gizle;
    // collapse ile satırları gizlenen grubun başlığı her zaman görünür kalmalı (tekrar açılabilsin)
    const finalize = () => {
      if (grp) grp.style.display = (!active || grpVisible || collapsed.indexOf(grpKey) !== -1) ? '' : 'none';
    };
    for (const tr of tb.children) {
      if (tr.classList.contains('grphdr')) { finalize(); grp = tr; grpKey = tr.dataset.grp; grpVisible = false; continue; }
      let show = true;
      if (pq.active) {
        const txt = tr.textContent.toLowerCase();
        for (let i = 0; i < pq.plain.length && show; i++) if (txt.indexOf(pq.plain[i]) === -1) show = false;   // düz terimler: satır metni
        if (show && pq.preds.length) {   // predikatlar: satırın alan değerinde (data-ri -> kaynak satır)
          const ri = (tr.dataset.ri != null && tr.dataset.ri !== '') ? +tr.dataset.ri : -1;
          const node = { cols: cols, row: (ri >= 0 && allRows[ri]) ? allRows[ri] : {} };
          for (let j = 0; j < pq.preds.length && show; j++) if (!predOk(node, pq.preds[j])) show = false;
        }
      }
      if (show && chgOnly && !tr.querySelector('td.changed')) show = false;
      tr.style.display = show ? '' : 'none';
      if (show) grpVisible = true;
    }
    finalize();
  }
  function flashBtn(b) { const t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = t; }, 1200); }
  // görünen satırlardan CSV/Markdown üret -> panoya kopyala (extension)
  function copyTable(name, fmt) {
    const st = secState[name]; const body = bodyEl(name);
    const tbl = body && body.querySelector('table'); if (!tbl) return;
    const heads = [].map.call(tbl.querySelectorAll('thead th'), th => th.textContent.replace(/[▲▼]/g, '').trim());
    const grouped = st.sec.grouped && !st.flat;
    const out = []; let grp = '';
    for (const tr of tbl.querySelectorAll('tbody tr')) {
      if (tr.style.display === 'none') continue;
      if (tr.classList.contains('grphdr')) { grp = tr.textContent.replace(/[▾▸]/g, '').replace(/\\s+\\d+\\s*$/, '').trim(); continue; }
      const cells = [].map.call(tr.children, td => { const c = td.cloneNode(true); for (const o of c.querySelectorAll('.old')) o.remove(); return c.textContent.replace(/\\s+/g, ' ').trim(); });
      out.push(grouped ? [grp].concat(cells) : cells);
    }
    const cols = grouped ? ['Group'].concat(heads) : heads;
    let text;
    if (fmt === 'csv') {
      const q = s => /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      text = [cols].concat(out).map(r => r.map(q).join(',')).join('\\n');
    } else {
      text = '| ' + cols.join(' | ') + ' |\\n| ' + cols.map(() => '---').join(' | ') + ' |\\n' +
        out.map(r => '| ' + r.join(' | ') + ' |').join('\\n');
    }
    vscodeApi.postMessage({ type: 'copy', text: text });
  }

  function headerCells(columns, sortCol, sortDir, numCols, colBase, bars) {
    numCols = numCols || {}; colBase = colBase || {}; bars = bars || {};
    let h = '';
    for (const c of columns) {
      const isNum = numCols[c] && !bars[c];   // bar kolonlarında base/sağa-hizalama yok
      const active = c === sortCol;
      const ind = active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      const cls = ((active ? 'sorted' : '') + (isNum ? ' num' : '')).trim();
      const b = colBase[c] || 'raw';
      const ctrl = isNum
        ? '<span class="hb' + (b !== 'raw' ? ' on' : '') + '" data-col="' + esc(c) + '" title="Number base — click to cycle: raw → bin(2) → dec(10) → hex(16)">' + baseLbl(b) + '</span>'
        : '';
      h += '<th class="' + cls + '" data-col="' + esc(c) + '" draggable="true" ' +
        'title="Click: sort  ·  Drag: reorder  ·  Right-click: columns">' +
        '<div class="thc"><span class="th-name">' + esc(c) + '<span class="sort-ind">' + ind + '</span></span>' + ctrl + '</div></th>';
    }
    return h;
  }
  function sortRows(rows, columns, sortCol, sortDir) {
    if (sortCol && columns.indexOf(sortCol) !== -1) {
      return rows.slice().sort((r1, r2) => {
        const c = compareVals(r1[sortCol] ?? '', r2[sortCol] ?? '');
        return sortDir === 'desc' ? -c : c;
      });
    }
    return rows;
  }
  function barCell(used, mx, meta) {
    if (used === null || mx === null || mx <= 0) return esc(used === null ? '-' : String(used));
    const pct = Math.max(0, Math.min(100, used / mx * 100));
    const cls = pct >= meta.crit ? 'bcrit' : (pct >= meta.warn ? 'bwarn' : 'bok');
    const lbl = used + ' / ' + mx + ' · ' + pct.toFixed(0) + '%';
    return '<div class="bar"><div class="barfill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></div><span class="barlbl">' + esc(lbl) + '</span></div>';
  }
  // link yalnız HEDEFTE eşleşen satır varsa bağlansın (0 / eşleşmeyen değer -> düz metin)
  function linkHasTarget(lk, value) {
    const st = secState[lk.section];
    if (!st || !st.sec) return false;
    const vis = st.order ? st.order.filter(l => st.hidden.indexOf(l) === -1) : [];
    const mc = lk.match || vis[0];
    if (!mc) return false;
    const rows = st.sec.grouped
      ? (st.sec.groups || []).reduce((a, g) => a.concat(g.rows || []), [])
      : (st.sec.rows || []);
    return rows.some(r => String(r[mc]) === String(value));
  }
  function dataRow(columns, row, changed, opts, ri) {
    opts = opts || {};
    const numCols = opts.numCols || {};
    const colBase = opts.colBase || {};
    const bars = opts.bars || {};
    const links = opts.links || {};
    const badges = opts.badges || {};
    const valueMap = opts.valueMap || {};
    const flags = opts.flags || {};
    const srcCols = opts.srcCols || [];   // sourceLine kolonları: "dosya:satır" hücreleri tıklanabilir (kaynağa git)
    const sortCol = opts.sortCol;
    const rk = rowKeyOf(row, columns);
    let h = '<tr' + (ri != null ? ' data-ri="' + ri + '"' : '') + (row['__el__'] ? ' data-el="' + esc(row['__el__']) + '"' : '') + (row['__idx__'] != null ? ' data-idx="' + esc(row['__idx__']) + '"' : '') + (row['__midx__'] != null ? ' data-midx="' + esc(row['__midx__']) + '"' : '') + (row['__oidx__'] != null ? ' data-oidx="' + esc(row['__oidx__']) + '"' : '') + '>';   // data-ri=kaynak satır; data-el=watch ifadesi; data-idx=subscript (\${selected_index}); data-midx=grubun master index'i (\${selected_master_index})
    for (const c of columns) {
      const ck = rk + '\\u0000' + c;
      const isChg = changed && Object.prototype.hasOwnProperty.call(changed, ck);
      const isSort = c === sortCol;
      const raw = row[c] ?? '';
      if (bars[c]) {   // kullanım çubuğu
        const inner = barCell(toIntVal(raw), toIntVal(row['__bar__' + c]), bars[c]);
        const bc = ((isChg ? 'changed ' : '') + (isSort ? 'sortcol' : '')).trim();
        h += '<td' + (bc ? ' class="' + bc + '"' : '') + ' title="' + esc(raw + ' / ' + (row['__bar__' + c] || '?')) + '">' + inner + '</td>';
        continue;
      }
      const b = colBase[c] || 'raw';
      const disp = (b !== 'raw' && !isDash(raw) && toIntVal(raw) !== null) ? fmtNum(raw, b) : raw;
      const classes = [];
      if (isMono(c)) classes.push('mono');
      if (numCols[c]) classes.push('num');
      if (isChg) classes.push('changed');
      if (isSort) classes.push('sortcol');
      const clsAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
      const lk = links[c];
      let inner;
      const vmap = (!isDash(raw)) ? valueMapEntry(valueMap[c], raw, disp) : null;   // config-driven değer eşlemesi (metin + renk); badge'in önünde
      const flagH = (!isDash(raw) && flags[c]) ? flagsHtml(flags[c], raw) : null;   // bayrak alanı: set bitleri çöz (vmap/badge'den önce)
      if (lk && raw !== '' && !isDash(raw) && linkHasTarget(lk, raw)) {
        inner = '<a class="xref" data-sec="' + esc(lk.section) + '" data-match="' + esc(lk.match || '') + '" data-val="' + esc(raw) + '">' + esc(vmap ? vmap.text : disp) + '</a>';
      } else if (srcCols.indexOf(c) !== -1 && raw !== '' && !isDash(raw)) {
        // tıklama hedefi: GDB'nin tam/relative yolu (__src__) varsa onu kullan (doğru dosya), yoksa gösterilen değer
        const loc = (row['__src__' + c] != null && row['__src__' + c] !== '') ? row['__src__' + c] : raw;
        inner = '<a class="srcref" data-loc="' + esc(loc) + '" title="Open ' + esc(loc) + ' in the editor">' + esc(disp) + '</a>';
      } else if (flagH) {
        inner = flagH;
      } else if (vmap) {
        inner = vmap.hex
          ? '<span class="badge" style="background:' + vmap.hex + '30;color:' + vmap.hex + '">' + esc(vmap.text) + '</span>'
          : '<span class="vmap">' + esc(vmap.text) + '</span>';
      } else {
        const bhex = (!isDash(raw)) ? badgeHex(matchBadge(badges[c], raw)) : null;   // config-driven rozet
        inner = bhex
          ? '<span class="badge" style="background:' + bhex + '30;color:' + bhex + '">' + esc(disp) + '</span>'
          : cell(c, disp);
      }
      if (isChg) {
        const ov = isDash(changed[ck]) ? '-' : changed[ck];
        inner += '<span class="old" title="previous value">' + esc(ov) + '</span>';
      }
      const ed = row['__edit__' + c];
      const lv = (row['__lv__' + c] != null) ? row['__lv__' + c] : ed;   // watchpoint hedefi (düz üye l-value, ya da editable)
      const editAttr = (ed != null) ? ' data-edit="' + esc(ed) + '" data-col="' + esc(c) + '"' : '';
      const lvAttr = (lv != null) ? ' data-lv="' + esc(lv) + '"' : '';
      const watched = (lv != null && watchedExprs.has(lv));
      const star = watched ? '<span class="wp-star" title="watchpoint set — break on change">★</span>' : '';
      // hover (tooltip): izlenen hücrede watchpoint olduğunu da belirt
      const ttl = esc(raw) + (watched ? ' — ★ watchpoint set (break on change)' : '');
      h += '<td' + clsAttr + editAttr + lvAttr + (watched ? ' data-wp="1"' : '') + ' title="' + ttl + '">' + star + inner + '</td>';
    }
    return h + '</tr>';
  }
  function buildTable(columns, rows, sortCol, sortDir, changed, opts) {
    if (!rows.length) return '<div class="empty">List is empty (root is NULL or count is 0).</div>';
    // kaynak index'i koru (sıralama görüntüyü değiştirir; data-ri kaynak satıra işaret etmeli)
    let idx = rows.map((_, i) => i);
    if (sortCol && columns.indexOf(sortCol) !== -1)
      idx = idx.slice().sort((a, b) => { const c = compareVals(rows[a][sortCol] ?? '', rows[b][sortCol] ?? ''); return sortDir === 'desc' ? -c : c; });
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir, opts && opts.numCols, opts && opts.colBase, opts && opts.bars) + '</tr></thead><tbody>';
    for (const i of idx) h += dataRow(columns, rows[i], changed, opts, i);
    return h + '</tbody></table>';
  }
  // groupBy: master düğümleri + altında satırlar (aç/kapa)
  function buildGroupedTable(columns, groups, collapsed, sortCol, sortDir, opts) {
    if (!groups || !groups.length) return '<div class="empty">No groups (master section is empty).</div>';
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir, opts && opts.numCols, opts && opts.colBase, opts && opts.bars) + '</tr></thead><tbody>';
    let base = 0;   // flat kaynak index ofseti (patchRow gruplar arası düzleştirmeyle aynı sıra)
    for (const g of groups) {
      const isCol = collapsed.indexOf(g.key) !== -1;
      h += '<tr class="grphdr" data-grp="' + esc(g.key) + '"><td colspan="' + columns.length + '">' +
        '<span class="caret">' + (isCol ? '▸' : '▾') + '</span> ' + esc(g.label) +
        ' <span class="grpcnt">' + g.rows.length + '</span></td></tr>';
      if (!isCol) {
        let gi = g.rows.map((_, j) => j);
        if (sortCol && columns.indexOf(sortCol) !== -1)
          gi = gi.slice().sort((a, b) => { const c = compareVals(g.rows[a][sortCol] ?? '', g.rows[b][sortCol] ?? ''); return sortDir === 'desc' ? -c : c; });
        for (const j of gi) h += dataRow(columns, g.rows[j], null, opts, base + j);   // data-ri = flat kaynak index
      }
      base += g.rows.length;   // çökük gruplarda da say -> patchRow düzleştirmesiyle tutarlı
    }
    return h + '</tbody></table>';
  }

  // Görünen sütunlar = kullanıcı sırasındaki - gizlenenler
  function displayCols(st) {
    return st.order.filter(l => st.hidden.indexOf(l) === -1);
  }

  // ===== Graph view (Phase 1: tek section) — linked/index zinciri · grouped ağaç · array ızgara =====
  var GVW = 196, GVH = 62, GVGY = 18, GVGX = 64, GVPAD = 22, GVGROUPW = 188, GVGROUPH = 40, GRAPH_MAX = 1000;
  // tek kaynaktan st.gv başlatma (sc/tx/ty pan-zoom; sel seçim; pos sürükle konumları; q arama; hi geçerli eşleşme; mini minimap)
  function gvInit() { return { sc: 1, tx: 0, ty: 0, sel: null, needFit: true, pos: {}, q: '', hi: -1, mini: true }; }
  function shortVal(v) { var s = String(v == null ? '' : v); var m = s.match(/"([^"]*)"/); return m ? m[1] : s; }
  function stateHex(sc) { return sc === 's-run' ? '#2ecc71' : sc === 's-ready' ? '#3498db' : sc === 's-block' ? '#e74c3c' : sc === 's-wait' ? '#f1c40f' : null; }
  // Düğüm rengi: önce 'state/durum' kolonu, sonra config-driven rozet eşleşmesi
  function nodeColor(row, cols, badges, valueMap) {
    for (var i = 0; i < cols.length; i++) {
      var lc = String(cols[i]).toLowerCase();
      if (lc.indexOf('state') !== -1 || lc.indexOf('durum') !== -1) { var h = stateHex(stateClass(row[cols[i]])); if (h) return h; }
    }
    for (var j = 0; j < cols.length; j++) { var bh = badgeHex(matchBadge(badges && badges[cols[j]], row[cols[j]])); if (bh) return bh; }
    for (var k = 0; k < cols.length; k++) { var vm = matchValueMap(valueMap && valueMap[cols[k]], row[cols[k]]); if (vm && vm.color) { var vh = badgeHex(vm.color); if (vh) return vh; } }   // valueMap rengi -> kart şeridi/minimap noktası
    return null;
  }
  // Sürükle-konum kalıcılık anahtarı: KARARLI satır kimliği (ilk kolon değeri — değişiklik-vurgusuyla aynı),
  // konumsal index değil -> liste yeniden sıralanınca taşınan konum doğru satırı izler (id'ye değil veriye bağlı)
  function posKeyOf(r, cols, fallback) { var k = rowKeyOf(r, cols); return k !== '' ? k : fallback; }
  // Arama sorgusu: düz metin (substring AND) + ALAN PREDİKATLARI "field OP value" (OP: > >= < <= = == !=).
  function parseSearch(q) {
    var preds = [], plain = [];
    var re = /([A-Za-z_][\\w]*)\\s*(>=|<=|!=|==|=|>|<)\\s*("[^"]*"|[^\\s]+)/g;
    var rest = String(q || '').replace(re, function (_, f, op, v) {
      preds.push({ f: f.toLowerCase(), op: op === '==' ? '=' : op, v: v.replace(/^"|"$/g, '') });
      return ' ';
    });
    rest.trim().toLowerCase().split(/\\s+/).forEach(function (t) { if (t) plain.push(t); });
    return { preds: preds, plain: plain, active: !!(preds.length || plain.length) };
  }
  function fieldVal(n, fname) {   // düğümün alan değeri (yalnız data düğümünde; case-insensitive kolon adı)
    if (!n.cols || !n.row) return null;
    for (var i = 0; i < n.cols.length; i++) if (String(n.cols[i]).toLowerCase() === fname) return n.row[n.cols[i]];
    return null;
  }
  function predOk(n, p) {
    var raw = fieldVal(n, p.f); if (raw == null) return false;
    if (p.op === '>' || p.op === '>=' || p.op === '<' || p.op === '<=') {   // sayısal karşılaştırma
      var a = toIntVal(raw), b = toIntVal(p.v);
      if (a === null) a = parseFloat(raw); if (b === null) b = parseFloat(p.v);
      if (isNaN(a) || isNaN(b)) return false;
      return p.op === '>' ? a > b : p.op === '>=' ? a >= b : p.op === '<' ? a < b : a <= b;
    }
    var na = toIntVal(raw), nb = toIntVal(p.v);   // = / != : sayısalsa sayı, değilse case-insensitive metin eşitliği
    var eq = (na !== null && nb !== null) ? (na === nb) : (String(raw).trim().toLowerCase() === String(p.v).trim().toLowerCase());
    return p.op === '!=' ? !eq : eq;
  }
  function nodeMatch(n, pq) {   // tüm düz terimler (corpus'ta) VE tüm predikatlar tutmalı (AND)
    if (!pq.active) return false;
    for (var i = 0; i < pq.plain.length; i++) if ((n._s || '').indexOf(pq.plain[i]) === -1) return false;
    for (var j = 0; j < pq.preds.length; j++) if (!predOk(n, pq.preds[j])) return false;
    return true;
  }
  // Bölüm verisinden düğüm + kenar modeli (konumlar grafik koordinatında)
  function graphModel(st) {
    var sec = st.sec, cols = displayCols(st);
    var nodes = [], edges = [], capped = false;
    var CARDH = Math.max(46, 26 + Math.max(0, cols.length - 1) * 16);   // kart yüksekliği: TÜM görünür alanlar gösterilsin (section başına tek-tip)
    // kart GENİŞLİĞİ de DİNAMİK: en geniş başlık/alan satırından (section başına tek-tip, ızgara hizası korunur)
    var CARDW = GVW;
    // kartta GÖRÜNEN metin: flags çözülmüş isimler / valueMap metni / shortVal -> genişlik buna göre (flag'ler taşmasın)
    var _sflags = sec.flags || {}, _svmap = sec.valueMap || {};
    var _disp = function (c, raw) {
      if (_sflags[c]) { var ft = flagsText(_sflags[c], raw); if (ft != null) return ft; }
      if (_svmap[c]) { var ve = valueMapEntry(_svmap[c], raw, shortVal(raw)); if (ve) return ve.text; }
      return shortVal(raw);
    };
    if (cols.length) {
      var _allR = sec.grouped ? (sec.groups || []).reduce(function (a, g) { return a.concat(g.rows || []); }, []) : (sec.rows || []);
      var _cw = 128, _n = Math.min(_allR.length, 400);
      for (var _i2 = 0; _i2 < _n; _i2++) {
        var _r2 = _allR[_i2]; if (!_r2) continue;
        var _tw = String(_disp(cols[0], _r2[cols[0]] != null ? _r2[cols[0]] : '')).length * 7.2 + 30;   // başlık + state/link nokta payı
        if (_tw > _cw) _cw = _tw;
        for (var _ci = 1; _ci < cols.length; _ci++) {
          var _c2 = cols[_ci];
          var _lw = String(_c2).length * 6 + 16 + String(_disp(_c2, _r2[_c2] != null ? _r2[_c2] : '')).length * 6;   // label + boşluk + GÖRÜNEN değer
          if (_lw > _cw) _cw = _lw;
        }
      }
      CARDW = Math.max(150, Math.min(360, Math.round(_cw) + 28));
    }
    if (sec.grouped) {
      // her grup bir BLOK (üstte etiket, altında üyeler); bloklar ~kare bir IZGARAYA paketlenir.
      // groupBy + mode:tree ise her grup KENDİ ağacı olarak çizilir (kök üstte, çocuklar altta, 'tree' kenarları);
      // aksi halde üyeler mini-ızgarada. ncols ≈ sqrt(grup sayısı).
      var GAPX = 44, GAPY = 34, GROWH = CARDH + GVGY + 22;
      var isTreeG = sec.kind === 'tree';
      var blocks = (sec.groups || []).map(function (g, gi) {
        var rws = g.rows || [];
        if (isTreeG) {
          // grup-içi düzgün (tidy) ağaç yerleşimi: __parent__ (grup-içi flat index) -> derinlik=y, alt-ağaç ortası=x
          var par = rws.map(function (r) { var p = r['__parent__']; return (p == null || p === '') ? -1 : (+p); });
          var ch = {}; par.forEach(function (p, i) { if (p >= 0) (ch[p] || (ch[p] = [])).push(i); });
          var depth = rws.map(function (r, i) { var d = 0, p = par[i], gg = 0; while (p >= 0 && gg++ < rws.length) { d++; p = par[p]; } return d; });
          var TCOLW = CARDW + GVGX, xpos = [], leafN = 0;
          var place = function (i) { var c = ch[i] || []; if (!c.length) { xpos[i] = leafN * TCOLW; leafN++; } else { c.forEach(place); xpos[i] = (xpos[c[0]] + xpos[c[c.length - 1]]) / 2; } };
          rws.forEach(function (r, i) { if (par[i] < 0) place(i); });
          rws.forEach(function (r, i) { if (xpos[i] == null) place(i); });   // yetim/döngü düğümleri de konumlansın
          var treeW = rws.length ? (Math.max.apply(null, xpos.map(function (v) { return v || 0; })) + CARDW) : CARDW;
          var maxD = rws.length ? Math.max.apply(null, depth) : 0;
          return { g: g, gi: gi, rws: rws, tree: { par: par, depth: depth, xpos: xpos }, bw: Math.max(GVGROUPW, treeW), bh: GVGROUPH + GVGY + maxD * GROWH + CARDH };
        }
        var gper = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(rws.length || 1))));
        var laneRows = Math.max(1, Math.ceil(rws.length / gper));
        return { g: g, gi: gi, rws: rws, gper: gper, bw: gper * (CARDW + GVGX) - GVGX, bh: GVGROUPH + GVGY + laneRows * (CARDH + GVGY) };
      });
      var ncols = Math.max(1, Math.ceil(Math.sqrt(blocks.length)));
      var col = 0, curX = GVPAD, curY = GVPAD + 22, rowMaxH = 0;
      blocks.forEach(function (b) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }   // cap başlıkları da kapsasın -> üyesiz dangling grup kartı + cap aşımı olmasın
        if (col >= ncols) { col = 0; curX = GVPAD; curY += rowMaxH + GAPY; rowMaxH = 0; }
        var bx = curX, by = curY, gkey = (b.g.key != null ? b.g.key : b.gi);
        var gcol = (st.collapsed || []).indexOf(gkey) !== -1;   // grup çökük mü (tablo ile AYNI durum: st.collapsed)
        var gw = Math.min(GVGROUPW, b.bw);   // grup başlığı bloktan taşmasın (dar tek-üyeli blokta)
        var gnode = { id: 'g' + b.gi, group: true, label: b.g.label, count: b.rws.length, pkey: 'g:' + gkey, gkey: gkey, collapsed: gcol, x: bx + (b.bw - gw) / 2, y: by, w: gw, h: GVGROUPH, members: [] };
        nodes.push(gnode);
        var memTop = by + GVGROUPH + GVGY;
        if (!gcol) b.rws.forEach(function (r, ri) {
          if (nodes.length >= GRAPH_MAX) { capped = true; return; }
          var mid = 'm' + b.gi + '_' + ri;
          if (b.tree) {
            // ağaç: x = alt-ağaç ortası, y = derinlik; kenarlar ebeveyn->çocuk (kök ise grup başlığı->kök) = 'tree' (dikey)
            nodes.push({ id: mid, row: r, pkey: 'm:' + gkey + ':' + posKeyOf(r, cols, String(ri)), x: bx + (b.tree.xpos[ri] || 0), y: memTop + b.tree.depth[ri] * GROWH, w: CARDW, h: CARDH, cols: cols });
            gnode.members.push(mid);
            var pp = b.tree.par[ri];
            edges.push(pp >= 0 ? { from: 'm' + b.gi + '_' + pp, to: mid, type: 'tree' } : { from: 'g' + b.gi, to: mid, type: 'tree' });
          } else {
            var cc = ri % b.gper, rr = Math.floor(ri / b.gper);
            nodes.push({ id: mid, row: r, pkey: 'm:' + gkey + ':' + posKeyOf(r, cols, String(ri)), x: bx + cc * (CARDW + GVGX), y: memTop + rr * (CARDH + GVGY), w: CARDW, h: CARDH, cols: cols });
            gnode.members.push(mid);   // grup başlığı sürüklenince blok bütün taşınsın (#2)
            edges.push({ from: 'g' + b.gi, to: mid, type: 'grouped' });
          }
        });
        curX += b.bw + GAPX; rowMaxH = Math.max(rowMaxH, gcol ? GVGROUPH : b.bh); col++;   // çökükse blok yalnız başlık yüksekliğinde
      });
    } else if (sec.kind === 'tree') {
      // hiyerarşik ağaç: kök üstte, çocuklar altta; x = alt-ağaç ortası (tidy), y = derinlik
      var trows = sec.rows || [];
      var par = trows.map(function (r) { var p = r['__parent__']; return (p == null || p === '') ? -1 : (+p); });
      var children = {}; par.forEach(function (p, i) { if (p >= 0) (children[p] || (children[p] = [])).push(i); });
      var depth = trows.map(function (r, i) { var d = 0, p = par[i], g = 0; while (p >= 0 && g++ < trows.length) { d++; p = par[p]; } return d; });
      var COLW = CARDW + GVGX, ROWH = CARDH + GVGY + 22, xpos = [], leafN = 0;
      var place = function (i) {
        var ch = children[i] || [];
        if (!ch.length) { xpos[i] = leafN * COLW; leafN++; }
        else { ch.forEach(place); xpos[i] = (xpos[ch[0]] + xpos[ch[ch.length - 1]]) / 2; }
      };
      trows.forEach(function (r, i) { if (par[i] < 0) place(i); });
      trows.forEach(function (r, i) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }
        nodes.push({ id: 'n' + i, row: r, pkey: posKeyOf(r, cols, 'n' + i), x: GVPAD + (xpos[i] || 0), y: GVPAD + 22 + depth[i] * ROWH, w: CARDW, h: CARDH, cols: cols });
        if (par[i] >= 0) edges.push({ from: 'n' + par[i], to: 'n' + i, type: 'tree' });   // ebeveyn -> çocuk: 'tree' = HER ZAMAN dikey (alt->üst), ağaç görünümü
      });
    } else if (sec.kind === 'linked' || sec.kind === 'index') {
      // serpentine (yılankavi) ızgara: tek uzun sütun yerine satırlara sarar, tek sıralar ters yönde -> komşular hep bitişik
      var lrows = sec.rows || [];
      var lper = Math.max(1, Math.min(6, Math.round(Math.sqrt(lrows.length * 1.3))));
      lrows.forEach(function (r, ri) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }
        var col = ri % lper, rowN = Math.floor(ri / lper);
        var visCol = (rowN % 2 === 0) ? col : (lper - 1 - col);
        nodes.push({ id: 'n' + ri, row: r, pkey: posKeyOf(r, cols, 'n' + ri), x: GVPAD + visCol * (CARDW + GVGX), y: GVPAD + 22 + rowN * (CARDH + GVGY + 14), w: CARDW, h: CARDH, cols: cols });
        if (ri > 0) edges.push({ from: 'n' + (ri - 1), to: 'n' + ri, type: 'next' });
      });
    } else {   // array: ızgara, kenar yok
      var arows = sec.rows || [];
      var per = arows.length <= 16 ? 4 : Math.max(4, Math.min(6, Math.round(Math.sqrt(arows.length * 1.3))));
      arows.forEach(function (r, ri) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }
        var cxn = ri % per, cyn = Math.floor(ri / per);
        nodes.push({ id: 'n' + ri, row: r, pkey: posKeyOf(r, cols, 'n' + ri), x: GVPAD + cxn * (CARDW + GVGX), y: GVPAD + 22 + cyn * (CARDH + GVGY), w: CARDW, h: CARDH, cols: cols });
      });
    }
    // Phase 2: cross-section LINKS (mor) — yalnız "⇄ Links" açıkken. Kaynak düğümlerden hedef satırın
    // (dedupe edilmiş) "ghost" düğümüne mor kesik kenar. linkHasTarget tablo xref'iyle BİREBİR aynı kuralı kullanır.
    var GHOST_MAX = 200, LINK_EDGE_MAX = 600, linkCapped = false;
    if (st.gv && st.gv.links) {   // ⇄ Links açık: GİDEN (bu bölümün link alanları) + GELEN (bu bölümü hedefleyen diğerleri)
      var src = nodes.slice();   // ghost'ları eklemeden ÖNCEki gerçek düğümler
      var ghostByKey = {}, ghosts = [], edgeSeen = {}, linkEdges = 0;
      var addGhost = function (gid, props, srcY) {
        if (!ghostByKey[gid]) {
          if (ghosts.length >= GHOST_MAX) { linkCapped = true; return null; }
          var gh = { id: gid, ghost: true, pkey: gid, w: Math.max(120, Math.round(CARDW * 0.74)), h: 44, srcY: srcY };
          for (var k in props) gh[k] = props[k];
          ghostByKey[gid] = gh; ghosts.push(gh);
        }
        return ghostByKey[gid];
      };
      var addEdge = function (from, to) {
        var ek = from + '|' + to; if (edgeSeen[ek]) return; edgeSeen[ek] = 1;   // aynı çift -> tek kenar
        if (linkEdges < LINK_EDGE_MAX) { edges.push({ from: from, to: to, type: 'link' }); linkEdges++; } else linkCapped = true;
      };
      // GİDEN: bu bölümün link alanları -> diğer bölümdeki hedef satır (ghost sağ oluğa)
      if (sec.links && Object.keys(sec.links).length) src.forEach(function (n) {
        if (!n.row || !n.cols) return;
        n.cols.forEach(function (c) {
          var lk = sec.links[c]; if (!lk) return;
          var raw = n.row[c]; if (raw == null || raw === '' || isDash(raw)) return;
          if (!linkHasTarget(lk, raw)) return;            // hedefte eşleşen satır yoksa kenar yok (tablo xref ile aynı)
          var tst = secState[lk.section]; if (!tst) return;
          var tvis = tst.order.filter(function (l) { return tst.hidden.indexOf(l) === -1; });
          var mc = lk.match || tvis[0], val = String(raw), gid = 'x:' + lk.section + ':' + mc + ':' + val;
          if (!addGhost(gid, { tsec: lk.section, mc: mc, val: val }, n.y)) return;
          n.hasLink = true; addEdge(n.id, gid);
        });
      });
      // GELEN: diğer görünür bölümlerden BU bölüme işaret eden linkler (ghost = o kaynak satır; ok bana doğru)
      var myByCol = {};
      var myNodeBy = function (mc, v) {
        if (!myByCol[mc]) { var m = {}; src.forEach(function (n) { if (n.row && n.row[mc] != null) m[String(n.row[mc])] = n; }); myByCol[mc] = m; }
        return myByCol[mc][String(v)];
      };
      Object.keys(secState).forEach(function (osec) {
        if (osec === sec.name) return;
        var ost = secState[osec]; if (!ost || !ost.sec || !ost.sec.links) return;
        var ovis = ost.order.filter(function (l) { return ost.hidden.indexOf(l) === -1; });
        var orows = ost.sec.grouped ? (ost.sec.groups || []).reduce(function (a, g) { return a.concat(g.rows || []); }, []) : (ost.sec.rows || []);
        Object.keys(ost.sec.links).forEach(function (oc) {
          var lk = ost.sec.links[oc]; if (lk.section !== sec.name) return;
          var mc = lk.match || cols[0], srcCol = ovis[0] || (ost.order && ost.order[0]) || oc;   // tüm kolonlar gizliyse fallback (undefined gid çakışması olmasın)
          orows.forEach(function (orow) {
            var v = orow[oc]; if (v == null || v === '' || isDash(v)) return;
            var myNode = myNodeBy(mc, v); if (!myNode) return;   // bu değer benim hangi düğümüme işaret ediyor
            var sval = String(srcCol && orow[srcCol] != null ? orow[srcCol] : v), gid = 'xi:' + osec + ':' + srcCol + ':' + sval;
            if (!addGhost(gid, { tsec: osec, mc: srcCol, val: sval, incoming: true }, myNode.y)) return;
            myNode.hasLink = true; addEdge(gid, myNode.id);   // ghost(kaynak) -> benim düğümüm
          });
        });
      });
      // ghost'ları sağ "hedefler" oluğuna yerleştir: hedef bölüme göre kümele, kaynak-y'ye göre sırala (az kesişme)
      // ghost'ları sağ oluğa koy ama her birini bağlı olduğu düğümün Y'sine HİZALA (hepsi tepeye yığılmasın);
      // çakışmayı aşağı iterek çöz -> kısa, çoğunlukla yatay kenarlar (kaynağına yakın)
      var gx0 = 0; nodes.forEach(function (n) { if (n.x + n.w > gx0) gx0 = n.x + n.w; });
      ghosts.sort(function (a, b) { return a.srcY - b.srcY; });
      var lastGy = -1e9;
      ghosts.forEach(function (gh) {
        gh.x = gx0 + GVGX;
        var y = Math.max(GVPAD + 22, gh.srcY);
        if (y < lastGy + gh.h + 12) y = lastGy + gh.h + 12;
        gh.y = y; lastGy = y; nodes.push(gh);
      });
    }
    // kullanıcının sürükleyip taşıdığı düğüm konumları (kalıcı) otomatik yerleşimi ezsin (kararlı pkey ile)
    var saved = st.gv && st.gv.pos;
    if (saved) nodes.forEach(function (n) { var p = saved[n.pkey]; if (p) { n.x = p.x; n.y = p.y; } });
    // arama metni (_s, küçük harf) + index (_i, minimap/DOM eşlemesi için) önceden hesaplanır
    nodes.forEach(function (n, i) {
      n._i = i;
      if (n.group) n._s = String(shortVal(n.label)).toLowerCase();
      else if (n.ghost) n._s = (n.val + ' ' + n.tsec).toLowerCase();
      else { var parts = []; (n.cols || []).forEach(function (c) { parts.push(c); parts.push(shortVal(n.row[c])); }); n._s = parts.join(' ').toLowerCase(); }
    });
    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    // TAM sınırlayıcı kutu (min+max) -> içerik her yöne (negatif dahil) genişleyebilir; nesne kalmayınca küçülür
    var bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    nodes.forEach(function (n) { if (n.x < bx0) bx0 = n.x; if (n.y < by0) by0 = n.y; if (n.x + n.w > bx1) bx1 = n.x + n.w; if (n.y + n.h > by1) by1 = n.y + n.h; });
    if (!nodes.length) { bx0 = 0; by0 = 0; bx1 = GVPAD; by1 = GVPAD; }
    bx0 -= GVPAD; by0 -= GVPAD; bx1 += GVPAD; by1 += GVPAD;
    return { nodes: nodes, edges: edges, byId: byId, capped: capped, linkCapped: linkCapped, bx0: bx0, by0: by0, bx1: bx1, by1: by1, cw: bx1 - bx0, ch: by1 - by0 };
  }
  function edgePath(a, b, type) {
    if (type === 'grouped') {
      // grup -> üye: üyenin SOL oluğundaki (gutter) dikey raydan dik-köşeli gir -> hiçbir kartı kesmez
      var sx = a.x + a.w / 2, sy = a.y + a.h;          // grup alt-orta
      var bx = b.x, my = b.y + b.h / 2;                // üye sol-orta
      var gx = Math.max(6, bx - GVGX / 2);             // üye sütununun sol oluğundaki dikey ray
      var d1 = gx >= sx ? 1 : -1, d2 = my >= sy ? 1 : -1;
      var r = Math.min(8, Math.abs(my - sy) / 2, Math.abs(gx - sx) / 2) || 0;
      return 'M' + sx + ',' + sy +
        ' L' + (gx - d1 * r) + ',' + sy +
        ' Q' + gx + ',' + sy + ' ' + gx + ',' + (sy + d2 * r) +
        ' L' + gx + ',' + (my - d2 * r) +
        ' Q' + gx + ',' + my + ' ' + (gx + r) + ',' + my +
        ' L' + bx + ',' + my;
    }
    if (type === 'tree') {
      // ağaç: ORG-CHART dik köşeli yol — ebeveyn alt-ortadan ÇIK, orta seviyede yatay git, çocuk üst-ortaya
      // DİK İN (köşeler yuvarlatılmış). Geniş kartlarda bile giriş NOKTASI net biçimde üst-orta olur (yan değil).
      // Çocuk yukarı sürüklenirse dikey yön ters döner. Ok hedefe dik girer (orient=auto).
      var tex = a.x + a.w / 2, tbx = b.x + b.w / 2;
      var down = (b.y + b.h / 2) >= (a.y + a.h / 2);
      var tey = down ? a.y + a.h : a.y;        // ebeveyn çıkış kenarı
      var tby = down ? b.y : b.y + b.h;        // çocuk giriş kenarı (üst-orta)
      if (Math.abs(tbx - tex) < 1) return 'M' + tex + ',' + tey + ' L' + tbx + ',' + tby;   // tam hizalı -> düz dikey
      var tmy = (tey + tby) / 2;               // yatay koşunun seviyesi (seviyeler arası orta)
      var vd = tby >= tey ? 1 : -1, hd = tbx >= tex ? 1 : -1;
      var rr = Math.min(10, Math.abs(tby - tey) / 2, Math.abs(tbx - tex) / 2);   // köşe yarıçapı (boşluğa göre küçülür)
      return 'M' + tex + ',' + tey +
        ' L' + tex + ',' + (tmy - vd * rr) +
        ' Q' + tex + ',' + tmy + ' ' + (tex + hd * rr) + ',' + tmy +
        ' L' + (tbx - hd * rr) + ',' + tmy +
        ' Q' + tbx + ',' + tmy + ' ' + tbx + ',' + (tmy + vd * rr) +
        ' L' + tbx + ',' + tby;
    }
    // next / link / default: YÖNE DUYARLI yönlendirme — kaynağın ve hedefin birbirine BAKAN
    // en yakın kenarlarından bağla; bitiş teğeti hedefin İÇİNE doğru -> orient=auto ok her zaman
    // çizginin geldiği yöne uygun döner ve düğümler sürüklendikçe canlı güncellenir.
    var acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    var dx = bcx - acx, dy = bcy - acy;
    var k = Math.max(24, Math.min(70, (Math.abs(dx) + Math.abs(dy)) / 3));
    var ex, ey, bx, by, c1x, c1y, c2x, c2y;
    if (Math.abs(dx) >= Math.abs(dy)) {   // yatay yaklaşım
      var sgx = dx >= 0 ? 1 : -1;
      ex = dx >= 0 ? a.x + a.w : a.x; ey = acy; bx = dx >= 0 ? b.x : b.x + b.w; by = bcy;
      c1x = ex + sgx * k; c1y = ey; c2x = bx - sgx * k; c2y = by;
    } else {                              // dikey yaklaşım
      var sgy = dy >= 0 ? 1 : -1;
      ex = acx; ey = dy >= 0 ? a.y + a.h : a.y; bx = bcx; by = dy >= 0 ? b.y : b.y + b.h;
      c1x = ex; c1y = ey + sgy * k; c2x = bx; c2y = by - sgy * k;
    }
    return 'M' + ex + ',' + ey + ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + bx + ',' + by;
  }
  function nodeSvg(n, badges, bars, valueMap, flags) {
    valueMap = valueMap || {}; flags = flags || {};
    if (n.group) {
      var gkAttr = (n.gkey != null) ? ' data-gkey="' + esc(String(n.gkey)) + '"' : '';   // sağ tık -> collapse/expand
      var caret = n.collapsed ? '▸ ' : '▾ ';   // çökük/açık göstergesi (tablo başlığıyla aynı dil)
      return '<g class="gnode gv-group' + (n.collapsed ? ' gv-collapsed' : '') + '" data-id="' + esc(n.id) + '"' + gkAttr + ' transform="translate(' + n.x + ',' + n.y + ')">' +
        '<rect class="card" width="' + n.w + '" height="' + n.h + '" rx="8"></rect>' +
        '<text class="gtitle" x="12" y="' + (n.h / 2 + 4) + '">' + caret + esc(shortVal(n.label)) + '</text>' +
        '<text class="gsub" x="' + (n.w - 12) + '" y="' + (n.h / 2 + 4) + '" text-anchor="end">' + n.count + '</text>' +
        '</g>';
    }
    if (n.ghost) {   // cross-section link hedefi (kompakt mor kart; tıkla -> hedef sekmeye git)
      var gsv = '<g class="gnode gv-ghost" data-id="' + esc(n.id) + '" data-sec="' + esc(n.tsec) + '" data-match="' + esc(n.mc) + '" data-val="' + esc(n.val) + '" transform="translate(' + n.x + ',' + n.y + ')">';
      gsv += '<rect class="card" width="' + n.w + '" height="' + n.h + '" rx="8"></rect>';
      gsv += '<rect x="0" y="0" width="4" height="' + n.h + '" rx="2" fill="#b07cc6"></rect>';
      gsv += '<text class="gtitle" x="14" y="18">' + esc(shortVal(n.val)) + ' ↗</text>';
      gsv += '<text class="gsub" x="14" y="34">' + esc(cap(n.tsec)) + '</text>';
      return gsv + '</g>';
    }
    var row = n.row, cols = n.cols, color = nodeColor(row, cols, badges, valueMap);
    var tvm = cols.length ? valueMapEntry(valueMap[cols[0]], row[cols[0]], shortVal(row[cols[0]])) : null;
    var title = cols.length ? (tvm ? tvm.text : shortVal(row[cols[0]])) : '';
    var elAttr = (row['__el__'] ? ' data-el="' + esc(row['__el__']) + '"' : '') + (row['__idx__'] != null ? ' data-idx="' + esc(row['__idx__']) + '"' : '') + (row['__midx__'] != null ? ' data-midx="' + esc(row['__midx__']) + '"' : '') + (row['__oidx__'] != null ? ' data-oidx="' + esc(row['__oidx__']) + '"' : '');   // #1: sağ tık -> watch kopyala; data-idx -> \${selected_index}; data-midx -> \${selected_master_index}
    var s = '<g class="gnode" data-id="' + esc(n.id) + '" data-search="' + esc(n._s || '') + '"' + elAttr + ' transform="translate(' + n.x + ',' + n.y + ')">';
    s += '<rect class="card" width="' + n.w + '" height="' + n.h + '" rx="8"></rect>';
    if (color) s += '<rect x="0" y="0" width="4" height="' + n.h + '" rx="2" fill="' + color + '"></rect>';
    s += '<text class="gtitle" x="14" y="18">' + esc(title) + '</text>';
    if (color) s += '<circle cx="' + (n.w - 14) + '" cy="14" r="5" fill="' + color + '"></circle>';
    if (n.hasLink) s += '<circle cx="' + (n.w - 26) + '" cy="14" r="3" fill="#b07cc6"></circle>';   // dışa/içe link var işareti
    // #4: TÜM görünür alanlar (cols.slice(1)) ayrı satırlarda; bar kolonu mini-çubuk
    var fy = 34;
    cols.slice(1).forEach(function (c) {
      s += '<text class="flab" x="14" y="' + fy + '">' + esc(c) + '</text>';
      // değer etiketle çakışmasın: karta sığmayan uzun değer (çok flag'li alan gibi) … ile kısaltılır (tam değer tablo görünümünde)
      var _avail = n.w - 12 - 14 - (String(c).length * 6) - 8, _maxc = Math.max(3, Math.floor(_avail / 6));
      var ffx = flags[c] ? flagsTspans(flags[c], row[c], _maxc) : null;   // bayrak alanı: her flag RENKLİ tspan (renk verilmişse)
      var fvm = (ffx == null) ? valueMapEntry(valueMap[c], row[c], shortVal(row[c])) : null;   // valueMap (expr) rengi de fval'a uygulanır
      var fvText = fvm ? fvm.text : shortVal(row[c]);
      var fvFill = (fvm && fvm.hex) ? ' fill="' + fvm.hex + '"' : '';
      if (ffx == null && String(fvText).length > _maxc) fvText = String(fvText).slice(0, _maxc - 1) + '…';
      // fval öğesi: flag alanında renkli tspan'lar, aksi halde (varsa valueMap rengiyle) düz metin
      var fvalEl = (ffx != null)
        ? '<text class="fval" x="' + (n.w - 12) + '" y="' + fy + '" text-anchor="end">' + ffx + '</text>'
        : '<text class="fval"' + fvFill + ' x="' + (n.w - 12) + '" y="' + fy + '" text-anchor="end">' + esc(fvText) + '</text>';
      if (bars[c]) {
        var used = toIntVal(row[c]), mxv = toIntVal(row['__bar__' + c]);
        if (used !== null && mxv !== null && mxv > 0) {
          var pct = Math.max(0, Math.min(1, used / mxv)), bx2 = 76, bw = n.w - bx2 - 38;
          var bc = (pct * 100) >= bars[c].crit ? '#e74c3c' : ((pct * 100) >= bars[c].warn ? '#f1c40f' : '#2ecc71');
          s += '<rect class="gbarbg" x="' + bx2 + '" y="' + (fy - 8) + '" width="' + bw + '" height="7" rx="3.5"></rect>';
          s += '<rect class="gbarfill" x="' + bx2 + '" y="' + (fy - 8) + '" width="' + (bw * pct).toFixed(1) + '" height="7" rx="3.5" fill="' + bc + '"></rect>';
          s += '<text class="gpct" x="' + (n.w - 12) + '" y="' + (fy - 1) + '" text-anchor="end">' + Math.round(pct * 100) + '%</text>';
        } else {
          s += fvalEl;
        }
      } else {
        s += fvalEl;
      }
      fy += 16;
    });
    return s + '</g>';
  }
  function renderGraph(name) {
    var st = secState[name], body = bodyEl(name); if (!st || !st.sec || !body) return;
    var idx = idxOf(name);
    var model = graphModel(st);
    var badges = st.sec.badges || {}, bars = st.sec.bars || {}, valueMap = st.sec.valueMap || {}, flags = st.sec.flags || {};
    var tbar = toolbarHtml(st);
    var summary = '<div class="summary">' + esc(st.sec.summary || '') + '</div>';
    if (!model.nodes.length) { body.innerHTML = summary + tbar + '<div class="gv-empty">Nothing to graph (list is empty).</div>'; return; }
    // TEK ok marker'ı: SABİT boyut (userSpaceOnUse -> stroke kalınlığıyla ölçeklenmez) + fill=context-stroke
    // -> ok her zaman çizginin rengini alır (normal gri / link mor / highlight mavi) ve birlikte hareket eder.
    var defs = '<defs><marker id="gar' + idx + '" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" refX="9" refY="4" orient="auto"><path d="M0,0 L9,4 L0,8 Z" fill="context-stroke"></path></marker></defs>';
    var eg = ''; model.edges.forEach(function (ed) { var a = model.byId[ed.from], b = model.byId[ed.to]; if (!a || !b) return; eg += '<path class="gedge ' + ed.type + '" data-f="' + esc(ed.from) + '" data-t="' + esc(ed.to) + '" d="' + edgePath(a, b, ed.type) + '" marker-end="url(#gar' + idx + ')"></path>'; });
    var ng = '', mini = '';
    model.nodes.forEach(function (n) {
      ng += nodeSvg(n, badges, bars, valueMap, flags);
      var mcol = n.ghost ? '#b07cc6' : n.group ? '#5a5a5a' : (nodeColor(n.row, n.cols, badges, valueMap) || '#7d8590');
      mini += '<rect class="mnode" x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" fill="' + mcol + '"></rect>';
    });
    var total = st.sec.grouped ? (st.sec.groups || []).reduce(function (a, g) { return a + (g.rows || []).length; }, 0) : (st.sec.rows || []).length;
    var bannerTxt = model.capped ? ('Showing first ' + GRAPH_MAX + ' of ' + total + ' nodes — narrow the data or use the table view for the full set.') : '';
    if (model.linkCapped) bannerTxt += (bannerTxt ? ' · ' : '') + 'Some links hidden — turn off ⇄ Links or use the table.';
    var banner = bannerTxt ? ('<div class="gv-banner">' + bannerTxt + '</div>') : '';
    var miniHidden = (st.gv && st.gv.mini === false) ? ' hidden' : '';
    body.innerHTML = summary + tbar + banner +
      '<div class="gv-wrap" id="gwrap-' + idx + '">' +
      '<svg class="gv-svg" id="gsvg-' + idx + '"><g id="gvp-' + idx + '">' + defs + '<g class="gv-edges">' + eg + '</g><g class="gv-nodes">' + ng + '</g></g></svg>' +
      '<div class="gv-detail" id="gdet-' + idx + '"><span class="close" id="gdc-' + idx + '">✕</span><h3 id="gdt-' + idx + '"></h3><div id="gdb-' + idx + '"></div></div>' +
      '<svg class="gv-mini' + miniHidden + '" id="gmini-' + idx + '"><g id="gmg-' + idx + '">' + mini + '<rect class="gv-vp" id="gvpr-' + idx + '"></rect></g></svg>' +
      '</div>';
    wireGraph(name, model, idx);
  }
  function wireGraph(name, model, idx) {
    var st = secState[name];
    var svg = document.getElementById('gsvg-' + idx), vp = document.getElementById('gvp-' + idx), det = document.getElementById('gdet-' + idx);
    if (!svg || !vp) return;
    st.gv = st.gv || gvInit();
    st.gv.pos = st.gv.pos || {};
    if (st.gv.q == null) st.gv.q = '';
    if (st.gv.hi == null) st.gv.hi = -1;
    if (st.gv.mini == null) st.gv.mini = true;
    var nd = null, suppressClick = false;   // nd = sürüklenen düğüm; suppressClick = sürükleme sonrası tıklamayı yut
    var nodeEls = vp.querySelectorAll('.gnode');   // cache (per-tuş arama + minimap eşlemesi index ile)
    var edgeEls = vp.querySelectorAll('.gedge');
    var gwrap = document.getElementById('gwrap-' + idx);
    var miniSvg = document.getElementById('gmini-' + idx), mg = document.getElementById('gmg-' + idx), vpR = document.getElementById('gvpr-' + idx);
    var miniRects = mg ? mg.querySelectorAll('.mnode') : null;
    var pbody = bodyEl(name);
    var sBox = pbody ? pbody.querySelector('.gv-search') : null, sN = pbody ? pbody.querySelector('.gv-srch-n') : null;
    var MMW = 180, MMH = 120, mscale = 1, hits = [];
    function setMiniScale() {   // bbox'u (negatif dahil) minimap kutusuna sığdıran ölçek + kaydırma (bounds değişince güncellenir)
      // minimap yüksekliği grafiğin en-boy oranıyla hizalanır (genişlik sabit 180, yükseklik ch/cw oranına göre)
      var aspect = (model.cw > 0) ? (model.ch / model.cw) : 0.66;
      MMH = Math.max(80, Math.min(260, Math.round(MMW * aspect)));
      if (miniSvg) { miniSvg.style.height = MMH + 'px'; }
      var ms = Math.min(MMW / model.cw, MMH / model.ch); if (!isFinite(ms) || ms <= 0) ms = 1;
      mscale = ms; if (mg) mg.setAttribute('transform', 'translate(' + (-model.bx0 * ms) + ',' + (-model.by0 * ms) + ') scale(' + ms + ')');
    }
    setMiniScale();
    function syncMini() {   // minimap viewport dikdörtgeni (graf koordinatında; gmg ölçeği küçültür)
      if (!vpR) return;
      var sw = svg.clientWidth || model.cw, sh = svg.clientHeight || model.ch;
      vpR.setAttribute('x', -st.gv.tx / st.gv.sc); vpR.setAttribute('y', -st.gv.ty / st.gv.sc);
      vpR.setAttribute('width', Math.max(0, sw / st.gv.sc)); vpR.setAttribute('height', Math.max(0, sh / st.gv.sc));
    }
    function nudgeMiniNode(n) { if (!miniRects || !n) return; var mr = miniRects[n._i]; if (mr) { mr.setAttribute('x', n.x); mr.setAttribute('y', n.y); } }
    function centerPoint(gx, gy, useSc) {
      var sw = svg.clientWidth || model.cw, sh = svg.clientHeight || model.ch;
      if (useSc) st.gv.sc = useSc;
      st.gv.tx = sw / 2 - gx * st.gv.sc; st.gv.ty = sh / 2 - gy * st.gv.sc; apply();
    }
    function centerOn(n) { if (n) centerPoint(n.x + n.w / 2, n.y + n.h / 2, Math.max(0.8, Math.min(1.4, st.gv.sc))); }
    function markCur() {
      if (!nodeEls || !nodeEls.forEach) return;
      nodeEls.forEach(function (el) { el.classList.remove('gv-cur'); });
      if (st.gv.hi >= 0 && hits[st.gv.hi] != null && nodeEls[hits[st.gv.hi]]) nodeEls[hits[st.gv.hi]].classList.add('gv-cur');
    }
    function applySearch() {   // düz metin (substring AND) + alan predikatları; vurgula (gv-hit) / soluklaştır (gv-fade) / minimap heatmap (gm-hit)
      var pq = parseSearch(st.gv.q), active = pq.active;
      if (active) {   // arama başlarken önceki seçim/hover .dim/.ehl katmanını temizle (yoksa hit'ler %16 soluk kalır)
        if (nodeEls && nodeEls.forEach) nodeEls.forEach(function (g) { g.classList.remove('dim'); });
        if (edgeEls && edgeEls.forEach) edgeEls.forEach(function (p) { p.classList.remove('dim'); p.classList.remove('ehl'); });
      }
      hits = []; var hitIds = {};
      if (nodeEls && nodeEls.forEach) nodeEls.forEach(function (el, i) {
        var n = model.nodes[i]; var on = !!(n && nodeMatch(n, pq));
        if (on) { hits.push(i); hitIds[n.id] = 1; }
        el.classList.toggle('gv-hit', on); el.classList.toggle('gv-fade', active && !on);
      });
      if (miniRects && miniRects.forEach) miniRects.forEach(function (mr, i) { var n = model.nodes[i]; mr.classList.toggle('gm-hit', !!(n && hitIds[n.id])); });
      // kenar-fade: model index'i yerine DOM data-f/data-t ile (renderGraph bir kenarı atlasa bile index kaymaz)
      if (edgeEls && edgeEls.forEach) edgeEls.forEach(function (p) { var on = !!(hitIds[p.getAttribute('data-f')] && hitIds[p.getAttribute('data-t')]); p.classList.toggle('gv-fade', active && !on); });
      if (gwrap) gwrap.classList.toggle('searching', active);
      if (st.gv.hi >= hits.length) st.gv.hi = -1;
      if (sN) sN.textContent = !active ? '' : (!hits.length ? '0' : ((st.gv.hi >= 0 ? (st.gv.hi + 1) + ' / ' : '') + hits.length));
      markCur();
      if (!active && st.gv.sel && model.byId[st.gv.sel]) focus(st.gv.sel);   // arama temizlendi + seçim duruyor -> seçim spotlight'ını geri uygula
    }
    function cycle(d) {   // Enter / Shift+Enter: sıradaki/önceki eşleşmeye merkezle
      if (!hits.length) return;
      st.gv.hi = st.gv.hi < 0 ? (d > 0 ? 0 : hits.length - 1) : (st.gv.hi + d + hits.length) % hits.length;
      markCur(); centerOn(model.nodes[hits[st.gv.hi]]);
      if (sN) sN.textContent = (st.gv.hi + 1) + ' / ' + hits.length;
    }
    function redrawEdges(movedId) {
      if (!edgeEls || !edgeEls.forEach) return;   // DOM-shim: boş NodeList -> güvenli no-op
      edgeEls.forEach(function (p) {
        var f = p.getAttribute('data-f'), t = p.getAttribute('data-t');
        if (f !== movedId && t !== movedId) return;
        var a = model.byId[f], b = model.byId[t]; if (!a || !b) return;
        p.setAttribute('d', edgePath(a, b, p.classList.contains('grouped') ? 'grouped' : p.classList.contains('tree') ? 'tree' : p.classList.contains('link') ? 'link' : 'next'));
      });
    }
    function recomputeBounds() {   // sürükleme sonrası TAM bbox (her yöne); nesne çekilince küçülür
      var bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      model.nodes.forEach(function (n) { if (n.x < bx0) bx0 = n.x; if (n.y < by0) by0 = n.y; if (n.x + n.w > bx1) bx1 = n.x + n.w; if (n.y + n.h > by1) by1 = n.y + n.h; });
      if (!model.nodes.length) { bx0 = 0; by0 = 0; bx1 = GVPAD; by1 = GVPAD; }
      bx0 -= GVPAD; by0 -= GVPAD; bx1 += GVPAD; by1 += GVPAD;
      model.bx0 = bx0; model.by0 = by0; model.bx1 = bx1; model.by1 = by1; model.cw = bx1 - bx0; model.ch = by1 - by0;
    }
    function apply() {
      vp.setAttribute('transform', 'translate(' + st.gv.tx + ',' + st.gv.ty + ') scale(' + st.gv.sc + ')');
      if (gwrap) gwrap.classList.toggle('lod-far', st.gv.sc < 0.45);   // çok uzakta: kart metnini gizle (büyük graf perf)
      syncMini();
    }
    function fit() {
      var sw = svg.clientWidth, sh = svg.clientHeight;
      if (!sw || !sh) { st.gv.needFit = true; apply(); return; }
      var s = Math.min(sw / model.cw, sh / model.ch, 1); if (!isFinite(s) || s <= 0) s = 1;
      st.gv.sc = s;
      st.gv.tx = (sw - model.cw * s) / 2 - model.bx0 * s;   // bbox'u yatay ortala (negatif origin dahil)
      st.gv.ty = 10 - model.by0 * s;                        // üstten ~10px
      st.gv.needFit = false; apply();
    }
    if (st.gv.needFit) fit(); else apply();
    function neighbors(id) { var ns = {}; ns[id] = 1; model.edges.forEach(function (e) { if (e.from === id || e.to === id) { ns[e.from] = 1; ns[e.to] = 1; } }); return ns; }
    function focus(id) {
      var ns = neighbors(id);
      if (st.gv.q) {   // arama aktif: hit/fade spotlight'ı bozma, sadece komşu kenarları vurgula
        vp.querySelectorAll('.gedge').forEach(function (p) { var on = ns[p.getAttribute('data-f')] && ns[p.getAttribute('data-t')] && (p.getAttribute('data-f') === id || p.getAttribute('data-t') === id); p.classList.toggle('ehl', !!on); });
        return;
      }
      vp.querySelectorAll('.gnode').forEach(function (g) { g.classList.toggle('dim', !ns[g.getAttribute('data-id')]); });
      vp.querySelectorAll('.gedge').forEach(function (p) { var on = ns[p.getAttribute('data-f')] && ns[p.getAttribute('data-t')] && (p.getAttribute('data-f') === id || p.getAttribute('data-t') === id); p.classList.toggle('dim', !on); p.classList.toggle('ehl', !!on); });
    }
    function clearFocus() {
      if (st.gv.q) { vp.querySelectorAll('.gedge').forEach(function (p) { p.classList.remove('ehl'); }); return; }
      vp.querySelectorAll('.gnode').forEach(function (g) { g.classList.remove('dim'); }); vp.querySelectorAll('.gedge').forEach(function (p) { p.classList.remove('dim'); p.classList.remove('ehl'); });
    }
    function detailFor(id) {
      var n = model.byId[id]; if (!n) return;
      if (n.ghost) {   // ghost'ta n.row/n.cols yok -> ayrı detay; tıklarsa gotoXref zaten hedefe götürür
        document.getElementById('gdt-' + idx).textContent = shortVal(n.val);
        document.getElementById('gdb-' + idx).innerHTML = '<div class="grow2"><span>' + (n.incoming ? 'linked from' : 'links to') + '</span><b>' + esc(cap(n.tsec)) + '</b></div><div class="grow2"><span>' + esc(n.mc) + '</span><b>' + esc(n.val) + '</b></div>';
        det.style.display = 'block';
        return;
      }
      var t = n.group ? shortVal(n.label) : (n.cols.length ? shortVal(n.row[n.cols[0]]) : id);
      document.getElementById('gdt-' + idx).textContent = t;
      var html;
      if (n.group) html = '<div class="grow2"><span>members</span><b>' + n.count + '</b></div><div class="grow2"><span>group</span><b>' + esc(cap(name)) + '</b></div>';
      else {
        var _df = st.sec.flags || {}, _dvm = st.sec.valueMap || {};
        // detayda da string'e/renge çevir; çevrilen değerin integer hali parantezde; veri kesilmez (CSS sarar/genişler)
        var _cell = function (c, raw) {
          if (_df[c]) { var fh = flagsHtml(_df[c], raw); if (fh != null) return fh + ' <span class="gd-int">(' + esc(shortVal(raw)) + ')</span>'; }
          if (_dvm[c]) { var ve = valueMapEntry(_dvm[c], raw, shortVal(raw)); if (ve) { var pill = ve.hex ? '<span class="badge" style="background:' + ve.hex + '30;color:' + ve.hex + '">' + esc(ve.text) + '</span>' : '<span class="vmap">' + esc(ve.text) + '</span>'; var sv = shortVal(raw); return pill + (ve.text !== sv ? ' <span class="gd-int">(' + esc(sv) + ')</span>' : ''); } }
          return esc(shortVal(raw));
        };
        html = n.cols.map(function (c) { return '<div class="grow2"><span>' + esc(c) + '</span><b>' + _cell(c, n.row[c]) + '</b></div>'; }).join('');
      }
      document.getElementById('gdb-' + idx).innerHTML = html;
      det.style.display = 'block';
    }
    function selectNode(id) { st.gv.sel = id; vp.querySelectorAll('.gnode').forEach(function (g) { g.classList.toggle('sel', g.getAttribute('data-id') === id); }); focus(id); detailFor(id); }
    vp.addEventListener('mouseover', function (e) { var g = e.target.closest('.gnode'); if (g && !st.gv.sel) focus(g.getAttribute('data-id')); });
    vp.addEventListener('mouseout', function () { if (!st.gv.sel) clearFocus(); });
    vp.addEventListener('click', function (e) {
      if (suppressClick) { suppressClick = false; return; }
      var g = e.target.closest('.gnode'); if (!g) return; e.stopPropagation();
      var gid = g.getAttribute('data-id'), gn = model.byId[gid];
      if (gn && gn.ghost) { gotoXref(gn.tsec, gn.mc, gn.val); return; }   // ghost -> gerçek hedef sekme+satır
      selectNode(gid);
    });
    var dc = document.getElementById('gdc-' + idx);
    if (dc) dc.addEventListener('click', function (e) { e.stopPropagation();
      if (det.getAttribute('data-detname')) closeDetailEntry(det.getAttribute('data-detmaster'), det.getAttribute('data-detsel'), det.getAttribute('data-detname'));   // detay gösteriyorsa onu da kapat
      st.gv.sel = null; det.style.display = 'none'; det.classList.remove('gv-detail-wide'); clearFocus(); vp.querySelectorAll('.gnode.sel').forEach(function (g) { g.classList.remove('sel'); }); });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.min(3, Math.max(0.25, st.gv.sc * f));
      var r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      st.gv.tx = px - (px - st.gv.tx) * (ns / st.gv.sc); st.gv.ty = py - (py - st.gv.ty) * (ns / st.gv.sc); st.gv.sc = ns; apply();
    }, { passive: false });
    var dragging = false, lx = 0, ly = 0;
    svg.addEventListener('mousedown', function (e) {
      suppressClick = false;   // önceki etkileşimden kalan bastırmayı temizle
      var g = e.target.closest ? e.target.closest('.gnode') : null;
      if (g) {   // DÜĞÜM sürükle (arka plan pan'i değil); grup başlığıysa BLOK bütün (#2)
        var id = g.getAttribute('data-id'), n = model.byId[id]; if (!n) return;
        e.stopPropagation();
        var items = [{ n: n, el: g, ox: n.x, oy: n.y }];
        if (n.group && n.members) n.members.forEach(function (mid) { var m = model.byId[mid], el = m ? (nodeEls && nodeEls[m._i]) : null; if (m && el) items.push({ n: m, el: el, ox: m.x, oy: m.y }); });
        nd = { id: id, g: g, sx: e.clientX, sy: e.clientY, moved: false, items: items };
        g.classList.add('gv-dragging');
        return;
      }
      dragging = true; lx = e.clientX; ly = e.clientY; svg.classList.add('panning');
    });
    svg.addEventListener('mousemove', function (e) {
      if (nd) {   // düğüm(ler) sürükleniyor: tek delta tüm öğelere -> blok bütün; HER YÖNE (negatif/sol-üst dahil), clamp yok
        if (!nd.moved && (Math.abs(e.clientX - nd.sx) + Math.abs(e.clientY - nd.sy)) > 3) nd.moved = true;
        if (!nd.moved) return;
        var dx = (e.clientX - nd.sx) / st.gv.sc, dy = (e.clientY - nd.sy) / st.gv.sc;
        nd.items.forEach(function (it) {
          it.n.x = it.ox + dx; it.n.y = it.oy + dy;
          if (it.el) it.el.setAttribute('transform', 'translate(' + it.n.x + ',' + it.n.y + ')');
          redrawEdges(it.n.id); nudgeMiniNode(it.n);
        });
        return;
      }
      if (!dragging) return; st.gv.tx += e.clientX - lx; st.gv.ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
    });
    function endPan() {
      if (nd) {
        if (nd.moved) {
          nd.items.forEach(function (it) { st.gv.pos[it.n.pkey] = { x: it.n.x, y: it.n.y }; });   // tüm taşınanları KARARLI pkey ile sakla
          suppressClick = true; recomputeBounds(); setMiniScale(); syncMini();
        }
        nd.g.classList.remove('gv-dragging'); nd = null;
      }
      dragging = false; svg.classList.remove('panning');
    }
    svg.addEventListener('mouseup', endPan); svg.addEventListener('mouseleave', endPan);
    // arama kutusu: anlık eşleşme; Enter/Shift+Enter eşleşmeler arası gez; Esc temizle
    if (sBox) {
      sBox.addEventListener('input', function () { st.gv.q = sBox.value; st.gv.hi = -1; applySearch(); });
      sBox.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); st.gv.q = ''; st.gv.hi = -1; sBox.value = ''; applySearch(); sBox.blur(); }
      });
    }
    // minimap: tıkla/sürükle -> ana görünümü o noktaya merkezle
    if (miniSvg) {
      var mpan = false;
      var miniTo = function (e) { var r = miniSvg.getBoundingClientRect(); centerPoint((e.clientX - r.left) / mscale + model.bx0, (e.clientY - r.top) / mscale + model.by0, st.gv.sc); };
      miniSvg.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); mpan = true; miniTo(e); });
      miniSvg.addEventListener('mousemove', function (e) { if (mpan) miniTo(e); });
      var mEnd = function () { mpan = false; };
      miniSvg.addEventListener('mouseup', mEnd); miniSvg.addEventListener('mouseleave', mEnd);
    }
    st._fit = fit;
    // cross-section link tıklamasında (gotoXref) bu graf'ta hedef düğüme merkezlen + blink (tablo satırı yerine)
    st._focusNode = function (matchCol, value) {
      // eşleşme değerini TÜM satırdan çöz (match kolonu hedefte GİZLİ olsa bile row onu taşır); yoksa ilk görünür kolon
      function rowVal(row, col) {
        if (row[col] != null) return row[col];
        var lc = String(col).toLowerCase();
        for (var k in row) if (k.charAt(0) !== '_' && String(k).toLowerCase() === lc) return row[k];
        return null;
      }
      var target = null;
      for (var i = 0; i < model.nodes.length; i++) {
        var nn = model.nodes[i]; if (nn.ghost || nn.group || !nn.row || !nn.cols) continue;
        var rv = matchCol ? rowVal(nn.row, matchCol) : nn.row[nn.cols[0]];
        if (rv != null && String(rv) === String(value)) { target = nn; break; }
      }
      if (!target) return;
      centerOn(target);
      var el = nodeEls && nodeEls[target._i];
      if (el) { el.classList.remove('gv-blink'); setTimeout(function () { el.classList.add('gv-blink'); }, 20); setTimeout(function () { el.classList.remove('gv-blink'); }, 1700); }
    };
    if (st.gv.sel && model.byId[st.gv.sel]) selectNode(st.gv.sel); else st.gv.sel = st.gv.sel && model.byId[st.gv.sel] ? st.gv.sel : null;
    if (st.gv.q) { if (sBox) sBox.value = st.gv.q; applySearch(); } else syncMini();   // refresh sonrası arama/minimap durumunu geri uygula
  }

  // --- Talep-üzerine detay (selectedFrom + \${selected}) yerleşimi ---
  function paneOf(name) { const i = currentNames.indexOf(name); return i < 0 ? null : panesEl.querySelector('.pane[data-idx="' + i + '"]'); }
  function detCount(sec) { if (!sec) return ''; return sec.grouped ? (sec.groups || []).reduce(function (a, g) { return a + (g.rows || []).length; }, 0) : (sec.rows || []).length; }
  // detay bölümünü mini bir tablo olarak çiz (master sütun tercihleri/sıralama YOK; kendi base/valueMap/flags/link'i uygulanır)
  function detSubTable(sec) {
    if (!sec) return '<div class="det-load">Loading…</div>';
    if (sec.error) return '<div class="det-empty">⚠ ' + esc(sec.error) + '</div>';   // örn \${selected_index} array/index_list olmayan master'da
    const cols = (sec.columnsAll || []).filter(function (l) { return (sec.hidden || []).indexOf(l) === -1; });
    const rows = sec.grouped ? (sec.groups || []).reduce(function (a, g) { return a.concat(g.rows || []); }, []) : (sec.rows || []);
    if (!rows.length) return '<div class="det-empty">(no rows)</div>';
    const colBase = {};
    if (sec.bases) for (const k in sec.bases) colBase[k] = sec.bases[k];   // config sayı tabanını (örn PC/FP hex) uygula
    // links: detay alanlarında da çapraz-referans (field.link) uygulanır — sec.links buildSection/buildArrayNd'den gelir
    // (fieldLinks). xref tıklaması panesEl'e delege (detay accordion'u master pane'in İÇİNDE) + linkHasTarget global
    // secState'e bakar, yani kaynak detay olsa da hedef bölüme gider. (Eskiden burada links:{} idi -> gözden kaçmıştı.)
    const opts = { numCols: numericCols(cols, rows), colBase: colBase, bars: sec.bars || {}, links: sec.links || {}, badges: sec.badges || {}, valueMap: sec.valueMap || {}, flags: sec.flags || {}, srcCols: sec.srcCols || [], sortCol: null };
    return buildTable(cols, rows, null, 'asc', null, opts);
  }
  function detInner(d) {
    const head = '<div class="det-head"><span class="det-x" title="Hide">✕</span><b>' + esc(cap(d.detail)) + '</b> <span class="det-cnt">' + detCount(d.sec) + '</span></div>';
    return head + detSubTable(d.sec);
  }
  // TABLO: master satırının HEMEN ALTINA accordion satırı ekle/güncelle (alta doğru genişler)
  function placeDetailTable(d) {
    const pane = paneOf(d.master); if (!pane) return;
    const trs = pane.querySelectorAll('tbody tr[data-el]');
    let host = null;
    for (let i = 0; i < trs.length; i++) { if (trs[i].getAttribute('data-el') === d.sel) { host = trs[i]; break; } }
    if (!host) return;
    let row = host.nextElementSibling;
    while (row && row.classList && row.classList.contains('detrow')) {
      if (row.getAttribute('data-detail') === d.detail) break;
      row = row.nextElementSibling;
    }
    const span = host.children.length || 1;
    const inner = '<td colspan="' + span + '"><div class="det-wrap">' + detInner(d) + '</div></td>';
    if (row && row.classList && row.classList.contains('detrow') && row.getAttribute('data-detail') === d.detail) {
      row.innerHTML = inner;
    } else {
      const tr = document.createElement('tr');
      tr.className = 'detrow';
      tr.setAttribute('data-detail', d.detail);
      tr.setAttribute('data-master', d.master);
      tr.setAttribute('data-sel', d.sel);   // setAttribute ham saklar (esc gerekmez) -> kapatmada doğrudan okunur
      tr.innerHTML = inner;
      host.parentNode.insertBefore(tr, host.nextElementSibling);
    }
  }
  // GRAPH: sağ-tık -> detay panelini aç + genişlet (sub-table panelin içinde)
  function placeDetailGraph(d) {
    const pane = paneOf(d.master); if (!pane) return;
    const det = pane.querySelector('.gv-detail'); if (!det) return;
    const title = det.querySelector('h3'); const body = det.querySelector('[id^="gdb-"]');
    if (!title || !body) return;
    const c = detCount(d.sec);
    title.textContent = cap(d.detail) + (c !== '' ? ' (' + c + ')' : '');
    body.innerHTML = '<div class="det-wrap det-ingraph">' + detSubTable(d.sec) + '</div>';
    det.classList.add('gv-detail-wide');
    det.setAttribute('data-detmaster', d.master); det.setAttribute('data-detsel', d.sel); det.setAttribute('data-detname', d.detail);
    det.style.display = 'block';
  }
  function placeDetail(d) { const st = secState[d.master]; if (!st) return; if (st.view === 'graph') placeDetailGraph(d); else placeDetailTable(d); }
  // sağ-tık menüsü: bu master'dan (sel = seçilen satır) açılabilen detaylar için Show/Hide öğeleri
  function detMenu(master, sel, idx, midx, oidx) {
    const list = detailDefs[master]; if (!list || !list.length || !sel) return '';
    const idxAttr = ((idx != null && idx !== '') ? ' data-idx="' + esc(idx) + '"' : '')   // \${selected_index} için seçilen satırın index'i
      + ((midx != null && midx !== '') ? ' data-midx="' + esc(midx) + '"' : '')
      + ((oidx != null && oidx !== '') ? ' data-oidx="' + esc(oidx) + '"' : '');          // \${selected_master_index} için grubun master index'i
    let h = '';
    for (let i = 0; i < list.length; i++) {
      const dn = list[i]; const open = !!findDet(master, sel, dn);
      h += '<div class="cm-item ' + (open ? 'det-hide' : 'det-show') + '" data-section="' + esc(master) + '" data-detail="' + esc(dn) + '" data-el="' + esc(sel) + '"' + idxAttr + '>' + (open ? 'Hide ' : 'Show ') + esc(cap(dn)) + ' (detail)</div>';
    }
    return h;
  }
  // bir bölüm boyandıktan SONRA o master'ın tüm açık detaylarını yeniden yerleştir (tablo yeniden kurulduğu için)
  function applyDetails(master) { for (let i = 0; i < openDet.length; i++) if (openDet[i].master === master) placeDetail(openDet[i]); }
  function removeDetailDom(master, sel, detail) {
    const pane = paneOf(master); if (!pane) return;
    const rows = pane.querySelectorAll('tr.detrow');
    for (let i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-sel') === sel && rows[i].getAttribute('data-detail') === detail) rows[i].remove();
    const det = pane.querySelector('.gv-detail');
    if (det && det.getAttribute('data-detsel') === sel && det.getAttribute('data-detname') === detail) {
      det.style.display = 'none'; det.classList.remove('gv-detail-wide');
      det.removeAttribute('data-detmaster'); det.removeAttribute('data-detsel'); det.removeAttribute('data-detname');
      const b = det.querySelector('[id^="gdb-"]'); if (b) b.innerHTML = '';
    }
  }
  function closeDetailEntry(master, sel, detail) {
    openDet = openDet.filter(function (x) { return !(x.master === master && x.sel === sel && x.detail === detail); });
    vscodeApi.postMessage({ type: 'closeDetail', master: master, sel: sel, section: detail });
    removeDetailDom(master, sel, detail);
  }

  // henüz verisi gelmemiş (streaming sırasında sırada bekleyen / yeni gösterilen) bölüm için yer tutucu
  function paintLoading(name) {
    const body = bodyEl(name);
    if (body) body.innerHTML = '<div class="empty loading">Loading…</div>';
    const cnt = cntElOf(name);
    if (cnt) cnt.textContent = '…';
  }
  function hasData(name) { const st = secState[name]; return !!(st && st.sec); }
  // AKIŞ önizlemesi: kısmi bir bölümü (gelen satırlar/gruplar) bir "Loading… N row" başlığıyla çiz.
  // secState'i DEĞİŞTİRMEZ (değişiklik-vurgusu/önceki durak tabanı korunur); filtre/detay son boyamada uygulanır.
  function paintStream(name, sec) {
    const body = bodyEl(name); if (!body || !sec) return;
    const st = secState[name];
    const grouped = !!sec.grouped;
    const allRows = grouped ? (sec.groups || []).reduce(function (a, g) { return a.concat(g.rows || []); }, []) : (sec.rows || []);
    const n = allRows.length;
    if (st && (st.view === 'graph' || st.view === 'timeline')) { const c0 = cntElOf(name); if (c0) c0.textContent = n + '…'; return; }   // graph/timeline: yalnız son halde çizilir
    const order = Array.isArray(sec.columnsAll) ? sec.columnsAll : [];
    const hidden = Array.isArray(sec.hidden) ? sec.hidden : [];
    const cols = order.filter(function (l) { return hidden.indexOf(l) === -1; });
    const numCols = numericCols(cols, allRows);
    const sortCol = st ? st.sortCol : null, sortDir = (st && st.sortDir) ? st.sortDir : 'asc';
    const colBase = (st && st.colBase) ? st.colBase : {};
    const opts = { numCols: numCols, colBase: colBase, bars: sec.bars || {}, links: sec.links || {}, badges: sec.badges || {}, valueMap: sec.valueMap || {}, flags: sec.flags || {}, srcCols: sec.srcCols || [], sortCol: sortCol };
    const banner = '<div class="summary loading">Loading… ' + n + ' row' + (n === 1 ? '' : 's') + '</div>';
    let table;
    if (grouped && !(st && st.flat)) table = buildGroupedTable(cols, sec.groups || [], (st && st.collapsed) || [], sortCol, sortDir, opts);
    else table = buildTable(cols, allRows, sortCol, sortDir, null, opts);
    body.innerHTML = banner + table;
    const cnt = cntElOf(name); if (cnt) cnt.textContent = n + '…';
  }
  // --- Timeline (round-robin) gorunumu ---
  // Satirlar SERITLERE (lane) ayrilir, her satir bir BLOK olur. Config (bolumde "timeline": {...}):
  //   lane  = seridi belirleyen KOLON (yoksa: gruplu bolumde grup basligi, duz bolumde tek serit)
  //   order = lane ici SIRALAMA kolonu (sayisal; yoksa satir sirasi = round-robin dilim sirasi)
  //   label = blok ustundeki metin kolonu (yoksa ilk gorunur kolon)
  //   color = renk anahtari kolonu (badge/valueMap rengi varsa o; yoksa degerden kategorik renk)
  //   width = blok genisligi kolonu (degerle ORANTILI, orn dilim suresi; yoksa esit genislik)
  // Model saf fonksiyondur (buildTimelineModel) — release-gate testi verbatim kopyayla dogrular.
  // Timeline modeli: satırları ŞERİTLERE (lane) böler. rowsOverride verilirse (çoklu-grafik: bir grafiğin
  // alt-kümesi) o {row,ri,glabel} listesi kullanılır; yoksa sec (grouped/flat) taranır. Saf fonksiyon (test).
  function buildTimelineModel(sec, tcfg, rowsOverride) {
    tcfg = tcfg || {};
    const lanes = []; const laneIx = Object.create(null);   // düz {} DEĞİL: lane değeri 'constructor'/'__proto__' olabilir
    const push = (laneKey, row, ri) => {
      let li = laneIx[laneKey];
      if (li == null) { li = lanes.length; laneIx[laneKey] = li; lanes.push({ key: laneKey, blocks: [] }); }
      lanes[li].blocks.push({ row: row, ri: ri, w: 1 });
    };
    const laneOf = (row, fb) => (tcfg.lane != null && row[tcfg.lane] != null && row[tcfg.lane] !== '') ? String(row[tcfg.lane]) : fb;
    if (rowsOverride) {
      for (const e of rowsOverride) push(laneOf(e.row, e.glabel || ''), e.row, e.ri);
    } else if (sec.grouped) {
      let base = 0;
      (sec.groups || []).forEach(function (g) { (g.rows || []).forEach(function (r, j) { push(laneOf(r, g.label), r, base + j); }); base += (g.rows || []).length; });
    } else {
      (sec.rows || []).forEach(function (r, ri) { push(laneOf(r, ''), r, ri); });
    }
    if (tcfg.start) {
      // KONUMLU mod: her blok 's' (baslangic degeri) tasir; lane ici sira konumdan gelir (order yok sayilir)
      for (const ln of lanes) { for (const b of ln.blocks) { const sv = toIntVal(b.row[tcfg.start]); b.s = (sv != null && sv >= 0) ? sv : 0; } ln.blocks.sort(function (a, b2) { return a.s - b2.s; }); }
    } else if (tcfg.order) for (const ln of lanes) ln.blocks.sort(function (a, b) { return (toIntVal(a.row[tcfg.order]) || 0) - (toIntVal(b.row[tcfg.order]) || 0); });
    if (tcfg.width) for (const ln of lanes) for (const b of ln.blocks) { const w = toIntVal(b.row[tcfg.width]); b.w = (w != null && w > 0) ? w : 1; }
    return lanes;
  }
  // Bölümün tüm satırlarını (grouped/flat) düz {row, ri, glabel} listesine indir (çoklu-grafik bölme için).
  function tlFlat(sec) {
    const out = [];
    if (sec.grouped) { let base = 0; (sec.groups || []).forEach(function (g) { (g.rows || []).forEach(function (r, j) { out.push({ row: r, ri: base + j, glabel: g.label }); }); base += (g.rows || []).length; }); }
    else (sec.rows || []).forEach(function (r, ri) { out.push({ row: r, ri: ri, glabel: '' }); });
    return out;
  }
  // kategorik renk: degerden deterministik palet secimi (badge/valueMap rengi yoksa)
  const TL_PALETTE = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'];   // dataviz-dogrulanmis dark kategorik (lightness/chroma/kontrast PASS; CVD taban bandi -> ikincil kodlama: etiket+legend+bosluk)
  function tlColor(v) { let h = 0; v = String(v); for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0; return TL_PALETTE[h % TL_PALETTE.length]; }
  function buildTimeline(st) {
    const sec = st.sec;
    const t = sec.timeline || {};
    // ⏱ timeline.set: bloklar alt-dizi (device kümesi) chip'i taşır -> lane/blok daha yüksek + dikey düzen.
    // set TEK nesne YA DA DİZİ olabilir; küme SAYISI blok yüksekliğini belirler (her küme kendi chip satırı).
    const setDefs = t && t.set ? (Array.isArray(t.set) ? t.set : [t.set]) : [];
    const nSets = setDefs.length;
    const hasSet = nSets > 0;
    const trackH = 32 + nSets * 24;   // etiket + her küme satırı (~24px); tek küme -> 56 (eski görünüm), 2 küme -> 80 ...
    const cols = displayCols(st);
    if (!cols.length) return '<div class="empty">No visible columns.</div>';
    const labelCol = (t.label && cols.indexOf(t.label) !== -1) ? t.label : cols[0];
    const colorCol = t.color || labelCol;
    const flat = tlFlat(sec);
    if (!flat.length) return '<div class="empty">List is empty (root is NULL or count is 0).</div>';
    // config'in istedigi kolon gizliyse verisi HIC cekilmemistir -> acik uyari (sayi olan 'total' haric)
    const missing = ['lane', 'order', 'label', 'color', 'width', 'start', 'chart', 'total'].map(function (k) { return t[k]; })
      .filter(function (c) { return c && typeof c === 'string' && !/^\\d+$/.test(c) && cols.indexOf(c) === -1; });
    // CHART: t.chart kolonu verilirse her farkli deger AYRI bir grafik (kendi ekseni + kendi total'i). Yoksa TEK grafik.
    const chartCol = (t.chart && cols.indexOf(t.chart) !== -1) ? t.chart : null;
    const charts = [];
    if (chartCol) {
      const ix = Object.create(null);
      for (const e of flat) { const k = e.row[chartCol] != null ? String(e.row[chartCol]) : ''; let ci = ix[k]; if (ci == null) { ci = charts.length; ix[k] = ci; charts.push({ title: k, entries: [] }); } charts[ci].entries.push(e); }
    } else charts.push({ title: '', entries: flat });
    // total: SAYI ise tum grafiklerde sabit; KOLON adiysa her grafigin total'i o grafigin satirlarindan okunur
    // (senaryo: "her timeline'in uzunlugu her core'da ayni" -> tek deger). Satirlar celisirse ACIK uyari. Hesaplama YOK.
    const totalStr = t.total != null ? String(t.total) : '';
    const totalIsNum = /^\\d+$/.test(totalStr) && parseInt(totalStr, 10) > 0;
    const positionedWanted = !!t.start;
    let maxTotal = 1;
    for (const c of charts) {
      let tot = 0, terr = '';
      if (positionedWanted) {
        if (totalIsNum) tot = parseInt(totalStr, 10);
        else if (totalStr) {
          const vals = c.entries.map(function (e) { return toIntVal(e.row[totalStr]); }).filter(function (v) { return v != null; });
          tot = vals.length ? vals[0] : 0;
          if (vals.some(function (v) { return v !== vals[0]; })) terr = '⚠ "' + totalStr + '" differs within this chart — using ' + tot;
          if (!(tot > 0)) { terr = '⚠ positioned timeline needs a positive numeric "total" — sequential layout'; tot = 0; }
        } else terr = '⚠ positioned timeline (start) requires a "total" (number or column) — sequential layout';
      }
      c.total = tot; c.terr = terr; c.positioned = positionedWanted && tot > 0;
      if (tot > maxTotal) maxTotal = tot;
    }
    // scale: coklu-grafikte varsayilan 'proportional' (uzun timeline fiziksel olarak da uzun); 'fit' -> hepsi tam genislik.
    // st.tlFit runtime toggle'i (toolbar) config'i EZER: true=normalize(fit), false=orantili, undefined=config.
    const fitMode = st.tlFit != null ? st.tlFit : (t.scale === 'fit');
    const prop = chartCol && !fitMode;
    // YATAY ZOOM: st.tlZoom (>=1) grafik/ekseni pane'den GENİŞ çizer -> bloklar büyür, .tl-wrap yatay kayar.
    // zoom=1 = pane'e SIĞDIR (varsayılan). Konumlu (start) modda anlamlı; toolbar − / Fit / + ile ayarlanır.
    const zoom = (st.tlZoom && st.tlZoom > 1) ? st.tlZoom : 1;
    const legend = Object.create(null); const legendOrder = [];
    const fr = [0, 0.25, 0.5, 0.75, 1];
    let h = '<div class="tl-wrap">';
    if (missing.length) h += '<div class="det-empty">⚠ timeline column(s) hidden or unknown: ' + esc(missing.join(', ')) + ' — enable via ▦ Columns</div>';
    for (const c of charts) {
      const total = c.total, positioned = c.positioned;
      const baseW = (prop && positioned) ? (total / maxTotal * 100) : 100;
      // konumlu grafiğe (tek ya da çok) AÇIK genişlik ver -> zoom>1'de pane'i aşar (yatay scroll); tek-grafik zoom=1'de tam pane.
      const wpct = baseW * zoom;
      const useW = chartCol || positioned;
      h += '<div class="tl-chart"' + (useW ? ' style="width:' + wpct + '%"' : '') + '>';
      if (chartCol) h += '<div class="tl-ctitle">' + esc(c.title) + (positioned ? (' <span class="tl-ctot">· ' + (t.totalLabel ? esc(String(t.totalLabel)) + ' ' : '') + total + (t.unit ? (' ' + esc(String(t.unit))) : '') + '</span>') : '') + '</div>';
      if (c.terr) h += '<div class="det-empty">' + c.terr + '</div>';
      // total ETIKETI: totalLabel verilmisse eksende "<etiket>: <total> <birim>" (VARSAYILMAZ). Chart bolunmusse baslikta zaten var.
      if (positioned && !chartCol && t.totalLabel) h += '<div class="tl-tcap">' + esc(String(t.totalLabel)) + ': ' + total + (t.unit ? (' ' + esc(String(t.unit))) : '') + '</div>';
      if (positioned) {
        const unit = t.unit ? (' ' + String(t.unit)) : '';
        h += '<div class="tl-lane tl-axis"><div class="tl-lname"></div><div class="tl-track tl-pos tl-axistrack">';
        for (let fi = 0; fi < fr.length; fi++) {
          const tx = fi === 0 ? 'translateX(0)' : (fi === fr.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)');
          h += '<span class="tl-tick" style="left:' + (fr[fi] * 100) + '%;transform:' + tx + '">' + Math.round(total * fr[fi]) + (fi === fr.length - 1 ? esc(unit) : '') + '</span>';
        }
        h += '</div></div>';
      }
      const lanes = buildTimelineModel(sec, t, c.entries);
      for (let li = 0; li < lanes.length; li++) {
        const ln = lanes[li];
        const trackStyle = hasSet ? (' style="' + (positioned ? 'height' : 'min-height') + ':' + trackH + 'px"') : '';   // küme sayısına göre yükseklik
        h += '<div class="tl-lane' + (li % 2 ? ' tl-alt' : '') + '"><div class="tl-lname" title="' + esc(ln.key) + '">' + esc(ln.key) + '</div><div class="tl-track' + (positioned ? ' tl-pos' : '') + (hasSet ? ' tl-hasset' : '') + '"' + trackStyle + '>';
        if (positioned) h += '<i class="tl-grid" style="left:25%"></i><i class="tl-grid" style="left:50%"></i><i class="tl-grid" style="left:75%"></i>';
        for (const b of ln.blocks) {
          const cv = b.row[colorCol] != null ? String(b.row[colorCol]) : '';
          let colr = null;
          const vm = valueMapEntry((sec.valueMap || {})[colorCol], cv, cv); if (vm && vm.hex) colr = vm.hex;
          if (!colr) { const bh = badgeHex(matchBadge((sec.badges || {})[colorCol], cv)); if (bh) colr = bh; }
          if (!colr) colr = tlColor(cv);
          const lbl = b.row[labelCol] != null ? String(b.row[labelCol]) : '';
          // ⏱ timeline.set: bu bloğun alt dizileri (device/signal kümeleri) — attachTimelineSet __tlsets__'e koydu
          const tsets = b.row['__tlsets__'];
          const nonEmpty = Array.isArray(tsets) ? tsets.filter(function (s) { return s && s.items && s.items.length; }) : [];
          const hasBlkSet = nonEmpty.length > 0;
          let setHtml = '';
          // caption = kümenin title'ı VERİLMİŞSE her zaman yazılır (tek set'te de) — chip'lerin soluna küçük etiket
          if (hasBlkSet) setHtml = tsets.map(function (s) {
            if (!s || !s.items || !s.items.length) return '';
            const capH = s.title ? '<span class="tl-scap" title="' + esc(String(s.title)) + '">' + esc(String(s.title)) + '</span>' : '';
            const chips = s.items.map(function (d, di) { const dash = s.dashes && s.dashes[di]; return '<span class="tl-chip' + (dash ? ' tl-chip-dash' : '') + '" style="color:' + colr + ';background:' + colr + '2e;border-color:' + colr + '66">' + esc(String(d)) + '</span>'; }).join('');
            return '<span class="tl-setrow">' + capH + '<span class="tl-set">' + chips + '</span></span>';
          }).join('');
          const baseTip = cols.map(function (col) { return col + ': ' + (b.row[col] != null ? b.row[col] : ''); }).join('\\n');
          // tooltip her zaman TAM listeleri taşır (blok kırpsa bile): her küme "title (N): ..." (title yoksa isimsiz)
          const setTip = nonEmpty.map(function (s) { return (s.title ? s.title + ' ' : '') + '(' + s.items.length + '): ' + s.items.join(', '); }).join('\\n');
          const tip = baseTip + (setTip ? ('\\n\\n' + setTip) : '');
          if (cv !== '' && !(cv in legend)) { legend[cv] = colr; legendOrder.push(cv); }
          const geom = positioned
            ? 'left:' + ((b.s || 0) / total * 100) + '%;width:' + Math.max((t.width ? b.w : 1) / total * 100, 0.5) + '%'
            : 'flex-grow:' + b.w;
          h += '<div class="tl-blk' + (positioned ? ' tl-abs' : '') + (hasBlkSet ? ' tl-hasset' : '') + '" style="' + geom + ';background:' + colr + '33;border-color:' + colr + '" title="' + esc(tip) + '" data-ri="' + b.ri + '"><span class="tl-lbl">' + esc(lbl) + '</span>' + setHtml + '</div>';
        }
        h += '</div></div>';
      }
      h += '</div>';   // .tl-chart
    }
    // blok TIKLAMA detay kartı (docked, timeline'ın altında): render'da BOŞ gelir; showTlDetail() DOM'da doldurur
    // (graph'ın gv-detail deseni — seçili bloğun TÜM alanları + device kümesi, flag/valueMap çözümüyle).
    h += '<div class="tl-detail" style="display:none"><span class="tl-dclose" title="Close">✕</span><h4 class="tl-dtitle"></h4><div class="tl-dbody"></div></div>';
    if (legendOrder.length >= 2) {   // tek seri legend istemez; >=2'de KIMLIK yalniz renkte kalmasin
      // legend BAŞLIĞI: renkler hangi field'ı (color kolonu) kodluyor -> "Part:" gibi
      h += '<div class="tl-legend"><span class="tl-lgcap">' + esc(colorCol) + ':</span>';
      const cap = 12;
      for (let gi = 0; gi < Math.min(legendOrder.length, cap); gi++) { const v = legendOrder[gi]; h += '<span class="tl-lgitem"><i class="tl-lgsw" style="background:' + legend[v] + '"></i>' + esc(v) + '</span>'; }
      if (legendOrder.length > cap) h += '<span class="tl-lgitem tl-lgmore">+' + (legendOrder.length - cap) + '</span>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }
  // timeline satırlarını data-ri sırasıyla düz listeye indir (buildTimelineModel/tlFlat ile AYNI sıra: grouped -> base+j)
  function tlRows(sec) {
    if (!sec) return [];
    return sec.grouped ? (sec.groups || []).reduce(function (a, g) { return a.concat(g.rows || []); }, []) : (sec.rows || []);
  }
  // blok TIKLAMA detayı (docked kart): seçili bloğun TÜM görünür alanları + device kümesi. Graph gv-detail deseni:
  // flag/valueMap/badge çözümü + ham değer parantezde. det kutusu buildTimeline'da BOŞ render edilir; burada doldurulur.
  function showTlDetail(name, ri) {
    const st = secState[name]; if (!st || !st.sec) return;
    const body = bodyEl(name); if (!body) return;
    const det = body.querySelector('.tl-detail'); if (!det) return;
    const row = tlRows(st.sec)[ri]; if (!row) { det.style.display = 'none'; st.tlSel = null; return; }
    const t = st.sec.timeline || {};
    const cols = displayCols(st);
    const _df = st.sec.flags || {}, _dvm = st.sec.valueMap || {};
    const _cell = function (c, raw) {
      if (_df[c]) { const fh = flagsHtml(_df[c], raw); if (fh != null) return fh + ' <span class="gd-int">(' + esc(shortVal(raw)) + ')</span>'; }
      if (_dvm[c]) { const ve = valueMapEntry(_dvm[c], raw, shortVal(raw)); if (ve) { const pill = ve.hex ? '<span class="badge" style="background:' + ve.hex + '30;color:' + ve.hex + '">' + esc(ve.text) + '</span>' : '<span class="vmap">' + esc(ve.text) + '</span>'; const sv = shortVal(raw); return pill + (ve.text !== sv ? ' <span class="gd-int">(' + esc(sv) + ')</span>' : ''); } }
      return esc(shortVal(raw));
    };
    const titleCol = (t.label && cols.indexOf(t.label) !== -1) ? t.label : (cols.length ? cols[0] : '');
    const title = (titleCol && row[titleCol] != null) ? shortVal(row[titleCol]) : '';
    let html = cols.map(function (c) { return '<div class="grow2"><span>' + esc(c) + '</span><b>' + _cell(c, row[c]) + '</b></div>'; }).join('');
    const tsets = row['__tlsets__'];   // her küme (device/signal) -> ayrı grow2 satırı; kesikli bayrakları (dashWhen) yansıtılır
    if (Array.isArray(tsets)) tsets.forEach(function (s, si) {
      if (!s || !s.items || !s.items.length) return;
      const cap2 = (typeof s.title === 'string' && s.title) ? s.title : 'set' + (tsets.length > 1 ? (' ' + (si + 1)) : '');   // title (VARSAYILMAZ; yoksa nötr "set"/"set N")
      const chips = s.items.map(function (d, di) { const dash = s.dashes && s.dashes[di]; return '<span class="tl-chip' + (dash ? ' tl-chip-dash' : '') + '" style="color:var(--vscode-textLink-foreground,#58a6ff);border-color:rgba(88,166,255,0.4)">' + esc(String(d)) + '</span>'; }).join('');
      html += '<div class="grow2"><span>' + esc(cap2) + ' (' + s.items.length + ')</span><b>' + chips + '</b></div>';
    });
    det.querySelector('.tl-dtitle').textContent = title;
    det.querySelector('.tl-dbody').innerHTML = html;
    det.style.display = 'block';
    const blks = body.querySelectorAll('.tl-blk'); for (let i = 0; i < blks.length; i++) blks[i].classList.toggle('tl-sel', blks[i].getAttribute('data-ri') === String(ri));
    st.tlSel = ri;
  }
  function hideTlDetail(name) {
    const st = secState[name]; if (st) st.tlSel = null;
    const body = bodyEl(name); if (!body) return;
    const det = body.querySelector('.tl-detail'); if (det) det.style.display = 'none';
    const blks = body.querySelectorAll('.tl-blk.tl-sel'); for (let i = 0; i < blks.length; i++) blks[i].classList.remove('tl-sel');
  }
  // ⏱ timeline.set OTOMATİK SIĞDIRMA: bir bloğa sığmayan device chip'lerini sondan gizle, yerine "+N" rozeti koy
  // (tam liste her zaman tooltip'te). ÖLÇÜME dayalı (scroll/clientHeight) -> render SONRASI çalışır. Blok genişleyince
  // (zoom) baştan tüm chip'leri gösterip yeniden hesaplar -> daha fazlası sığar. (DOM shim ölçemez -> canlı doğrulanır.)
  function fitTimelineSets(root) {
    if (!root || !root.querySelectorAll) return;
    const sets = root.querySelectorAll('.tl-blk.tl-hasset .tl-set');
    for (let si = 0; si < sets.length; si++) {
      const setEl = sets[si];
      const chips = [];
      for (let ci = 0; ci < setEl.children.length; ci++) { const c = setEl.children[ci]; if (('' + (c.className || '')).indexOf('tl-more') === -1) chips.push(c); }
      for (const c of chips) c.style.display = '';                          // önce hepsini görünür yap (temiz başlangıç)
      let more = setEl.querySelector('.tl-more'); if (more) { more.remove(); more = null; }
      const fits = function () { return setEl.scrollHeight <= setEl.clientHeight + 1 && setEl.scrollWidth <= setEl.clientWidth + 1; };
      if (fits()) continue;                                                 // hepsi sığıyor -> dokunma
      more = document.createElement('span'); more.className = 'tl-chip tl-more'; setEl.appendChild(more);
      let hidden = 0;
      for (let k = chips.length - 1; k >= 0 && !fits(); k--) { chips[k].style.display = 'none'; hidden++; more.textContent = '+' + hidden; }
      if (hidden === 0) { more.remove(); } else { more.title = hidden + ' more'; }   // hiç gizlenmediyse rozet gereksiz
    }
  }
  function paint(name) {
    const st = secState[name];
    const body = bodyEl(name);
    if (!st || !st.sec || !body) return;
    if (st.sec.needsSelection) {
      body.innerHTML = '<div class="empty">Master section for "' + esc(name) + '" is empty or missing.</div>';
      return;
    }
    if (st.sec.error) {   // bölüm kurulumu hata verdi (örn geçersiz levels config'i) -> açık uyarı, panelin kalanı çalışır
      body.innerHTML = '<div class="empty">⚠ ' + esc(st.sec.error) + '</div>';
      return;
    }
    if (st.view === 'graph') { renderGraph(name); applyDetails(name); return; }
    if (st.view === 'timeline' && !st.sec.timeline) st.view = 'table';   // config'ten "timeline" kaldırıldı -> tabloya dön (butonsuz kilitli kalma)
    if (st.view === 'timeline') {
      body.innerHTML = '<div class="summary">' + esc(st.sec.summary) + '</div>' + toolbarHtml(st) + buildTimeline(st);
      fitTimelineSets(body);   // device chip'leri bloğa sığdır (taşanları "+N" rozetine indir) — render sonrası ölçüm
      if (st.tlSel != null) showTlDetail(name, st.tlSel);   // zoom/yeniden çizimde açık detay kartını geri getir
      return;
    }
    const cols = displayCols(st);
    const grouped = st.sec.grouped;
    const allRows = grouped ? st.sec.groups.reduce((a, g) => a.concat(g.rows), []) : st.sec.rows;
    const numCols = numericCols(cols, allRows);
    st.numCols = numCols;   // ▦ Columns menüsü per-kolon base düğmesi için kullanır
    const opts = { numCols: numCols, colBase: st.colBase || {}, bars: st.sec.bars || {}, links: st.sec.links || {}, badges: st.sec.badges || {}, valueMap: st.sec.valueMap || {}, flags: st.sec.flags || {}, srcCols: st.sec.srcCols || [], sortCol: st.sortCol };
    const summary = '<div class="summary">' + esc(st.sec.summary) + '</div>';
    const bar = toolbarHtml(st);
    let table;
    if (grouped && !st.flat) {
      table = buildGroupedTable(cols, st.sec.groups, st.collapsed || [], st.sortCol, st.sortDir, opts);
    } else if (grouped && st.flat) {
      table = buildTable(cols, allRows, st.sortCol, st.sortDir, null, opts);
    } else {
      table = buildTable(cols, st.sec.rows, st.sortCol, st.sortDir, st.changed, opts);
    }
    body.innerHTML = summary + bar + table;
    applyFilter(name);   // korunan filtre/changed-only'i taze DOM'a uygula
    applyDetails(name);  // master satırların altındaki açık talep-üzerine detayları yeniden ekle (tablo yeniden kuruldu)
  }

  function buildColsMenu(name) {
    const menu = colsMenuEl(name);
    const st = secState[name];
    if (!menu) return;
    if (!st) { menu.innerHTML = ''; return; }
    let h = '<div class="cols-title">Columns — drag to reorder, toggle visibility</div>';
    // toplu aksiyonlar (Sections menüsüyle ORTAK): tüm kolonları aç / kapat (kapatta ilk GÖRÜNÜR kolon kalır)
    h += '<div class="cols-actions"><div class="cm-item col-showall">Show all</div><div class="cm-item col-hideall" title="Keeps the first visible column">Hide all</div></div>';
    st.order.forEach(label => {
      const checked = st.hidden.indexOf(label) === -1 ? ' checked' : '';
      h += '<div class="cols-item" data-label="' + esc(label) + '" draggable="true">' +
        '<span class="cols-grip" title="Drag to reorder">⠿</span>' +
        '<label><input type="checkbox" data-act="vis"' + checked + '> ' + esc(label) + '</label>' +
        '</div>';
    });
    menu.innerHTML = h;
  }

  function afterColChange(name, refetch, shownLabel) {
    const st = secState[name];
    paint(name);
    buildColsMenu(name);
    vscodeApi.postMessage({
      type: 'setColumns', section: name,
      order: st.order.slice(), hidden: st.hidden.slice(), refetch: !!refetch,
      shown: shownLabel || null
    });
  }

  function renderSection(name, sec) {
    const prev = secState[name];
    const order = Array.isArray(sec.columnsAll) ? sec.columnsAll.slice() : [];
    const hidden = Array.isArray(sec.hidden) ? sec.hidden.slice() : [];
    const cols = order.filter(l => hidden.indexOf(l) === -1);
    const sortCol = prev && prev.sortCol && cols.indexOf(prev.sortCol) !== -1 ? prev.sortCol : null;
    const sortDir = prev && prev.sortDir ? prev.sortDir : 'asc';
    let changed = {}, count = 0;
    if (!sec.grouped) {
      const ch = computeChanges(prev && prev.sec ? prev.sec.rows : null, sec.rows, cols);
      changed = ch.map; count = ch.count;
    }
    const flat = !!(prev && prev.flat);
    const collapsed = (prev && prev.collapsed) ? prev.collapsed : [];
    const filter = (prev && prev.filter) ? prev.filter : '';
    const changedOnly = !!(prev && prev.changedOnly);
    // per-kolon sayı tabanı: kullanıcının önceki seçimi korunur, config (sec.bases) ilk kez doldurur
    const colBase = (prev && prev.colBase) ? prev.colBase : {};
    if (sec.bases) for (const k in sec.bases) if (!(k in colBase)) colBase[k] = sec.bases[k];
    // graph view: görünüm modu (table/graph) ve pan/zoom durumu (gv) yenilemeler arası korunur
    const view = (prev && prev.view) ? prev.view : 'table';
    const gv = (prev && prev.gv) ? prev.gv : null;
    secState[name] = { sec, sortCol, sortDir, changed, changeCount: count, order, hidden, flat, collapsed, filter, changedOnly, colBase, view, gv };
    const cnt = cntElOf(name);
    if (cnt) cnt.textContent = sec.grouped ? (sec.groups || []).reduce((a, g) => a + g.rows.length, 0) : sec.rows.length;
    const tab = tabElOf(name);
    if (tab) {
      if (count > 0 && name !== activeName) tab.classList.add('haschg');
      else if (name === activeName) tab.classList.remove('haschg');
    }
    // paint() burada DEĞİL: önce tüm bölümlerin secState'i dolsun ki link eşleşme
    // kontrolü (linkHasTarget) diğer bölümlerin verisini görebilsin (sıra bağımsız).
    return count;
  }

  // Sekme tıklaması (delegasyon — container kalıcı, sekmeler dinamik)
  tabsEl.addEventListener('click', e => {
    const t = e.target.closest('.tab[data-idx]');
    if (t) switchTab(currentNames[+t.dataset.idx]);
  });

  function paneName(e) {
    const pane = e.target.closest('.pane[data-idx]');
    return pane ? currentNames[+pane.dataset.idx] : null;
  }

  // Tüm pane etkileşimleri #panes üzerinde delegasyonla (dinamik pane'ler için)
  let dragCol = null, dragName = null, suppressClick = false;
  let menuDragLabel = null, menuDragName = null, dragGhost = null;
  function clearDropMarks() {
    for (const x of document.querySelectorAll('.drop-target')) x.classList.remove('drop-target');
    for (const x of document.querySelectorAll('.drop-row')) x.classList.remove('drop-row');
  }
  // Sürüklenen öğenin imleci takip eden net önizlemesi (çip)
  function setGhost(e, label) {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.textContent = label;
    document.body.appendChild(g);
    if (e.dataTransfer && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(g, 12, 14);
    dragGhost = g;
  }
  function clearGhost() {
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  }

  panesEl.addEventListener('click', e => {
    // çapraz-referans linki: hedef nesneye git
    const xref = e.target.closest('.xref');
    if (xref) { e.preventDefault(); e.stopPropagation(); gotoXref(xref.dataset.sec, xref.dataset.match, xref.dataset.val); return; }
    // kaynak konumu linki (sourceLine): "dosya:satır" -> editörde aç (uzantı findFiles ile çözer)
    const srcref = e.target.closest('.srcref');
    if (srcref) { e.preventDefault(); e.stopPropagation(); vscodeApi.postMessage({ type: 'openSource', loc: srcref.dataset.loc || '' }); return; }
    // ⏱ timeline: detay kartı kapat (✕)
    const tlx = e.target.closest('.tl-dclose');
    if (tlx) { const p = e.target.closest('.pane[data-idx]'); if (p) hideTlDetail(currentNames[+p.getAttribute('data-idx')]); e.stopPropagation(); return; }
    // ⏱ timeline: bloğa tıkla -> docked detay kartı (aynı bloğa tekrar tıkla -> kapat)
    const tlb = e.target.closest('.tl-blk');
    if (tlb) {
      const p = e.target.closest('.pane[data-idx]');
      if (p) { const nm = currentNames[+p.getAttribute('data-idx')]; const st2 = secState[nm]; const ri = parseInt(tlb.getAttribute('data-ri'), 10);
        if (st2 && st2.tlSel === ri) hideTlDetail(nm); else showTlDetail(nm, ri); }
      e.stopPropagation(); return;
    }
    // hücre bağlam menüsü: kopya / düzenle
    const cc = e.target.closest('.cell-copy');
    if (cc) { vscodeApi.postMessage({ type: 'copy', text: cc.dataset.text || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const cw = e.target.closest('.cell-watch');
    if (cw) { vscodeApi.postMessage({ type: 'copyWatch', text: cw.dataset.el || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const dsh = e.target.closest('.det-show');
    if (dsh) {   // talep-üzerine detay aç: kaydet + uzantıdan çek + anlık "Loading…"
      const mn = dsh.dataset.section, sel = dsh.dataset.el, dn = dsh.dataset.detail, sidx = dsh.dataset.idx, smidx = dsh.dataset.midx, soidx = dsh.dataset.oidx;
      if (!findDet(mn, sel, dn)) openDet.push({ master: mn, sel: sel, detail: dn, sec: null });
      vscodeApi.postMessage({ type: 'openDetail', master: mn, sel: sel, section: dn, selIndex: sidx != null ? sidx : '', selMasterIndex: smidx != null ? smidx : '', selOuterIndex: soidx != null ? soidx : '' });
      placeDetail(findDet(mn, sel, dn));
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
    const dhi = e.target.closest('.det-hide');
    if (dhi) {   // menüden gizle
      closeDetailEntry(dhi.dataset.section, dhi.dataset.el, dhi.dataset.detail);
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
    const dx = e.target.closest('.det-x');
    if (dx) {   // detay başlığındaki ✕ (tablo accordion içinde)
      const tr = dx.closest('.detrow');
      if (tr) closeDetailEntry(tr.getAttribute('data-master'), tr.getAttribute('data-sel'), tr.getAttribute('data-detail'));
      e.stopPropagation(); return;
    }
    const gco = e.target.closest('.gv-collapse');
    if (gco) {   // graph: grup (partition) düğümü collapse/expand (tablo ile AYNI st.collapsed)
      const stg = secState[gco.dataset.section];
      if (stg) { stg.collapsed = stg.collapsed || []; const k = gco.dataset.gkey; const ix = stg.collapsed.indexOf(k); if (ix === -1) stg.collapsed.push(k); else stg.collapsed.splice(ix, 1); paint(gco.dataset.section); }
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
    const sg = e.target.closest('.show-graph');
    if (sg) {   // tablo satırı -> graph görünümüne geç + o satırın düğümüne merkezlen
      const nm = sg.dataset.section; const stg = secState[nm];
      if (stg && stg.sec) {
        stg.view = 'graph'; if (!stg.gv) stg.gv = gvInit();
        paint(nm);
        const cols = displayCols(stg);
        const allRows = stg.sec.grouped ? stg.sec.groups.reduce((a, g) => a.concat(g.rows), []) : stg.sec.rows;
        const ri = (sg.dataset.ri != null && sg.dataset.ri !== '') ? +sg.dataset.ri : -1;
        const row = (ri >= 0 && allRows[ri]) ? allRows[ri] : null;
        if (row && cols.length && typeof stg._focusNode === 'function') stg._focusNode(cols[0], row[cols[0]]);
      }
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
    const wp = e.target.closest('.cell-wp');
    if (wp) { vscodeApi.postMessage({ type: 'watchpoint', expr: wp.dataset.lv || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const uwp = e.target.closest('.cell-unwp');
    if (uwp) { vscodeApi.postMessage({ type: 'unwatchpoint', expr: uwp.dataset.lv || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const ce = e.target.closest('.cell-edit');
    if (ce) {
      const riAttr = ce.dataset.ri;
      vscodeApi.postMessage({ type: 'editValue', expr: ce.dataset.edit, current: ce.dataset.cur || '', section: ce.dataset.section || null, rowIndex: (riAttr != null && riAttr !== '') ? +riAttr : null, label: ce.dataset.col || null });
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
    const colsBtn = e.target.closest('.cols-btn');
    if (colsBtn) {
      e.stopPropagation();
      const name = paneName(e);
      const menu = colsMenuEl(name);
      const willOpen = menu.classList.contains('hidden');
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
      if (willOpen) {
        buildColsMenu(name);
        const r = colsBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        menu.classList.remove('hidden');
      }
      return;
    }
    // Columns menüsü toplu aksiyonları (Sections'la ORTAK): tüm kolonları aç / kapat — .cols-menu yutmasından ÖNCE
    const csa = e.target.closest('.col-showall');
    if (csa) {
      const name = paneName(e); const st = secState[name];
      // gizli kolonların verisi hiç çekilmemiştir -> refetch:true (shown YOK) tüm bölümü aktif kolonlarla yeniden kurar
      if (st && st.hidden.length) { st.hidden = []; afterColChange(name, true); }
      e.stopPropagation(); return;
    }
    const cha = e.target.closest('.col-hideall');
    if (cha) {
      const name = paneName(e); const st = secState[name];
      if (st) {
        const visCols = st.order.filter(l => st.hidden.indexOf(l) === -1);
        if (visCols.length > 1) { st.hidden = st.order.filter(l => l !== visCols[0]); afterColChange(name, false); }   // ilk GÖRÜNÜR kolon kalır (gizli kolonu keeper yapma: verisi yok)
      }
      e.stopPropagation(); return;
    }
    if (e.target.closest('.cols-menu')) { e.stopPropagation(); return; }
    // başlık sağ üstü taban seçici (10/16/2) — th-sort'tan ÖNCE
    const hb = e.target.closest('.hb');
    if (hb) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.colBase = st.colBase || {}; const l = hb.dataset.col;
        st.colBase[l] = nextBase(st.colBase[l] || 'raw');   // raw -> dec -> hex -> bin -> raw
        paint(name); }
      e.stopPropagation();
      return;
    }
    // timeline ÖLÇEK toggle'ı: proportional <-> normalize (fit) — anlık, config'i ezer
    const fitBtn = e.target.closest('.tl-fit-toggle');
    if (fitBtn) {
      const name = paneName(e); const st = secState[name];
      if (st) { const t = (st.sec && st.sec.timeline) || {}; const cur = st.tlFit != null ? st.tlFit : (t.scale === 'fit'); st.tlFit = !cur; paint(name); }
      return;
    }
    const zoBtn = e.target.closest('.tl-zoom-out'), ziBtn = e.target.closest('.tl-zoom-in');
    if (zoBtn || ziBtn) {   // yatay zoom: 1(fit)..16, 2x adim
      const name = paneName(e); const st = secState[name];
      if (st) { const cur = (st.tlZoom && st.tlZoom > 1) ? st.tlZoom : 1; st.tlZoom = ziBtn ? Math.min(16, cur * 2) : Math.max(1, cur / 2); paint(name); }
      return;
    }
    // tablo <-> graph <-> timeline görünüm geçişi (buton data-view taşır; eski iki-görünüm toggle'ı fallback)
    const vtBtn = e.target.closest('.view-toggle');
    if (vtBtn) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.view = vtBtn.dataset.view || (st.view === 'graph' ? 'table' : 'graph'); if (st.view === 'graph' && !st.gv) st.gv = gvInit(); paint(name); }
      return;
    }
    // graph: görünüme sığdır
    if (e.target.closest('.graph-fit')) {
      const name = paneName(e); const st = secState[name];
      if (st && typeof st._fit === 'function') st._fit();
      return;
    }
    // graph: cross-section link katmanını aç/kapa (Phase 2)
    if (e.target.closest('.links-toggle')) {
      const name = paneName(e); const st = secState[name];
      if (st) { if (!st.gv) st.gv = gvInit(); st.gv.links = !st.gv.links; paint(name); }
      return;
    }
    // graph: minimap'i aç/kapa (Phase 3) — yeniden çizmeden, sadece CSS
    if (e.target.closest('.map-toggle')) {
      const name = paneName(e); const st = secState[name]; const mb = e.target.closest('.map-toggle');
      if (st) { if (!st.gv) st.gv = gvInit(); st.gv.mini = !st.gv.mini; mb.classList.toggle('on', st.gv.mini); const bd = bodyEl(name); const mn = bd && bd.querySelector('.gv-mini'); if (mn) mn.classList.toggle('hidden', !st.gv.mini); }
      return;
    }
    // grup: düz/ağaç görünüm geçişi
    if (e.target.closest('.grp-toggle')) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.flat = !st.flat; paint(name); }
      return;
    }
    // grup: tümünü kapat / tümünü aç (hepsi kapalıysa aç, değilse hepsini kapat)
    if (e.target.closest('.collapse-all')) {
      const name = paneName(e); const st = secState[name];
      if (st && st.sec && st.sec.groups) {
        st.collapsed = st.collapsed || [];
        const keys = st.sec.groups.map(function (g) { return g.key; });
        const allCol = keys.length > 0 && keys.every(function (k) { return st.collapsed.indexOf(k) !== -1; });
        st.collapsed = allCol ? [] : keys.slice();
        paint(name);
      }
      return;
    }
    // araç çubuğu: changed-only / sayı tabanı / kopya
    const chgBtn = e.target.closest('.chg-only');
    if (chgBtn) { const name = paneName(e); const st = secState[name]; if (st) { st.changedOnly = !st.changedOnly; chgBtn.classList.toggle('on', st.changedOnly); applyFilter(name); } return; }
    const csvBtn = e.target.closest('.copy-csv');
    if (csvBtn) { copyTable(paneName(e), 'csv'); flashBtn(csvBtn); return; }
    const mdBtn = e.target.closest('.copy-md');
    if (mdBtn) { copyTable(paneName(e), 'md'); flashBtn(mdBtn); return; }
    // grup başlığı: aç/kapa
    const grphdr = e.target.closest('tr.grphdr');
    if (grphdr) {
      const name = paneName(e); const st = secState[name];
      if (st) {
        st.collapsed = st.collapsed || [];
        const k = grphdr.dataset.grp; const ix = st.collapsed.indexOf(k);
        if (ix === -1) st.collapsed.push(k); else st.collapsed.splice(ix, 1);
        paint(name);
      }
      return;
    }
    const th = e.target.closest('th[data-col]');
    if (th) {
      if (suppressClick) { suppressClick = false; return; }
      const name = paneName(e);
      const st = secState[name];
      if (!st) return;
      const col = th.dataset.col;
      if (st.sortCol === col) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
      else { st.sortCol = col; st.sortDir = 'asc'; }
      paint(name);
      return;
    }
  });

  // filtre kutusu: yalnız DOM'da gizle (yeniden çizim yok -> odak korunur)
  panesEl.addEventListener('input', e => {
    const inp = e.target.closest('.tbl-filter');
    if (!inp) return;
    const name = paneName(e); const st = secState[name];
    if (!st) return;
    st.filter = inp.value;
    applyFilter(name);
  });

  panesEl.addEventListener('change', e => {
    const cb = e.target.closest('.cols-menu input[data-act="vis"]');
    if (!cb) return;
    const name = paneName(e);
    const st = secState[name];
    if (!st) return;
    const label = cb.closest('.cols-item').dataset.label;
    const hi = st.hidden.indexOf(label);
    if (cb.checked) {
      if (hi !== -1) st.hidden.splice(hi, 1);
      afterColChange(name, true, label);   // sadece bu kolonun verisi çekilsin
    } else {
      const visible = st.order.filter(l => st.hidden.indexOf(l) === -1).length;
      if (visible <= 1) { cb.checked = true; return; }
      if (hi === -1) st.hidden.push(label);
      afterColChange(name, false);
    }
  });

  panesEl.addEventListener('dragstart', e => {
    const item = e.target.closest('.cols-item');
    if (item) {
      menuDragName = paneName(e);
      menuDragLabel = item.dataset.label;
      item.classList.add('row-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', menuDragLabel); }
      setGhost(e, menuDragLabel);
      return;
    }
    if (e.target.closest('.hb')) { e.preventDefault(); return; }   // taban seçicide sürükleme başlatma
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    suppressClick = false;
    dragName = paneName(e);
    dragCol = th.dataset.col;
    th.classList.add('dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragCol); }
    setGhost(e, dragCol);
  });
  panesEl.addEventListener('dragover', e => {
    if (menuDragLabel !== null) {
      const item = e.target.closest('.cols-item');
      if (!item) return;
      e.preventDefault();
      clearDropMarks();
      item.classList.add('drop-row');
      return;
    }
    if (dragCol !== null) {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      th.classList.add('drop-target');
    }
  });
  panesEl.addEventListener('drop', e => {
    if (menuDragLabel !== null) {
      e.preventDefault();
      const item = e.target.closest('.cols-item');
      const name = menuDragName;
      const st = secState[name];
      if (st && item) {
        const target = item.dataset.label;
        if (target !== menuDragLabel) {
          const from = st.order.indexOf(menuDragLabel), to = st.order.indexOf(target);
          if (from !== -1 && to !== -1) { st.order.splice(from, 1); st.order.splice(to, 0, menuDragLabel); afterColChange(name, false); }
        }
      }
      clearDropMarks();
      menuDragLabel = null; menuDragName = null;
      return;
    }
    if (dragCol !== null) {
      e.preventDefault();
      const th = e.target.closest('th[data-col]');
      const name = paneName(e);
      const st = secState[name];
      if (st && th && name === dragName) {
        const target = th.dataset.col;
        if (target !== dragCol) {
          const from = st.order.indexOf(dragCol), to = st.order.indexOf(target);
          if (from !== -1 && to !== -1) { st.order.splice(from, 1); st.order.splice(to, 0, dragCol); afterColChange(name, false); }
        }
      }
      clearDropMarks();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
      dragCol = null; dragName = null;
    }
  });
  panesEl.addEventListener('dragend', () => {
    for (const x of panesEl.querySelectorAll('.dragging')) x.classList.remove('dragging');
    for (const x of panesEl.querySelectorAll('.row-dragging')) x.classList.remove('row-dragging');
    clearDropMarks();
    clearGhost();
    dragCol = null; dragName = null; menuDragLabel = null; menuDragName = null;
  });
  function popMenu(name, e, html) {
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
    const menu = colsMenuEl(name); if (!menu) return;
    menu.innerHTML = html;
    menu.style.position = 'fixed';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 40) + 'px';
    menu.classList.remove('hidden');
  }
  panesEl.addEventListener('contextmenu', e => {
    const name = paneName(e);
    if (!name || !secState[name]) return;
    const th = e.target.closest('th[data-col]');
    if (th) {   // başlık: kolon menüsü
      e.preventDefault();
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
      buildColsMenu(name);
      const menu = colsMenuEl(name);
      menu.style.position = 'fixed';
      menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 40) + 'px';
      menu.classList.remove('hidden');
      return;
    }
    const gnode = e.target.closest('.gnode');
    if (gnode) {   // graph düğümü sağ tık
      e.preventDefault();
      if (gnode.dataset.gkey != null) {   // grup (partition) düğümü: collapse / expand
        const collapsed = gnode.classList.contains('gv-collapsed');
        popMenu(name, e, '<div class="cm-item gv-collapse" data-section="' + esc(name) + '" data-gkey="' + esc(gnode.dataset.gkey) + '">' + (collapsed ? 'Expand group' : 'Collapse group') + '</div>');
      } else if (gnode.dataset.el) {   // üye düğüm: satırı watch ifadesi olarak kopyala (+ talep-üzerine detay)
        popMenu(name, e, '<div class="cm-item cell-watch" data-el="' + esc(gnode.dataset.el) + '">Copy row as watch expression</div>' + detMenu(name, gnode.dataset.el, gnode.dataset.idx, gnode.dataset.midx, gnode.dataset.oidx));
      }
      return;
    }
    const td = e.target.closest('tbody td');
    if (td && !td.querySelector('.bar')) {   // veri hücresi: kopya (+ düzenlenebilirse edit)
      e.preventDefault();
      const txt = (td.textContent || '').trim();
      let h = '<div class="cm-item cell-copy" data-text="' + esc(txt) + '">Copy cell</div>';
      const trEl = td.closest('tr');
      const inDet = !!(trEl && trEl.closest('.detrow'));   // detay alt-tablosu içindeyse master detay öğeleri gösterme (nested olmasın)
      if (trEl && trEl.dataset.ri != null && trEl.dataset.ri !== '')   // bu satırı GRAPH görünümünde göster + o düğüme merkezlen
        h += '<div class="cm-item show-graph" data-section="' + esc(name) + '" data-ri="' + esc(trEl.dataset.ri) + '">Show in graph</div>';
      if (trEl && trEl.dataset.el)   // satırın kararlı eleman ifadesini watch için kopyala (VS Code Watch'a yapıştır)
        h += '<div class="cm-item cell-watch" data-el="' + esc(trEl.dataset.el) + '">Copy row as watch expression</div>';
      if (!inDet && trEl && trEl.dataset.el) h += detMenu(name, trEl.dataset.el, trEl.dataset.idx, trEl.dataset.midx, trEl.dataset.oidx);   // talep-üzerine detay (Show/Hide); data-idx/midx -> \${selected_index}/\${selected_master_index}
      if (td.dataset.lv) {   // bu hücrenin alanına GDB watchpoint'i (değer değişince durdurur)
        if (watchedExprs.has(td.dataset.lv))
          h += '<div class="cm-item cell-unwp" data-lv="' + esc(td.dataset.lv) + '">Remove watchpoint</div>';
        else
          h += '<div class="cm-item cell-wp" data-lv="' + esc(td.dataset.lv) + '">Add watchpoint (break on change)</div>';
      }
      if (td.dataset.edit) {
        const tr = td.closest('tr');
        const ri = (tr && tr.dataset.ri != null) ? tr.dataset.ri : '';
        h += '<div class="cm-item cell-edit" data-edit="' + esc(td.dataset.edit) + '" data-cur="' + esc(td.getAttribute('title') || '') + '" data-section="' + esc(name) + '" data-ri="' + esc(ri) + '" data-col="' + esc(td.dataset.col || '') + '">Edit value…</div>';
      }
      popMenu(name, e, h);
    }
  });

  document.addEventListener('click', () => {
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
  });

  // --- Sections (tabs): istemci-tarafı gizle/sırala (columns modeli) + menü/sekme sürükle ---
  // sectionOrder = TEK interleaved liste (görünür+gizli, gerçek sırada). reveal: gizliyi gösterirken yeniden çek.
  const secMenu = document.getElementById('sections-menu');
  const secBtn = document.getElementById('sections-btn');
  function sendSections(reveal) {
    vscodeApi.postMessage({ type: 'setSections', order: sectionOrder.slice(), hidden: hiddenSections.slice(), reveal: reveal || null });
  }
  function visibleFromOrder() { return sectionOrder.filter(n => hiddenSections.indexOf(n) === -1); }
  // saf yardımcı: order içinde fromName'i toName'in (sürükleme-öncesi) yerine taşı (columns ile aynı semantik)
  function computeReorder(order, fromName, toName) {
    const o = order.slice(); const f = o.indexOf(fromName), t = o.indexOf(toName);
    if (f === -1 || t === -1 || f === t) return o;
    o.splice(f, 1); o.splice(t, 0, fromName); return o;
  }
  function neighborVisible(name) {
    const vis = visibleFromOrder(); if (!vis.length) return null;
    const oi = sectionOrder.indexOf(name);
    let best = vis[0], bestd = Infinity;
    for (const v of vis) { const d = Math.abs(sectionOrder.indexOf(v) - oi); if (d < bestd) { bestd = d; best = v; } }
    return best;
  }
  // skeleton'ı yeni sırada yeniden kur, her bölümü secState ÖNBELLEĞİNDEN yeniden paint et (GDB YOK)
  function setTabCount(name) {
    const st = secState[name]; const cnt = cntElOf(name);
    if (st && st.sec && cnt) cnt.textContent = st.sec.grouped ? (st.sec.groups || []).reduce((a, g) => a + g.rows.length, 0) : st.sec.rows.length;
  }
  // refresh sırasında sekme "güncelleniyor" spinner'ı (verisi gelince temizlenir)
  function setTabUpdating(name, on) { const t = tabElOf(name); if (t) t.classList.toggle('updating', !!on); }
  function clearAllUpdating() { for (const n of currentNames) setTabUpdating(n, false); }
  // "N changed" rozetini SADECE görünür (açık) bölümlerin değişiklik sayısından hesapla
  function recomputeChanged() {
    let total = 0;
    for (const name of currentNames) { const st = secState[name]; if (st) total += (st.changeCount || 0); }
    const chEl = document.getElementById('changes');
    if (!chEl) return;
    if (total > 0) { chEl.textContent = total + ' changed'; chEl.classList.remove('hidden'); }
    else chEl.classList.add('hidden');
  }
  function applySectionLayout() {
    const vis = visibleFromOrder();
    currentNames = [];                 // ensureLayout erken-dönüşünü kır -> her zaman yeniden kur
    ensureLayout(vis);                 // tabs/panes iskeleti + currentNames + applyActive
    // iskelet yeniden kurulduğu için sekme sayaç/haschg sıfırlanır; secState önbelleğinden geri yaz
    for (const name of vis) {
      if (secState[name] && secState[name].sec) {
        paint(name); buildColsMenu(name); setTabCount(name);
        const st = secState[name]; const tab = tabElOf(name);
        if (tab) { if (st.changeCount > 0 && name !== activeName) tab.classList.add('haschg'); else tab.classList.remove('haschg'); }
      } else {
        paintLoading(name);   // yeni gösterilen / verisi henüz gelmemiş bölüm
      }
    }
    recomputeChanged();   // gizlenen bölümün değişiklikleri toplamdan düşsün
  }
  function buildSectionsMenu() {
    let h = '<div class="cols-title">Sections — drag to reorder, toggle visibility</div>';
    // toplu aksiyonlar (Columns menüsüyle ORTAK): tüm sekmeleri aç / kapat (kapatta aktif sekme açık kalır)
    h += '<div class="cols-actions"><div class="cm-item sec-showall">Show all</div><div class="cm-item sec-hideall" title="Keeps the active tab">Hide all</div></div>';
    if (!sectionOrder.length) h += '<div class="cols-item">—</div>';
    sectionOrder.forEach(n => {
      const checked = hiddenSections.indexOf(n) === -1 ? ' checked' : '';
      h += '<div class="cols-item" data-sec="' + esc(n) + '" draggable="true">' +
        '<span class="cols-grip" title="Drag to reorder">⠿</span>' +
        '<label><input type="checkbox" data-act="secvis"' + checked + '> ' + esc(cap(n)) + '</label></div>';
    });
    secMenu.innerHTML = h;
  }
  // Sections menüsünü verilen noktada aç (Sections butonu VE sekme sağ-tıkı aynı menüyü kullanır — Columns'la ortak mantık)
  function openSectionsMenu(x, y) {
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
    buildSectionsMenu();
    secMenu.style.position = 'fixed';
    secMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - 240)) + 'px';
    secMenu.style.top = Math.min(y, window.innerHeight - 40) + 'px';
    secMenu.classList.remove('hidden');
  }
  secBtn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = secMenu.classList.contains('hidden');
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
    if (willOpen) {
      const r = secBtn.getBoundingClientRect();
      openSectionsMenu(r.left, r.bottom + 4);
    }
  });
  secMenu.addEventListener('click', e => {
    e.stopPropagation();
    // TÜMÜNÜ GÖSTER: gizli bölümler görünür olur; verisi olmayanlar (gizliyken çekilmez) reveal DİZİSİYLE yeniden çekilir
    if (e.target.closest('.sec-showall')) {
      const newly = hiddenSections.slice();
      if (!newly.length) return;
      hiddenSections = [];
      buildSectionsMenu(); applySectionLayout();
      sendSections(newly);   // dizi reveal -> extension her birini refreshTarget'lar (aşağıda setSections handler)
      return;
    }
    // TÜMÜNÜ GİZLE: aktif sekme açık kalır (en az 1 görünür invariantı; boş panel/null-aktif durumuna düşmeyiz)
    if (e.target.closest('.sec-hideall')) {
      const vis = visibleFromOrder();
      if (vis.length <= 1) return;   // zaten tek görünür
      const keep = (activeName && vis.indexOf(activeName) !== -1) ? activeName : vis[0];
      hiddenSections = sectionOrder.filter(n => n !== keep);
      activeName = keep;
      buildSectionsMenu(); applySectionLayout(); sendSections(null);
      return;
    }
  });

  // --- Export: tüm görünür bölümlerin verisini JSON olarak dışa aktar ---
  function buildExport() {
    const out = {};
    for (const name of currentNames) {
      const st = secState[name]; if (!st || !st.sec) continue;
      const cols = (st.order || []).filter(l => st.hidden.indexOf(l) === -1);
      const rowObj = r => { const o = {}; for (const c of cols) o[c] = (r[c] !== undefined && r[c] !== '' ? r[c] : null); return o; };
      if (st.sec.grouped) {
        out[name] = (st.sec.groups || []).map(g => ({ group: g.label, rows: (g.rows || []).map(rowObj) }));
      } else {
        out[name] = (st.sec.rows || []).map(rowObj);
      }
    }
    return JSON.stringify(out, null, 2);
  }
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) exportBtn.addEventListener('click', e => {
    e.stopPropagation();
    vscodeApi.postMessage({ type: 'export', json: buildExport() });
  });
  const configBtn = document.getElementById('config-btn');
  if (configBtn) configBtn.addEventListener('click', e => {
    e.stopPropagation();
    vscodeApi.postMessage({ type: 'openConfig' });
  });

  // --- arch seçici: config'te bulunan arch etiketleri ('common' her zaman ilk sırada) ---
  // Etiket listesi extension'dan 'archs' mesajıyla gelir (ready + her yenileme + config değişimi).
  // Config'te hiç arch bloğu yoksa seçici GİZLİ kalır (overlay kullanmayan kullanıcıyı meşgul etmez).
  const archWrap = document.getElementById('arch-wrap');
  const archSel = document.getElementById('arch-sel');
  function renderArchs(archs, active) {
    if (!archWrap || !archSel) return;
    if (!archs.length) { archWrap.classList.add('hidden'); return; }
    const opts = ['common'].concat(archs.filter(a => a !== 'common'));
    const cur = opts.indexOf(active) === -1 ? 'common' : active;
    archSel.innerHTML = opts.map(a =>
      '<option value="' + esc(a) + '"' + (a === cur ? ' selected' : '') + '>' + esc(a) + '</option>').join('');
    archSel.value = cur;
    archWrap.classList.remove('hidden');
  }
  if (archSel) archSel.addEventListener('change', e => {
    e.stopPropagation();
    vscodeApi.postMessage({ type: 'setArch', arch: archSel.value });
  });
  secMenu.addEventListener('change', e => {
    const cb = e.target.closest('input[data-act="secvis"]');
    if (!cb) return;
    const n = cb.closest('.cols-item').dataset.sec;
    if (cb.checked) {
      // GÖSTER: gizli bölümün verisi yok (gizliyken çekilmez) -> önce iskeleti yeniden kur (sekme/pane oluşsun,
      // değilse gelen patchSection'ın yazacağı body-n yok -> sekme geri gelmez), sonra reveal ile tazele.
      hiddenSections = hiddenSections.filter(x => x !== n);
      buildSectionsMenu();
      applySectionLayout();   // currentNames + tabs/panes iskeletini yeniden kur (yeni gösterilen bölüm "Loading…" olur)
      sendSections(n);        // reveal -> refreshTarget(n) -> patchSection o pane'i doldurur
    } else {
      // GİZLE: en az 1 görünür kalmalı; istemci-tarafı (GDB yok)
      if (visibleFromOrder().length <= 1) { cb.checked = true; return; }
      if (hiddenSections.indexOf(n) === -1) hiddenSections.push(n);
      if (activeName === n) activeName = neighborVisible(n);
      buildSectionsMenu();
      applySectionLayout();
      sendSections(null);
    }
  });
  // Sections menüsü satır sürükle-sırala (columns menüsü gibi: grip + drop-row)
  let menuDragSec = null;
  secMenu.addEventListener('dragstart', e => {
    const item = e.target.closest('.cols-item[data-sec]'); if (!item) return;
    menuDragSec = item.dataset.sec;
    item.classList.add('row-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', menuDragSec); }
    setGhost(e, cap(menuDragSec));
  });
  secMenu.addEventListener('dragover', e => {
    if (menuDragSec == null) return;
    const item = e.target.closest('.cols-item[data-sec]'); if (!item) return;
    e.preventDefault(); clearDropMarks(); item.classList.add('drop-row');
  });
  secMenu.addEventListener('drop', e => {
    if (menuDragSec == null) return;
    const item = e.target.closest('.cols-item[data-sec]');
    if (item) {
      e.preventDefault();
      const target = item.dataset.sec;
      if (target !== menuDragSec) {
        sectionOrder = computeReorder(sectionOrder, menuDragSec, target);
        buildSectionsMenu(); applySectionLayout(); sendSections(null);
      }
    }
    menuDragSec = null; clearDropMarks();
  });
  secMenu.addEventListener('dragend', () => {
    menuDragSec = null; clearGhost(); clearDropMarks();
    for (const x of secMenu.querySelectorAll('.row-dragging')) x.classList.remove('row-dragging');
  });
  // sekme sürükle-sırala (sectionOrder üzerinde, istemci-tarafı)
  let tabDrag = null;
  tabsEl.addEventListener('dragstart', e => {
    const t = e.target.closest('.tab[data-idx]'); if (!t) return;
    tabDrag = currentNames[+t.dataset.idx];
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tabDrag); }
    setGhost(e, cap(tabDrag));
  });
  tabsEl.addEventListener('dragover', e => {
    if (tabDrag == null) return;
    const t = e.target.closest('.tab[data-idx]'); if (!t) return;
    e.preventDefault();
    for (const x of tabsEl.querySelectorAll('.tab')) x.classList.remove('drop-target');
    t.classList.add('drop-target');
  });
  tabsEl.addEventListener('drop', e => {
    if (tabDrag == null) return;
    const t = e.target.closest('.tab[data-idx]'); if (!t) { tabDrag = null; return; }
    e.preventDefault();
    const target = currentNames[+t.dataset.idx];
    if (target && target !== tabDrag) {
      sectionOrder = computeReorder(sectionOrder, tabDrag, target);
      applySectionLayout(); sendSections(null);
    }
    tabDrag = null;
    for (const x of tabsEl.querySelectorAll('.tab')) x.classList.remove('drop-target');
  });
  tabsEl.addEventListener('dragend', () => {
    tabDrag = null; clearGhost();
    for (const x of tabsEl.querySelectorAll('.tab')) x.classList.remove('drop-target');
  });
  // sekmeye SAĞ-TIK -> Sections menüsü imlecin yanında (kolon BAŞLIĞI sağ-tıkının birebir karşılığı: ortak etkileşim)
  tabsEl.addEventListener('contextmenu', e => {
    const t = e.target.closest('.tab[data-idx]'); if (!t) return;
    e.preventDefault(); e.stopPropagation();
    openSectionsMenu(e.clientX, e.clientY);
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'update') {
      if (!paused) { statusEl.textContent = 'stopped'; statusEl.className = 'pill'; }
      tsEl.textContent = m.ts ? ('updated ' + m.ts) : '';
      const list = Array.isArray(m.sections) ? m.sections : [];
      hiddenSections = Array.isArray(m.hiddenSections) ? m.hiddenSections : [];
      sectionOrder = Array.isArray(m.order) ? m.order.slice() : list.map(s => s.name).concat(hiddenSections);
      ensureLayout(list.map(s => s.name));
      for (const k of Object.keys(secState))
        if (list.findIndex(s => s.name === k) === -1) delete secState[k];
      let changed = 0;
      for (const s of list) changed += (renderSection(s.name, s) || 0);   // 1) tüm secState dolsun
      for (const s of list) { paint(s.name); buildColsMenu(s.name); }       // 2) sonra çiz (link eşleşme kontrolü için)
      const chEl = document.getElementById('changes');
      if (changed > 0) { chEl.textContent = changed + ' changed'; chEl.classList.remove('hidden'); }
      else chEl.classList.add('hidden');
    } else if (m.type === 'archs') {
      renderArchs(Array.isArray(m.archs) ? m.archs : [], typeof m.active === 'string' ? m.active : 'common');
    } else if (m.type === 'watchpoints') {
      watchedExprs = new Set(Array.isArray(m.exprs) ? m.exprs : []);   // izlenen l-value'lar -> ★ + menü Add/Remove
      for (const n of currentNames) if (secState[n] && secState[n].sec) paint(n);
    } else if (m.type === 'running') {
      if (!paused) { statusEl.textContent = 'running…'; statusEl.className = 'pill run'; }
      setRefreshing(false); clearAllUpdating(); if (refreshFallback) { clearTimeout(refreshFallback); refreshFallback = null; }   // iptal edilen refresh'in spinner'larını da temizle
    } else if (m.type === 'beginUpdate') {
      // durak başı iskelet: ts + layout + kaldırılanları temizle. Bölümler 'patchSection' ile ÖNCELİKLİ akar.
      setRefreshing(true); if (refreshFallback) { clearTimeout(refreshFallback); refreshFallback = null; }   // yenileme başladı -> düğme döner
      if (!paused) { statusEl.textContent = 'stopped'; statusEl.className = 'pill'; }
      tsEl.textContent = m.ts ? ('updated ' + m.ts) : '';
      const vis = Array.isArray(m.visible) ? m.visible : [];
      hiddenSections = Array.isArray(m.hiddenSections) ? m.hiddenSections : [];
      sectionOrder = Array.isArray(m.order) ? m.order.slice() : vis.concat(hiddenSections);
      detailDefs = (m.details && typeof m.details === 'object') ? m.details : {};   // master -> [detay bölüm adı] (sağ-tık menüsü)
      ensureLayout(vis);
      for (const k of Object.keys(secState)) if (vis.indexOf(k) === -1) delete secState[k];
      // henüz çekilmemiş (verisi olmayan) görünür bölümler "Loading…" göstersin (streaming kuyruğunda bekleyenler)
      for (const n of vis) if (!hasData(n)) paintLoading(n);
      // her görünür sekme "güncelleniyor" işaretlensin (verisi gelene kadar spinner); eski veri görünür kalır
      for (const n of vis) setTabUpdating(n, true);
    } else if (m.type === 'endUpdate') {
      // akış bitti: aktif sekmeyi son kez boya (çapraz-link hedefleri artık yüklü) + rozet
      if (activeName && secState[activeName] && secState[activeName].sec) { paint(activeName); buildColsMenu(activeName); }
      recomputeChanged();
      clearAllUpdating();   // tüm sekme spinner'larını temizle
      setRefreshing(false); if (refreshFallback) { clearTimeout(refreshFallback); refreshFallback = null; }   // yenileme bitti
      if (m.ts) tsEl.textContent = 'updated ' + m.ts;
    } else if (m.type === 'streamSection') {
      // AKIŞ: bir bölümün satırları/grupları gelirken kısmi tabloyu canlı çiz (yükleme sürerken).
      // secState'e YAZMAZ -> değişiklik-vurgusu tabanı (önceki durak) bozulmaz; son 'patchSection' yetkili çizimdir.
      if (m.sec) paintStream(m.section, m.sec);   // spinner AÇIK kalır (patchSection kapatacak)
    } else if (m.type === 'patchSection') {
      // tek bölüm: durak akışındaki bir bölüm VEYA hedefli reveal -> bu sekme dolar/çizilir
      if (m.sec) { renderSection(m.section, m.sec); paint(m.section); buildColsMenu(m.section); recomputeChanged(); }
      setTabUpdating(m.section, false);   // bu sekme güncellendi -> spinner dursun
      if (m.ts) tsEl.textContent = 'updated ' + m.ts;
    } else if (m.type === 'patchDetail') {
      // talep-üzerine detay verisi geldi: ilgili açık girişe yaz + yerleştir (tablo accordion / graph paneli)
      const od = findDet(m.master, m.sel, m.section);
      if (od) { od.sec = m.sec; placeDetail(od); }
      if (m.ts) tsEl.textContent = 'updated ' + m.ts;
    } else if (m.type === 'presentationUpdate') {
      // config'te yalnız sunum değişti (base/bar eşiği/link/badge) -> GDB'siz: mevcut satırları koru, yeniden çiz
      const st = secState[m.section];
      if (st && st.sec) {
        if (m.bars) st.sec.bars = m.bars;
        if (m.links) st.sec.links = m.links;
        if (m.badges) st.sec.badges = m.badges;
        if (m.valueMap) st.sec.valueMap = m.valueMap;
        if (m.flags) st.sec.flags = m.flags;
        if (m.srcCols) st.sec.srcCols = m.srcCols;
        st.sec.timeline = m.timeline;   // ⏱ timeline ayarı sunum meta'sıdır (kaldırıldıysa undefined -> default'lar)
        if (m.bases) { st.sec.bases = m.bases; st.colBase = st.colBase || {}; for (const k in m.bases) st.colBase[k] = m.bases[k]; }
        paint(m.section); buildColsMenu(m.section);
      }
    } else if (m.type === 'patchRow') {
      // edit value: yeni alan(lar)ı o satıra yaz, bölümü (istemci-tarafı) yeniden boya. grouped'da flat index ile düzleştir.
      const st = secState[m.section];
      if (st && st.sec && m.row && typeof m.rowIndex === 'number') {
        const tr = st.sec.grouped ? (st.sec.groups || []).reduce((a, g) => a.concat(g.rows || []), []) : (st.sec.rows || []);
        if (tr[m.rowIndex]) { Object.assign(tr[m.rowIndex], m.row); paint(m.section); }
      }
    } else if (m.type === 'patchColumn') {
      // tek kolon hedefli güncelleme (column show): yeni field'ı mevcut satırlara merge et
      const st = secState[m.section];
      if (st && st.sec) {
        const tr = st.sec.grouped ? (st.sec.groups || []).reduce((a, g) => a.concat(g.rows || []), []) : (st.sec.rows || []);
        const pr = Array.isArray(m.rows) ? m.rows : [];
        if (tr.length !== pr.length) {
          vscodeApi.postMessage({ type: 'refresh' });   // hizalama bozuk -> güvenli tam yenile
        } else {
          for (let k = 0; k < tr.length; k++) {
            const src = pr[k]; if (!src) continue;
            tr[k][m.label] = src[m.label];
            if (src['__bar__' + m.label] !== undefined) tr[k]['__bar__' + m.label] = src['__bar__' + m.label];
            if (src['__edit__' + m.label] !== undefined) tr[k]['__edit__' + m.label] = src['__edit__' + m.label];
            if (src['__src__' + m.label] !== undefined) tr[k]['__src__' + m.label] = src['__src__' + m.label];
          }
          paint(m.section); buildColsMenu(m.section);
          if (m.ts) tsEl.textContent = 'updated ' + m.ts;
        }
      }
    }
  });
  // Panel başka bir editor grubuna / yeni pencereye TAŞININCA webview yeniden yüklenir ve tüm
  // istemci-tarafı durum (secState, çizilen tablolar) sıfırlanır. Mesaj dinleyici kurulduktan SONRA
  // "hazırım" de -> uzantı, durmuşsa veriyi yeniden gönderir, böylece taşımada veriler kaybolmaz.
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
