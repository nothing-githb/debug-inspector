/*
 * threads_demo.c  —  Debug Inspector test program
 * Standart kutuphane KULLANMAZ: include satiri yok, printf/malloc vb. yok.
 * Tum veriler statik global'lerde; pthread degil, kendi TCB/semaphore
 * yapilarimiz var. Listeye karmasik bir root uzerinden erisilir:
 *   g_kernel.pools[0]->thread_list
 */

#define NULL ((void *)0)

/* ---------------- Thread ---------------- */
typedef enum { RUNNING, READY, BLOCKED, WAITING } thread_state_t;

typedef struct tcb {
    int             id;
    const char     *name;
    thread_state_t  state;
    int             prio;
    void           *stack_base;   /* stack start */
    unsigned long   stack_size;   /* toplam (bytes) */
    unsigned long   stack_used;   /* kullanilan (bytes) -> usage bar */
    unsigned long   cs_fp;        /* sentetik x86-64 frame-pointer (callstack 'walk' detayi icin) -> ${selected}->cs_fp */
    struct tcb     *next;
} tcb_t;

/* ---------------- Semaphore ---------------- */
typedef enum { FIFO, PRIORITY } sem_discipline_t;

typedef struct ksem {
    int               id;
    int               count;
    int               max_count;
    int               waiting;
    sem_discipline_t  discipline;
    struct ksem      *next;
} ksem_t;

/* ---------------- Mutex ---------------- */
typedef struct kmutex {
    int             id;
    const char     *name;
    int             owner;     /* owning thread id, 0 = free */
    int             locked;    /* 0 / 1 */
    int             waiters;
    unsigned        flags;     /* bit bayraklar: 0x1 BUSY, 0x2 OWNED, 0x4 ROBUST, 0x8 RECURSIVE, 0x10 (eslenmeyen) */
    struct kmutex  *next;
} kmutex_t;

/* ---------------- Dynamic array (void* buffer + size -> 'cast' gerekir) ---------------- */
typedef struct {
    int          x;
    int          y;
    const char  *label;
} widget_t;

typedef struct {
    void *data;   /* generic buffer; aslinda widget_t[] tutar */
    int   size;   /* eleman sayisi */
} dyn_array_t;

/* ---------------- Index-linked list (dizi + index 'next'; bazi gozler bos) ---------------- */
typedef struct {
    int          id;
    const char  *name;
    char         tag[8];  /* sabit boyutlu char dizisi: GDB sondaki \000'lari da basar */
    int          next;   /* sonraki elemanin index'i; -1 = son */
} slot_t;

/* ---------------- Box: her goz bir sarmalayici; asil veri 'data' field'inda (cast oncesi field hop) ---------------- */
typedef struct {
    void *data;   /* asil veri (widget_t*); cast'ten ONCE bu field ile erisilir */
    int   kind;
} box_t;

/* ---------------- Panel: IKI SEVIYELI dizi (nested_array (2 level) modu) — dis dizi g_panels[], her panelin IC dizisi widgets[used] ---------------- */
typedef struct {
    const char *name;        /* grup basligi (nested_array (2 level) 'label') */
    int         used;        /* ic dizide dolu eleman sayisi (nested_array (2 level) 'innerCount') */
    widget_t    widgets[4];  /* ic dizi (nested_array (2 level) 'inner') */
} panel_t;

/* ---------------- UC SEVIYELI dizi (nested_array (3 level) modu) — kullanici yapisi:
   struct_my* array[core_count];  array[i] TEK struct'a degil, struct_my DIZISINE isaret eder (array[i][j]);
   her struct_my icinde ikinci bir dizi pointer'i vardir (struct_my2* array2): array[i][j].array2[k]. ---------------- */
typedef struct { int id; int val; int start; int dur; } item_t;     /* struct_my2 (+start/dur: konumlu timeline demosu) */
typedef struct { const char *name; int nitems; item_t *items; } job_t;   /* struct_my (items = ic dizi pointer'i) */

