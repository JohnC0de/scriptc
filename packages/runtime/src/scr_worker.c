#include "scr_worker.h"

#ifdef SCR_WORKERS
#include <stdatomic.h>
#include <stdlib.h>
#include <limits.h>
#ifdef _WIN32
#include <process.h>
#include <windows.h>
#else
#include <pthread.h>
#endif

#if defined(__linux__)
#include <fcntl.h>
#include <sys/resource.h>
#include <unistd.h>

/* Every worker's mailbox holds descriptors. Once a process passes 64 of
 * them, the kernel grows its descriptor table, and while other threads share
 * the table it first waits a full RCU grace period (synchronize_rcu in
 * expand_fdtable): measured 11-25 ms on a 16-vCPU host, on the thread that
 * starts the next worker. Growing the table at load, while the process still
 * has one thread, never waits; the table never shrinks. 256 entries leave
 * room for the most workers the allocator gives arenas to. */
__attribute__((constructor)) static void scr_worker_reserve_fd_table(void) {
  const int top = 255;
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY && limit.rlim_cur <= (rlim_t)top)
    return;
  for (int fd = 0; fd <= 2; fd++) {
    int copy = fcntl(fd, F_DUPFD_CLOEXEC, top);
    if (copy >= 0) {
      (void)close(copy);
      return;
    }
  }
}
#endif

struct ScrWorkerThread {
  atomic_size_t references;
  atomic_bool cancel;
#ifdef SCR_EXC_FLAG
  /* The worker thread's exact pending word (scr_exception.c) while its
   * script runs, NULL before and after: terminate() sets the stop bit
   * through it. The lock keeps the thread's TLS alive across that write. */
  pthread_mutex_t flag_lock;
  _Atomic uint32_t *flag;
#else
  /* The exception alert reference of a terminate request: 0 none, 1 held,
   * 2 the thread finished its script (no reference is taken any more). */
  atomic_int alert;
#endif
  atomic_bool port_closed;
  uint64_t id;
  uint32_t root;
  ScrWorkerEntry entry;
  ScrMailbox *inbox;
  ScrMailbox *parent;
  ScrMessage *data;
  ScrContextEnv *environment;
  int argc;
  char **argv;
  bool joined;
#ifdef _WIN32
  HANDLE thread;
#else
  pthread_t thread;
#endif
};

static atomic_uint_fast64_t scr_worker_next_id = 1;
static SCR_TL ScrWorkerThread *scr_worker_current;
static SCR_TL ScrDyn *scr_worker_local_data;

static ScrMailEvent *scr_worker_event(unsigned kind, uint64_t source,
                                     int code, ScrMessage *message) {
  ScrMailEvent *event = calloc(1, sizeof(*event));
  if (!event) scr_trap("scriptc: out of memory\n");
  *event = (ScrMailEvent){.kind = kind, .source = source, .code = code, .message = message};
  return event;
}

ScrWorkerThread *scr_worker_thread_retain(ScrWorkerThread *worker) {
  atomic_fetch_add_explicit(&worker->references, 1, memory_order_relaxed);
  return worker;
}

void scr_worker_thread_release(ScrWorkerThread *worker) {
  if (!worker || atomic_fetch_sub_explicit(&worker->references, 1, memory_order_acq_rel) != 1) return;
#ifdef _WIN32
  if (worker->thread) CloseHandle(worker->thread);
#else
  if (!worker->joined) (void)pthread_detach(worker->thread);
#endif
  scr_mailbox_release(worker->inbox);
  scr_mailbox_release(worker->parent);
  scr_message_free(worker->data);
  scr_context_env_free(worker->environment);
  for (int i = 0; i < worker->argc; i++) free(worker->argv[i]);
  free(worker->argv);
#ifdef SCR_EXC_FLAG
  pthread_mutex_destroy(&worker->flag_lock);
#endif
  free(worker);
}

static void scr_worker_data_cleanup(void) {
  ScrDyn *data = scr_worker_local_data;
  scr_worker_local_data = NULL;
  scr_dyn_release(data);
}

ScrDyn *scr_worker_data(void) {
  if (!scr_worker_current) return scr_dyn_new_null();
  if (!scr_worker_local_data) {
    ScrDyn *data = scr_message_decode(scr_worker_current->data);
    if (!data) return NULL;
    scr_worker_local_data = data;
    if (scr_context_atexit(scr_worker_data_cleanup) != 0) scr_trap("scriptc: out of memory\n");
    scr_message_free(scr_worker_current->data);
    scr_worker_current->data = NULL;
  }
  return scr_dyn_retain(scr_worker_local_data);
}