/* ---------------- GERCEK timeline ornegi: cekirdek basina ZAMANLAMA PENCERELERI (ARINC-653 benzeri) ----------------
   3 seviye: core -> major frame -> partition penceresi. Her pencere start_ms/dur_ms tasir; pencereler
   arasi IDLE BOSLUKLAR vardir; major frame TOPLAM suresi 100 ms (config'te timeline.total = 100). */
/* timeline.set demosu: her partition penceresinin ALT device kumesi (id kumesi). Timeline gorunumunde
   her blok (pencere) icinde bu device'lar chip olarak gosterilir (set.array=devs, count=ndev, label=name). */
/* 'off' = cihaz cevrimdisi/pasif -> timeline.set dashWhen:"off" ile o chip'in kenari KESIKLI cizilir (kosul demosu) */
typedef struct { const char *name; int off; } sched_dev_t;
/* timeline.set DIZI (birden cok kume) demosu: her pencere hem 'devs' (device) hem 'sigs' (signal) kumesi tasir */
typedef struct { const char *part; int start_ms; int dur_ms; int ndev; sched_dev_t *devs; int nsig; sched_dev_t *sigs; } sched_win_t;
typedef struct { int frame_no; int nwins; sched_win_t *wins; } sched_frame_t;
typedef struct { const char *name; int nframes; sched_frame_t *frames; } sched_core_t;

/* ---------------- COKLU TIMELINE ornegi: FARKLI UZUNLUKTA timeline'lar (her biri kendi grafik+eksen).
   3 seviye: timeline -> core -> pencere. Uzunluk (total_ms) TIMELINE'da: "boot" 100 ms, "cruise" 250 ms.
   Kural: bir timeline'in uzunlugu her core'da AYNI (total_ms timeline seviyesinde). Pencereler arasi bosluklar var. */
typedef struct { const char *part; int start; int dur; } tlwin_t;
typedef struct { const char *core; int nwins; tlwin_t *wins; } tlcore_t;
typedef struct { const char *name; int total_ms; int ncores; tlcore_t *cores; } timeline_t;

/* ---------------- Process (master: alt listeleri tutar) ---------------- */
typedef struct process {
    int              pid;
    const char      *name;
    tcb_t           *thread_list;   /* bu process'in thread'leri */
    ksem_t          *sem_list;      /* bu process'in semaphore'lari */
    kmutex_t        *mutex_list;    /* bu process'in mutex'leri */
    int              slot_head;     /* bu process'in g_slot_pool icindeki index-zinciri basi */
    struct process  *next;
} process_t;

/* ---------------- Timer (array-mode ornegi: g_timers[count]) ---------------- */
typedef struct {
    int          id;
    const char  *name;
    int          period;
    int          elapsed;
    int          active;
} ktimer_t;

/* ---------------- Kernel / pool (karmasik root icin) ---------------- */
typedef struct kpool {
    tcb_t    *thread_list;
    ksem_t   *sem_list;
    kmutex_t *mutex_list;
} kpool_t;

typedef struct {
    kpool_t *pools[2];
} kernel_t;

/* binary search tree (tree mode demo): kok + left/right cocuk pointer'lari */
typedef struct bnode {
    int key;
    char label[8];
    struct bnode *left, *right;
} bnode_t;

/* ---- global'ler (YÜZLERCE satır: ana tablolar döngülerle üretilir) ---- */
#define N_PROC      8                  /* master process sayisi */
#define TPP         6                  /* thread / process -> 48 thread */
#define SPP         6                  /* sem / process    -> 48 sem */
#define SLOT_BLK    6                  /* slot / process   -> 48 slot */
#define MAX_THREADS (N_PROC * TPP)
#define MAX_SEMS    (N_PROC * SPP)
#define MAX_MUTEXES 50
#define MAX_TIMERS  50
#define MAX_WIDGETS 50
#define MAX_PROCS   N_PROC
#define MAX_SLOTS   (N_PROC * SLOT_BLK)