ScrMailbox *scr_worker_inbox(void) {
  return scr_worker_current ? scr_worker_current->inbox : NULL;
}

double scr_worker_root(void) { return scr_worker_current ? (double)scr_worker_current->root : -1; }
int scr_worker_argc(void) { return scr_worker_current ? scr_worker_current->argc : 0; }
char **scr_worker_argv(void) { return scr_worker_current ? scr_worker_current->argv : NULL; }

uint64_t scr_worker_thread_id(const ScrWorkerThread *worker) { return worker->id; }

void scr_worker_thread_terminate(ScrWorkerThread *worker) {
  atomic_store_explicit(&worker->cancel, true, memory_order_relaxed);
#ifdef SCR_EXC_FLAG
  /* Emitted checks test only the worker's own pending word: raise its stop
   * bit. A worker that has not registered its word yet finds the cancel
   * flag when it does (scr_worker_thread_run); one that has finished its
   * script needs nothing. */
  pthread_mutex_lock(&worker->flag_lock);
  if (worker->flag) scr_exc_flag_request_stop(worker->flag);
  pthread_mutex_unlock(&worker->flag_lock);
#else
  /* Emitted polls only call into the runtime while the exception alert is
   * raised: hold a reference until the worker's script has ended. */
  scr_exc_alert_add(1);
  int idle = 0;
  if (!atomic_compare_exchange_strong_explicit(&worker->alert, &idle, 1, memory_order_acq_rel,
                                               memory_order_acquire))
    scr_exc_alert_add(-1);
#endif
  scr_mailbox_post(worker->inbox, scr_worker_event(SCR_WORKER_WAKE, 0, 0, NULL));
}

bool scr_worker_thread_post(ScrWorkerThread *worker, ScrMessage *message) {
  if (atomic_load_explicit(&worker->port_closed, memory_order_relaxed)) {
    scr_message_free(message);
    return false;
  }
  return scr_mailbox_post(worker->inbox, scr_worker_event(SCR_WORKER_MESSAGE, 0, 0, message));
}

void scr_worker_port_close(void) {
  if (scr_worker_current)
    atomic_store_explicit(&scr_worker_current->port_closed, true, memory_order_relaxed);
}

bool scr_worker_post_parent(ScrMessage *message) {
  if (!scr_worker_current) { scr_message_free(message); return false; }
  return scr_mailbox_post(scr_worker_current->parent,
    scr_worker_event(SCR_WORKER_MESSAGE, scr_worker_current->id, 0, message));
}

static void scr_worker_report_error(void) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  ScrMessage *message = scr_message_encode(value);
  scr_dyn_release(value);
  scr_caught_release(caught);
  if (!message) {
    scr_exc_clear();
    static const char text[] = "Serializing an uncaught exception failed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, text, sizeof text - 1, "ERR_WORKER_UNSERIALIZABLE_ERROR");
    caught = scr_exc_take();
    value = scr_caught_to_dyn(caught);
    message = scr_message_encode(value);
    scr_dyn_release(value);
    scr_caught_release(caught);
  }
  scr_mailbox_post(scr_worker_current->parent,
    scr_worker_event(SCR_WORKER_ERROR, scr_worker_current->id, 0, message));
}

static void scr_worker_thread_run(ScrWorkerThread *worker) {
  scr_context_enter(worker->id);
#ifdef SCR_EXC_FLAG
  pthread_mutex_lock(&worker->flag_lock);
  worker->flag = &scr_exc_flag;
  pthread_mutex_unlock(&worker->flag_lock);
  /* A terminate() that ran before the registration only set the flag. */
  if (atomic_load_explicit(&worker->cancel, memory_order_relaxed))
    scr_exc_flag_request_stop(&scr_exc_flag);
#endif
  scr_context_stop_flag(&worker->cancel);
  scr_context_env_enter(worker->environment);
  worker->environment = NULL;
  scr_worker_current = worker;
  scr_context_report_error = scr_worker_report_error;
  scr_mailbox_post(worker->parent, scr_worker_event(SCR_WORKER_ONLINE, worker->id, 0, NULL));
  int code = worker->entry(worker->root);
  scr_mailbox_close(worker->inbox);
  scr_context_cleanup();
  scr_worker_current = NULL;
  scr_exc_alert_thread_exit();
#ifdef SCR_EXC_FLAG
  pthread_mutex_lock(&worker->flag_lock);
  worker->flag = NULL;
  pthread_mutex_unlock(&worker->flag_lock);
#else
  if (atomic_exchange_explicit(&worker->alert, 2, memory_order_acq_rel) == 1) scr_exc_alert_add(-1);
#endif
  /* Cleanup may itself finish owner-bound native operations. Publish exit
   * only once none of those operations can touch the worker's script heap. */
  scr_mailbox_post(worker->parent, scr_worker_event(SCR_WORKER_EXIT, worker->id, code, NULL));
  scr_worker_thread_release(worker);
  /* The next script thread continues this thread's allocator arena. */
  scr_sa_thread_park();
}