tcb_t    g_threads[MAX_THREADS];
int      g_thread_count = 0;
ksem_t   g_sems[MAX_SEMS];
int      g_sem_count = 0;
kmutex_t g_mutexes[MAX_MUTEXES];
int      g_mutex_count = 0;
ktimer_t g_timers[MAX_TIMERS];
int      g_timer_count = 0;
process_t g_procs[MAX_PROCS];
int       g_proc_count = 0;
process_t *g_process_list;                /* master listenin başı */
widget_t    g_widget_pool[MAX_WIDGETS];   /* arka depo (cast dizisi) */
dyn_array_t g_widgets;                    /* data = void*, widget_t[] gösterir */
void       *g_slots[3];                   /* void* pointer dizisi -> her biri widget_t* (wrap örneği) */
box_t       g_boxes[3];                    /* her goz {void *data; int kind}; data widget_t* (cast oncesi field hop) */
panel_t     g_panels[3];                   /* IKI SEVIYELI dizi (nested_array (2 level)): dis eleman = panel, ic dizi = widgets[used] */
int         g_panel_count = 3;
/* UC SEVIYELI dizi (nested_array (3 level)): g_core_jobs[i] -> job dizisi (array[i][j]) -> her job'un items[k] dizisi */
#define N_CORES 3
#define JOBS_PER_CORE 2
job_t       g_job_pool[N_CORES * JOBS_PER_CORE];       /* g_core_jobs[i]'nin gosterdigi bloklar */
item_t      g_item_pool[N_CORES * JOBS_PER_CORE * 4];  /* items'larin gosterdigi havuz (job basina 4'luk blok) */
job_t      *g_core_jobs[N_CORES];                      /* struct_my* array[core_count] karsiligi */
int         g_core_count = N_CORES;
int         g_jobs_per_core = JOBS_PER_CORE;           /* orta seviye sayac GLOBAL -> config'te "::g_jobs_per_core" */
/* timeline.set demosu: her partition'in alt device (id) kumeleri — pencereler bunlara isaret eder */
/* bazi cihazlar 'off' (cevrimdisi) -> dashWhen:"off" o chip'i kesikli kenarla cizer */
static sched_dev_t g_dev_fms[]  = { {"adc0", 0}, {"adc1", 1} };            /* adc1 cevrimdisi */
static sched_dev_t g_dev_nav[]  = { {"gps", 0}, {"imu", 1}, {"mag", 0} }; /* imu cevrimdisi */
static sched_dev_t g_dev_io[]   = { {"uart", 0}, {"spi", 0} };
static sched_dev_t g_dev_disp[] = { {"lcd", 0} };
static sched_dev_t g_dev_comm[] = { {"eth0", 0}, {"can0", 1} };           /* can0 cevrimdisi */
/* IKINCI kume: her pencerenin 'signal' seti (timeline.set DIZI demosu) */
static sched_dev_t g_sig_fms[]  = { {"clk", 0} };
static sched_dev_t g_sig_nav[]  = { {"sync", 0}, {"irq", 0} };
static sched_dev_t g_sig_comm[] = { {"tx", 0}, {"rx", 1} };               /* rx cevrimdisi */
/* zamanlama tablosu: statik init (kod gerekmez). Pencereler KASITLI bosluklu — timeline'da idle araliklar gorunur.
   Her pencere ndev/devs (device kumesi) + nsig/sigs (signal kumesi) tasir (timeline.set DIZI -> iki chip satiri).
   sigs verilmeyen pencerelerde trailing alanlar 0/NULL (C zero-init) -> o pencerede signal satiri bos/gizli. */
static sched_win_t g_wins_c0f0[] = { {"FMS", 0, 25, 2, g_dev_fms, 1, g_sig_fms}, {"NAV", 40, 20, 3, g_dev_nav, 2, g_sig_nav}, {"IO", 75, 15, 2, g_dev_io} };   /* 25-40 ve 60-75 idle */
static sched_win_t g_wins_c0f1[] = { {"NAV", 10, 30, 3, g_dev_nav, 2, g_sig_nav}, {"FMS", 55, 25, 2, g_dev_fms, 1, g_sig_fms} };                   /* 0-10, 40-55, 80-100 idle */
static sched_win_t g_wins_c1f0[] = { {"DISP", 5, 20, 1, g_dev_disp}, {"COMM", 50, 35, 2, g_dev_comm, 2, g_sig_comm} };                  /* 0-5, 25-50, 85-100 idle */
static sched_win_t g_wins_c1f1[] = { {"COMM", 0, 45, 2, g_dev_comm, 2, g_sig_comm}, {"DISP", 70, 20, 1, g_dev_disp} };                  /* 45-70, 90-100 idle */
static sched_frame_t g_frames_c0[] = { {0, 3, g_wins_c0f0}, {1, 2, g_wins_c0f1} };
static sched_frame_t g_frames_c1[] = { {0, 2, g_wins_c1f0}, {1, 2, g_wins_c1f1} };
sched_core_t g_sched[2] = { {"cpu0", 2, g_frames_c0}, {"cpu1", 2, g_frames_c1} };
int          g_sched_cores = 2;
/* --- coklu timeline verisi: 2 timeline x 2 core; boot 100ms, cruise 250ms (farkli uzunluk) --- */
static tlwin_t g_boot_cpu0[]   = { {"FMS",0,25}, {"NAV",40,20}, {"IO",75,15} };      /* 25-40, 60-75, 90-100 idle */
static tlwin_t g_boot_cpu1[]   = { {"DISP",5,20}, {"COMM",50,35} };                  /* boot: total 100 */
static tlwin_t g_cruise_cpu0[] = { {"FMS",0,40}, {"NAV",75,60}, {"IO",175,55} };     /* cruise: total 250 */
static tlwin_t g_cruise_cpu1[] = { {"DISP",20,75}, {"COMM",140,90} };
static tlcore_t g_boot_cores[]   = { {"cpu0",3,g_boot_cpu0}, {"cpu1",2,g_boot_cpu1} };
static tlcore_t g_cruise_cores[] = { {"cpu0",3,g_cruise_cpu0}, {"cpu1",2,g_cruise_cpu1} };
timeline_t g_timelines[2] = { {"boot",100,2,g_boot_cores}, {"cruise",250,2,g_cruise_cores} };
int        g_timeline_count = 2;
slot_t      g_slot_pool[MAX_SLOTS];        /* index ile bagli; process basina bir blok */
int         g_slot_head;                   /* global zincirin ilk index'i */
kpool_t  g_pool0;
kernel_t g_kernel;
bnode_t  g_bnodes[16];
int      g_bnode_count = 0;
bnode_t *g_tree_root;                      /* binary search tree (tree mode demo) */

/* libc yok -> isimler literal havuzundan döngüsel seçilir */
static const char *NAMES[]  = { "main","worker","logger","net","disk","audio","video","sensor","timer","gc","ui","ipc" };
#define NN  ((int)(sizeof(NAMES)/sizeof(NAMES[0])))
static const char *PNAMES[] = { "init","worker","netd","diskd","audiod","videod","sensord","gcd","uid","ipcd","logd","kbd" };
#define NPN ((int)(sizeof(PNAMES)/sizeof(PNAMES[0])))

static tcb_t *mk_thread(int id, const char *name, thread_state_t st, int prio)
{
    tcb_t *t = &g_threads[g_thread_count++];
    t->id = id; t->name = name; t->state = st; t->prio = prio;
    t->stack_base = (void *)(unsigned long long)(0x7000000ULL + (unsigned long long)id * 0x10000ULL);
    t->stack_size = 0x4000UL; /* 16 KB */
    t->cs_fp = 0UL;            /* varsayilan: callstack yok (init'te bazi thread'lere zincir atanir) */
    t->next = NULL;
    return t;
}