#ifdef _WIN32
static unsigned __stdcall scr_worker_thread_main(void *data) {
  scr_worker_thread_run(data);
  return 0;
}
#else
static void *scr_worker_thread_main(void *data) {
  scr_worker_thread_run(data);
  return NULL;
}
#endif

ScrWorkerThread *scr_worker_thread_start(ScrWorkerEntry entry, uint32_t root,
                                        ScrMessage *data, ScrMailbox *parent,
                                        ScrArr *arguments) {
  ScrWorkerThread *worker = calloc(1, sizeof(*worker));
  if (!worker) scr_trap("scriptc: out of memory\n");
  atomic_init(&worker->references, 2); /* owner and native thread */
  atomic_init(&worker->cancel, false);
#ifdef SCR_EXC_FLAG
  if (pthread_mutex_init(&worker->flag_lock, NULL) != 0) scr_trap("scriptc: out of memory\n");
  worker->flag = NULL;
#else
  atomic_init(&worker->alert, 0);
#endif
  atomic_init(&worker->port_closed, false);
  worker->id = atomic_fetch_add_explicit(&scr_worker_next_id, 1, memory_order_relaxed);
  worker->entry = entry;
  worker->root = root;
  worker->data = data;
  worker->environment = scr_context_env_capture();
  worker->parent = scr_mailbox_retain(parent);
  if (arguments) {
    if (arguments->len > INT_MAX) scr_trap("scriptc: too many worker arguments\n");
    worker->argc = (int)arguments->len;
    worker->argv = calloc(arguments->len + 1, sizeof(*worker->argv));
    if (!worker->argv) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < arguments->len; i++) {
      ScrStr *text = scr_arr_get_ref(arguments, (double)i);
      worker->argv[i] = malloc(text->len + 1);
      if (!worker->argv[i]) scr_trap("scriptc: out of memory\n");
      memcpy(worker->argv[i], text->data, text->len + 1);
      scr_str_release(text);
    }
  }
  worker->inbox = scr_mailbox_new();
  if (!worker->inbox) goto failed;
#ifdef _WIN32
  worker->thread = (HANDLE)_beginthreadex(NULL, 0, scr_worker_thread_main, worker, 0, NULL);
  if (!worker->thread) goto failed;
#else
  /* An explicit size keeps recursion depth independent of the C library's
   * default thread stack (as small as 128 KiB with musl and 512 KiB on
   * macOS): workers get the 8 MiB a main thread usually has. Pages are
   * committed only as the stack grows. */
  pthread_attr_t attr;
  if (pthread_attr_init(&attr) != 0) goto failed;
  (void)pthread_attr_setstacksize(&attr, (size_t)8 << 20);
  int started = pthread_create(&worker->thread, &attr, scr_worker_thread_main, worker);
  pthread_attr_destroy(&attr);
  if (started != 0) goto failed;
#endif
  return worker;
failed:
  for (int i = 0; i < worker->argc; i++) free(worker->argv[i]);
  free(worker->argv);
  scr_context_env_free(worker->environment);
  scr_mailbox_release(worker->inbox);
  scr_mailbox_release(worker->parent);
  scr_message_free(worker->data);
#ifdef SCR_EXC_FLAG
  pthread_mutex_destroy(&worker->flag_lock);
#endif
  free(worker);
  if (!scr_exc_pending()) {
    static const char message[] = "Could not start worker thread";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_WORKER_INIT_FAILED");
  }
  return NULL;
}

void scr_worker_thread_join(ScrWorkerThread *worker) {
  if (worker->joined) return;
#ifdef _WIN32
  if (WaitForSingleObject(worker->thread, INFINITE) != WAIT_OBJECT_0)
    scr_trap("scriptc: worker join failed\n");
#else
  if (pthread_join(worker->thread, NULL) != 0) scr_trap("scriptc: worker join failed\n");
#endif
  worker->joined = true;
}
#endif