static ksem_t *mk_sem(int id, int count, int max, int waiting, sem_discipline_t d)
{
    ksem_t *s = &g_sems[g_sem_count++];
    s->id = id; s->count = count; s->max_count = max;
    s->waiting = waiting; s->discipline = d; s->next = NULL;
    return s;
}

static kmutex_t *mk_mutex(int id, const char *name, int owner, int locked, int waiters)
{
    kmutex_t *m = &g_mutexes[g_mutex_count++];
    m->id = id; m->name = name; m->owner = owner;
    m->locked = locked; m->waiters = waiters; m->next = NULL;
    /* bayrak biti karisimi: BUSY(0x1)=locked, OWNED(0x2)=owner!=0, ROBUST(0x4)=id%3==0,
       RECURSIVE(0x8)=id&1, 0x10=id%5==0 (config'te eslenmez -> +0x10 kalan olarak gosterilir) */
    m->flags = (locked ? 0x1u : 0u) | (owner ? 0x2u : 0u) | ((id % 3 == 0) ? 0x4u : 0u)
             | ((id & 1) ? 0x8u : 0u) | ((id % 5 == 0) ? 0x10u : 0u);
    return m;
}

static void mk_timer(int id, const char *name, int period, int elapsed, int active)
{
    ktimer_t *t = &g_timers[g_timer_count++];
    t->id = id; t->name = name; t->period = period; t->elapsed = elapsed; t->active = active;
}

static void set_tag(char *dst, const char *src)  /* mini strcpy (max 7 char) */
{
    int i = 0;
    while (src[i] && i < 7) { dst[i] = src[i]; i++; }
    dst[i] = 0;
}

static process_t *mk_proc(int pid, const char *name, tcb_t *threads, ksem_t *sems, kmutex_t *mutexes)
{
    process_t *p = &g_procs[g_proc_count++];
    p->pid = pid; p->name = name;
    p->thread_list = threads; p->sem_list = sems; p->mutex_list = mutexes;
    p->next = NULL;
    return p;
}

static bnode_t *bst_insert(bnode_t *root, int key, const char *label)
{
    if (!root) {
        bnode_t *n = &g_bnodes[g_bnode_count++];
        n->key = key; set_tag(n->label, label); n->left = NULL; n->right = NULL;
        return n;
    }
    if (key < root->key) root->left  = bst_insert(root->left,  key, label);
    else                 root->right = bst_insert(root->right, key, label);
    return root;
}

/* ---- sentetik x86-64 frame-pointer zinciri ('walk' modu / callstack demosu) ----
   x86-64 cercevesi: [RBP] = bir onceki RBP, [RBP+8] = donus adresi.
   Geri-sarma: fp = thread.fp; her adimda pc = *(fp+8), fp = *fp; fp stack sinirinda kaldikca surer. */
typedef struct { unsigned long stack_base, stack_top, fp; } fake_cs_thread_t;
/* Cerceve gorunumu: fp adresine bindirilir -> prev (offset 0) = onceki fp, pc (offset 8) = donus adresi.
   'walk' modunda cast: "frame_t *" ile kursoru tiplemek + ${wrapped_expr}->pc / ->prev kullanmak icin. */
typedef struct { unsigned long prev, pc; } frame_t;
static unsigned long g_cs_stack[64];
fake_cs_thread_t g_cs_thread;
frame_t *g_cs_frame;   /* tipli cerceve gorunumu: frame_t'in DWARF'a girmesini garanti eder ('cast' demosu icin) */

/* Breakpoint'i buraya koy. printf yerine gozlemlenebilir bir yan etki. */
static volatile unsigned g_sink;
static void inspect_point(int tick)
{
    g_sink = (unsigned)(tick + g_thread_count + g_sem_count + g_mutex_count + g_timer_count);
}

/* 0x4000=16384 stack'in kullanim yuzdesi (usage bar: yesil/yesil/sari/kirmizi) */
static const unsigned long STACK_USED[4] = { 0x1000, 0x2a00, 0x3300, 0x3d00 }; /* 25/65/80/95% */

/* BUYUK struct: "tum elemani cek + alanlari parse et" (blob) yontemini, sadece birkac kucuk alan gosterilen
   GENIS bir struct'ta olcmek icin. data[] her elemanda FARKLI degerlerle dolu -> GDB <repeats> ile
   sikistiramaz, yani 'print *elem' GERCEKTEN buyuk bir blob doner (hedefli okumayla karsilastirma). */
typedef struct { int id; char name[16]; unsigned int data[1024]; } big_t;
big_t g_bigs[8];
int g_big_count = 8;

int main(void)
{
    /* ---- process'ler + her birinin thread/sem alt listeleri (gruplu ağaç) ---- */
    process_t *prevp = NULL;
    for (int p = 0; p < N_PROC; p++) {
        tcb_t *thead = NULL, *tprev = NULL;
        for (int i = 0; i < TPP; i++) {
            int gid = p * TPP + i;
            tcb_t *t = mk_thread(gid + 1, NAMES[gid % NN], (thread_state_t)(gid % 4), gid % 10);
            t->stack_used = STACK_USED[gid % 4];
            if (!thead) thead = t;
            if (tprev) tprev->next = t;
            tprev = t;
        }
        ksem_t *shead = NULL, *sprev = NULL;
        for (int i = 0; i < SPP; i++) {
            int gid = p * SPP + i;
            ksem_t *s = mk_sem(gid + 1, gid % 5, 5, gid % 3, (sem_discipline_t)(gid % 2));
            if (!shead) shead = s;
            if (sprev) sprev->next = s;
            sprev = s;
        }
        process_t *proc = mk_proc(p + 1, PNAMES[p % NPN], thead, shead, NULL);
        proc->slot_head = p * SLOT_BLK;            /* her process'in slot bloğu */
        if (prevp) prevp->next = proc; else g_process_list = proc;
        prevp = proc;
    }

    /* ---- düz mutex tablosu (yüzlerce); kimi kilitli + owner geçerli bir thread id (link örneği) ---- */
    for (int i = 0; i < MAX_MUTEXES; i++) {
        int locked = (i % 3 == 0);
        int owner  = locked ? ((i % MAX_THREADS) + 1) : 0;   /* threads'e link için geçerli id */
        mk_mutex(i + 1, NAMES[i % NN], owner, locked, locked ? (i % 4) : 0);
    }

    /* ---- timer dizisi (yüzlerce) ---- */
    for (int i = 0; i < MAX_TIMERS; i++)
        mk_timer(i + 1, NAMES[i % NN], (i + 1) * 10, i % 7, i % 2);

    /* ---- widget havuzu (yüzlerce, cast dizisi); ilk 3 anlamlı (slots/boxes wrap örnekleri) ---- */
    for (int i = 0; i < MAX_WIDGETS; i++) {
        g_widget_pool[i].x = 10 + i;
        g_widget_pool[i].y = 20 + i * 2;
        g_widget_pool[i].label = NAMES[i % NN];
    }
    g_widget_pool[0].label = "button";
    g_widget_pool[1].label = "slider";
    g_widget_pool[2].label = "label";
    g_widgets.data = g_widget_pool;
    g_widgets.size = MAX_WIDGETS;
    g_slots[0] = &g_widget_pool[0];
    g_slots[1] = &g_widget_pool[1];
    g_slots[2] = &g_widget_pool[2];
    g_boxes[0].data = &g_widget_pool[0]; g_boxes[0].kind = 1;
    g_boxes[1].data = &g_widget_pool[1]; g_boxes[1].kind = 1;
    g_boxes[2].data = &g_widget_pool[2]; g_boxes[2].kind = 2;

    /* ---- iki seviyeli dizi (nested_array (2 level) demosu): 3 panel, her birinde used=2/3/4 widget ----
       deger deseni deterministik: x = 100*(p+1)+w, y = 10*(p+1)+w -> gate testi bunlari dogrular */
    for (int p = 0; p < g_panel_count; p++) {
        g_panels[p].name = PNAMES[p % NPN];
        g_panels[p].used = p + 2;                       /* panel0=2, panel1=3, panel2=4 widget */
        for (int w = 0; w < g_panels[p].used; w++) {
            g_panels[p].widgets[w].x = 100 * (p + 1) + w;
            g_panels[p].widgets[w].y = 10 * (p + 1) + w;
            g_panels[p].widgets[w].label = NAMES[(p * 4 + w) % NN];
        }
    }

    /* ---- uc seviyeli dizi (nested_array (3 level) demosu): core -> job -> item. deger deseni deterministik:
       id = 100*c + 10*j + k, val = 1000 + id -> gate testi bunlari dogrular */
    for (int c = 0; c < N_CORES; c++) {
        g_core_jobs[c] = &g_job_pool[c * JOBS_PER_CORE];
        for (int j = 0; j < JOBS_PER_CORE; j++) {
            job_t *job = &g_job_pool[c * JOBS_PER_CORE + j];
            job->name   = NAMES[(c * JOBS_PER_CORE + j) % NN];
            job->nitems = 2 + ((c + j) % 3);                          /* 2..4 item */
            job->items  = &g_item_pool[(c * JOBS_PER_CORE + j) * 4];  /* job basina 4'luk blok */
            for (int k = 0; k < job->nitems; k++) {
                job->items[k].id    = 100 * c + 10 * j + k;
                job->items[k].val   = 1000 + 100 * c + 10 * j + k;
                /* konumlu timeline: baslangiclar ARALIKLI (bosluklar gorunsun), sure artan */
                job->items[k].start = 40 * k + 15 * j + 5 * c;
                job->items[k].dur   = 8 + 4 * k;
            }
        }
    }

    /* ---- index-linked havuz: process başına bir blok, her blok kendi içinde zincir (-1 ile biter) ---- */
    for (int p = 0; p < N_PROC; p++) {
        for (int i = 0; i < SLOT_BLK; i++) {
            int idx = p * SLOT_BLK + i;
            g_slot_pool[idx].id   = 100 + idx;
            g_slot_pool[idx].name = NAMES[idx % NN];
            set_tag(g_slot_pool[idx].tag, NAMES[idx % NN]);
            g_slot_pool[idx].next = (i == SLOT_BLK - 1) ? -1 : (idx + 1);
        }
    }
    g_slot_head = 0;   /* global 'pool' sekmesi blok 0'ı gösterir; procSlots her bloğu */

    /* eski pool kökü de geçerli kalsın */
    g_pool0.thread_list = g_process_list->thread_list;
    g_pool0.sem_list    = g_process_list->sem_list;
    g_pool0.mutex_list  = &g_mutexes[0];
    g_kernel.pools[0]   = &g_pool0;
    g_kernel.pools[1]   = NULL;

    /* binary search tree (tree mode demo) */
    {
        int bk[7] = { 50, 30, 70, 20, 40, 60, 80 };
        const char *bl[7] = { "root", "l", "r", "ll", "lr", "rl", "rr" };
        g_tree_root = NULL;
        for (int i = 0; i < 7; i++) g_tree_root = bst_insert(g_tree_root, bk[i], bl[i]);
    }

    /* sentetik callstack'ler: g_cs_stack icinde BIRDEN COK bagimsiz FP zinciri (x86-64: [fp]=onceki fp, [fp+8]=donus adresi).
       Her thread'e farkli bir baslangic fp atanir -> bir thread'i sag-tiklayip "Show callstack" dedigimizde O thread'in zinciri unwind edilir.
       Geri-sarma sinirlari TUM zincirler icin ortak (hepsi g_cs_stack icinde): g_cs_thread.stack_base/stack_top. */
    {
        unsigned long *s = g_cs_stack;
        /* Donus adresleri (PC'ler) GERCEK fonksiyon adresleridir -> 'symbol' alani / 'print/a' ile
           hangi fonksiyona denk geldikleri cozulur (mk_thread, mk_sem, ...). */
        /* zincir A (4 cerceve): s[4]->s[8]->s[12]->s[16]->0 */
        s[4]  = (unsigned long)&s[8];   s[5]  = (unsigned long)&mk_thread;
        s[8]  = (unsigned long)&s[12];  s[9]  = (unsigned long)&mk_sem;
        s[12] = (unsigned long)&s[16];  s[13] = (unsigned long)&bst_insert;
        s[16] = 0UL;                    s[17] = (unsigned long)&main;   /* next fp=0 -> sinir disi -> dur */
        /* zincir B (2 cerceve): s[24]->s[28]->0 */
        s[24] = (unsigned long)&s[28];  s[25] = (unsigned long)&inspect_point;
        s[28] = 0UL;                    s[29] = (unsigned long)&mk_mutex;
        /* zincir C (3 cerceve): s[36]->s[40]->s[44]->0 */
        s[36] = (unsigned long)&s[40];  s[37] = (unsigned long)&bst_insert;
        s[40] = (unsigned long)&s[44];  s[41] = (unsigned long)&mk_timer;
        s[44] = 0UL;                    s[45] = (unsigned long)&mk_proc;
        g_cs_thread.stack_base = (unsigned long)&s[0];
        g_cs_thread.stack_top  = (unsigned long)&s[64];
        g_cs_thread.fp         = (unsigned long)&s[4];        /* (geriye-uyum: bagimsiz g_cs_thread.fp hala zincir A) */
        g_cs_frame             = (frame_t *)&s[4];            /* tipli cerceve gorunumu (frame_t DWARF + cast demosu) */
        /* thread'lere zincir ata: ID dongusel olarak A/B/C, dorduncu yok (callstack bos) */
        for (int i = 0; i < g_thread_count; i++) {
            switch (i & 3) {
                case 0: g_threads[i].cs_fp = (unsigned long)&s[4];  break;   /* zincir A */
                case 1: g_threads[i].cs_fp = (unsigned long)&s[24]; break;   /* zincir B */
                case 2: g_threads[i].cs_fp = (unsigned long)&s[36]; break;   /* zincir C */
                default: g_threads[i].cs_fp = 0UL;                  break;   /* callstack yok */
            }
        }
    }

    /* g_bigs'i FARKLI degerlerle doldur (sikistirilamaz) -> blob gercekten buyuk olur */
    for (int i = 0; i < g_big_count; i++) {
        g_bigs[i].id = 1000 + i;
        g_bigs[i].name[0] = 'B'; g_bigs[i].name[1] = (char)('0' + i); g_bigs[i].name[2] = '\0';
        for (int j = 0; j < 1024; j++) g_bigs[i].data[j] = (unsigned)(i * 100000 + j * 7 + 1);
    }

    for (int tick = 0; tick < 3; tick++) {
        g_threads[1].state  = (tick % 2) ? RUNNING : READY;   /* değişiklik-vurgusu örneği */
        g_mutexes[0].locked = (tick % 2);
        g_mutexes[0].owner  = (tick % 2) ? 4 : 0;
        g_timers[0].elapsed = tick;
        g_widget_pool[0].x  = 10 + tick;
        inspect_point(tick);
    }
    return 0;
}
