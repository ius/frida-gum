/*
 * Copyright (C) 2010-2015 Ole André Vadla Ravnås <oleavr@nowsecure.com>
 * Copyright (C) 2013 Karl Trygve Kalleberg <karltk@boblycat.org>
 *
 * Licence: wxWindows Library Licence, Version 3.1
 */

#include "gumv8scriptbackend.h"

#include "gumscripttask.h"
#include "gumv8platform.h"
#include "gumv8script.h"

#include <gum/guminterceptor.h>
#include <string.h>
#include <v8-debug.h>

#define GUM_V8_SCRIPT_BACKEND_LOCK()   (g_mutex_lock (&priv->mutex))
#define GUM_V8_SCRIPT_BACKEND_UNLOCK() (g_mutex_unlock (&priv->mutex))

#define GUM_V8_SCRIPT_BACKEND_GET_PLATFORM(backend) \
    static_cast<GumV8Platform *> (gum_v8_script_backend_get_platform (backend))
#define GUM_V8_SCRIPT_BACKEND_GET_ISOLATE(backend) \
    static_cast<Isolate *> (gum_v8_script_backend_get_isolate (backend))

#define GUM_V8_FLAGS \
    "--es-staging " \
    "--harmony-array-includes " \
    "--harmony-regexps " \
    "--harmony-proxies " \
    "--harmony-rest-parameters " \
    "--harmony-reflect " \
    "--harmony-destructuring " \
    "--expose-gc"

using namespace v8;

typedef struct _GumCreateScriptData GumCreateScriptData;
typedef struct _GumEmitDebugMessageData GumEmitDebugMessageData;

template <typename T>
struct GumPersistent
{
  typedef Persistent<T, CopyablePersistentTraits<T> > type;
};

struct _GumV8ScriptBackendPrivate
{
  GMutex mutex;

  GumV8Platform * platform;

  GHashTable * ignored_threads;
  GSList * pending_unignores;
  GSource * pending_timeout;
  GumInterceptor * interceptor;
  GRWLock ignored_lock;

  GumScriptDebugMessageHandler debug_handler;
  gpointer debug_handler_data;
  GDestroyNotify debug_handler_data_destroy;
  GMainContext * debug_handler_context;
  GumPersistent<Context>::type * debug_context;
};

struct _GumCreateScriptData
{
  gchar * name;
  gchar * source;
};

struct _GumEmitDebugMessageData
{
  GumV8ScriptBackend * backend;
  gchar * message;
};

static void gum_v8_script_backend_iface_init (gpointer g_iface,
    gpointer iface_data);
static void gum_v8_script_backend_dispose (GObject * object);
static void gum_v8_script_backend_finalize (GObject * object);

static void gum_v8_script_backend_create (GumScriptBackend * backend,
    const gchar * name, const gchar * source, GCancellable * cancellable,
    GAsyncReadyCallback callback, gpointer user_data);
static GumScript * gum_v8_script_backend_create_finish (
    GumScriptBackend * backend, GAsyncResult * result, GError ** error);
static GumScript * gum_v8_script_backend_create_sync (
    GumScriptBackend * backend, const gchar * name, const gchar * source,
    GCancellable * cancellable, GError ** error);
static GumScriptTask * gum_create_script_task_new (GumV8ScriptBackend * backend,
    const gchar * name, const gchar * source, GCancellable * cancellable,
    GAsyncReadyCallback callback, gpointer user_data);
static void gum_create_script_task_run (GumScriptTask * task,
    gpointer source_object, gpointer task_data, GCancellable * cancellable);
static void gum_create_script_data_free (GumCreateScriptData * d);

static void gum_v8_script_backend_set_debug_message_handler (
    GumScriptBackend * backend, GumScriptDebugMessageHandler handler,
    gpointer data, GDestroyNotify data_destroy);
static void gum_v8_script_backend_enable_debugger (GumV8ScriptBackend * self);
static void gum_v8_script_backend_disable_debugger (GumV8ScriptBackend * self);
static void gum_v8_script_backend_emit_debug_message (
    const Debug::Message & message);
static gboolean gum_v8_script_backend_do_emit_debug_message (
    GumEmitDebugMessageData * d);
static void gum_emit_debug_message_data_free (GumEmitDebugMessageData * d);
static void gum_v8_script_backend_post_debug_message (
    GumScriptBackend * backend, const gchar * message);
static void gum_v8_script_backend_do_process_debug_messages (
    GumV8ScriptBackend * self);

static void gum_v8_script_backend_ignore (GumScriptBackend * backend,
    GumThreadId thread_id);
static void gum_v8_script_backend_unignore (GumScriptBackend * backend,
    GumThreadId thread_id);
static void gum_v8_script_backend_adjust_ignore_level (
    GumV8ScriptBackend * self, GumThreadId thread_id, gint adjustment);
static void gum_v8_script_backend_adjust_ignore_level_unlocked (
    GumV8ScriptBackend * self, GumThreadId thread_id, gint adjustment);
static void gum_v8_script_backend_unignore_later (GumScriptBackend * backend,
    GumThreadId thread_id);
static gboolean gum_flush_pending_unignores (gpointer user_data);
static gboolean gum_v8_script_backend_is_ignoring (GumScriptBackend * backend,
    GumThreadId thread_id);
static gboolean gum_v8_script_backend_supports_unload (
    GumScriptBackend * backend);

G_DEFINE_TYPE_EXTENDED (GumV8ScriptBackend,
                        gum_v8_script_backend,
                        G_TYPE_OBJECT,
                        0,
                        G_IMPLEMENT_INTERFACE (GUM_TYPE_SCRIPT_BACKEND,
                            gum_v8_script_backend_iface_init));

static void
gum_v8_script_backend_class_init (GumV8ScriptBackendClass * klass)
{
  GObjectClass * object_class = G_OBJECT_CLASS (klass);

  g_type_class_add_private (klass, sizeof (GumV8ScriptBackendPrivate));

  object_class->dispose = gum_v8_script_backend_dispose;
  object_class->finalize = gum_v8_script_backend_finalize;
}

static void
gum_v8_script_backend_iface_init (gpointer g_iface,
                                  gpointer iface_data)
{
  GumScriptBackendIface * iface = (GumScriptBackendIface *) g_iface;

  (void) iface_data;

  iface->create = gum_v8_script_backend_create;
  iface->create_finish = gum_v8_script_backend_create_finish;
  iface->create_sync = gum_v8_script_backend_create_sync;

  iface->set_debug_message_handler =
      gum_v8_script_backend_set_debug_message_handler;
  iface->post_debug_message = gum_v8_script_backend_post_debug_message;

  iface->ignore = gum_v8_script_backend_ignore;
  iface->unignore = gum_v8_script_backend_unignore;
  iface->unignore_later = gum_v8_script_backend_unignore_later;
  iface->is_ignoring = gum_v8_script_backend_is_ignoring;

  iface->supports_unload = gum_v8_script_backend_supports_unload;
}

static void
gum_v8_script_backend_init (GumV8ScriptBackend * self)
{
  GumV8ScriptBackendPrivate * priv;

  priv = self->priv = G_TYPE_INSTANCE_GET_PRIVATE (self,
      GUM_V8_TYPE_SCRIPT_BACKEND, GumV8ScriptBackendPrivate);

  g_mutex_init (&priv->mutex);

  priv->platform = NULL;

  priv->ignored_threads = g_hash_table_new_full (NULL, NULL, NULL, NULL);

  priv->interceptor = gum_interceptor_obtain ();
}

static void
gum_v8_script_backend_dispose (GObject * object)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (object);
  GumV8ScriptBackendPrivate * priv = self->priv;

  if (priv->debug_handler_data_destroy != NULL)
    priv->debug_handler_data_destroy (priv->debug_handler_data);
  priv->debug_handler = NULL;
  priv->debug_handler_data = NULL;
  priv->debug_handler_data_destroy = NULL;

  g_clear_pointer (&priv->debug_handler_context, g_main_context_unref);

  gum_v8_script_backend_disable_debugger (self);

  if (priv->pending_timeout != NULL)
  {
    g_source_destroy (priv->pending_timeout);
    g_clear_pointer (&priv->pending_timeout, g_source_unref);
  }
  g_clear_pointer (&priv->pending_unignores, g_slist_free);

  g_clear_pointer (&priv->interceptor, g_object_unref);

  g_clear_pointer (&priv->ignored_threads, g_hash_table_unref);

  G_OBJECT_CLASS (gum_v8_script_backend_parent_class)->dispose (object);
}

static void
gum_v8_script_backend_finalize (GObject * object)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (object);
  GumV8ScriptBackendPrivate * priv = self->priv;

  delete priv->platform;

  g_mutex_clear (&priv->mutex);

  G_OBJECT_CLASS (gum_v8_script_backend_parent_class)->finalize (object);
}

gpointer
gum_v8_script_backend_get_platform (GumV8ScriptBackend * self)
{
  GumV8ScriptBackendPrivate * priv = self->priv;

  if (priv->platform == NULL)
  {
    V8::SetFlagsFromString (GUM_V8_FLAGS,
        static_cast<int> (strlen (GUM_V8_FLAGS)));
    priv->platform = new GumV8Platform ();
    priv->platform->GetIsolate ()->SetData (0, self);
  }

  return priv->platform;
}

gpointer
gum_v8_script_backend_get_isolate (GumV8ScriptBackend * self)
{
  return GUM_V8_SCRIPT_BACKEND_GET_PLATFORM (self)->GetIsolate ();
}

GumScriptScheduler *
gum_v8_script_backend_get_scheduler (GumV8ScriptBackend * self)
{
  return GUM_V8_SCRIPT_BACKEND_GET_PLATFORM (self)->GetScheduler ();
}

static void
gum_v8_script_backend_create (GumScriptBackend * backend,
                              const gchar * name,
                              const gchar * source,
                              GCancellable * cancellable,
                              GAsyncReadyCallback callback,
                              gpointer user_data)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);
  GumScriptTask * task;

  task = gum_create_script_task_new (self, name, source, cancellable, callback,
      user_data);
  gum_script_task_run_in_js_thread (task,
      gum_v8_script_backend_get_scheduler (self));
  g_object_unref (task);
}

static GumScript *
gum_v8_script_backend_create_finish (GumScriptBackend * backend,
                                     GAsyncResult * result,
                                     GError ** error)
{
  (void) backend;

  return GUM_SCRIPT (gum_script_task_propagate_pointer (
      GUM_SCRIPT_TASK (result), error));
}

static GumScript *
gum_v8_script_backend_create_sync (GumScriptBackend * backend,
                                   const gchar * name,
                                   const gchar * source,
                                   GCancellable * cancellable,
                                   GError ** error)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);
  GumScript * script;
  GumScriptTask * task;

  task = gum_create_script_task_new (self, name, source, cancellable, NULL,
      NULL);
  gum_script_task_run_in_js_thread_sync (task,
      gum_v8_script_backend_get_scheduler (self));
  script = GUM_SCRIPT (gum_script_task_propagate_pointer (task, error));
  g_object_unref (task);

  return script;
}

static GumScriptTask *
gum_create_script_task_new (GumV8ScriptBackend * backend,
                            const gchar * name,
                            const gchar * source,
                            GCancellable * cancellable,
                            GAsyncReadyCallback callback,
                            gpointer user_data)
{
  GumCreateScriptData * d = g_slice_new (GumCreateScriptData);
  d->name = g_strdup (name);
  d->source = g_strdup (source);

  GumScriptTask * task = gum_script_task_new (gum_create_script_task_run,
      backend, cancellable, callback, user_data);
  gum_script_task_set_task_data (task, d,
      (GDestroyNotify) gum_create_script_data_free);
  return task;
}

static void
gum_create_script_task_run (GumScriptTask * task,
                            gpointer source_object,
                            gpointer task_data,
                            GCancellable * cancellable)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (source_object);
  Isolate * isolate = GUM_V8_SCRIPT_BACKEND_GET_ISOLATE (self);
  GumCreateScriptData * d = (GumCreateScriptData *) task_data;
  GumV8Script * script;
  GError * error = NULL;

  (void) cancellable;

  script = GUM_V8_SCRIPT (g_object_new (GUM_V8_TYPE_SCRIPT,
      "name", d->name,
      "source", d->source,
      "main-context", gum_script_task_get_context (task),
      "backend", self,
      NULL));

  {
    Locker locker (isolate);
    Isolate::Scope isolate_scope (isolate);
    HandleScope handle_scope (isolate);

    gum_v8_script_create_context (script, &error);
  }

  if (error == NULL)
  {
    gum_script_task_return_pointer (task, script, g_object_unref);
  }
  else
  {
    gum_script_task_return_error (task, error);
    g_object_unref (script);
  }
}

static void
gum_create_script_data_free (GumCreateScriptData * d)
{
  g_free (d->name);
  g_free (d->source);

  g_slice_free (GumCreateScriptData, d);
}

static void
gum_v8_script_backend_set_debug_message_handler (
    GumScriptBackend * backend,
    GumScriptDebugMessageHandler handler,
    gpointer data,
    GDestroyNotify data_destroy)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);
  GumV8ScriptBackendPrivate * priv = self->priv;
  GMainContext * old_context, * new_context;

  if (priv->debug_handler_data_destroy != NULL)
    priv->debug_handler_data_destroy (priv->debug_handler_data);

  priv->debug_handler = handler;
  priv->debug_handler_data = data;
  priv->debug_handler_data_destroy = data_destroy;

  new_context = (handler != NULL) ? g_main_context_ref_thread_default () : NULL;

  GUM_V8_SCRIPT_BACKEND_LOCK ();
  old_context = priv->debug_handler_context;
  priv->debug_handler_context = new_context;
  GUM_V8_SCRIPT_BACKEND_UNLOCK ();

  if (old_context != NULL)
    g_main_context_unref (old_context);

  gum_script_scheduler_push_job_on_js_thread (
      gum_v8_script_backend_get_scheduler (self),
      G_PRIORITY_DEFAULT,
      (handler != NULL)
          ? (GumScriptJobFunc) gum_v8_script_backend_enable_debugger
          : (GumScriptJobFunc) gum_v8_script_backend_disable_debugger,
      self, NULL, self);
}

static void
gum_v8_script_backend_enable_debugger (GumV8ScriptBackend * self)
{
  GumV8ScriptBackendPrivate * priv = self->priv;
  Isolate * isolate = GUM_V8_SCRIPT_BACKEND_GET_ISOLATE (self);

  Locker locker (isolate);
  Isolate::Scope isolate_scope (isolate);
  HandleScope handle_scope (isolate);

  Debug::SetMessageHandler (gum_v8_script_backend_emit_debug_message);

  Local<Context> context = Debug::GetDebugContext ();
  priv->debug_context = new GumPersistent<Context>::type (isolate, context);
  Context::Scope context_scope (context);

  gum_v8_bundle_run (
      GUM_V8_SCRIPT_BACKEND_GET_PLATFORM (self)->GetDebugRuntime ());
}

static void
gum_v8_script_backend_disable_debugger (GumV8ScriptBackend * self)
{
  GumV8ScriptBackendPrivate * priv = self->priv;
  Isolate * isolate = GUM_V8_SCRIPT_BACKEND_GET_ISOLATE (self);

  Locker locker (isolate);
  Isolate::Scope isolate_scope (isolate);
  HandleScope handle_scope (isolate);

  delete priv->debug_context;
  priv->debug_context = nullptr;

  Debug::SetMessageHandler (nullptr);
}

static void
gum_v8_script_backend_emit_debug_message (const Debug::Message & message)
{
  Isolate * isolate = message.GetIsolate ();
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (isolate->GetData (0));
  GumV8ScriptBackendPrivate * priv = self->priv;
  HandleScope scope (isolate);

  Local<String> json = message.GetJSON ();
  String::Utf8Value json_str (json);

  GUM_V8_SCRIPT_BACKEND_LOCK ();
  GMainContext * context = (priv->debug_handler_context != NULL)
      ? g_main_context_ref (priv->debug_handler_context)
      : NULL;
  GUM_V8_SCRIPT_BACKEND_UNLOCK ();

  if (context == NULL)
    return;

  GumEmitDebugMessageData * d = g_slice_new (GumEmitDebugMessageData);
  d->backend = self;
  g_object_ref (self);
  d->message = g_strdup (*json_str);

  GSource * source = g_idle_source_new ();
  g_source_set_callback (source,
      (GSourceFunc) gum_v8_script_backend_do_emit_debug_message,
      d,
      (GDestroyNotify) gum_emit_debug_message_data_free);
  g_source_attach (source, context);
  g_source_unref (source);

  g_main_context_unref (context);
}

static gboolean
gum_v8_script_backend_do_emit_debug_message (GumEmitDebugMessageData * d)
{
  GumV8ScriptBackend * self = d->backend;
  GumV8ScriptBackendPrivate * priv = self->priv;

  if (priv->debug_handler != NULL)
    priv->debug_handler (d->message, priv->debug_handler_data);

  return FALSE;
}

static void
gum_emit_debug_message_data_free (GumEmitDebugMessageData * d)
{
  g_free (d->message);
  g_object_unref (d->backend);

  g_slice_free (GumEmitDebugMessageData, d);
}

static void
gum_v8_script_backend_post_debug_message (GumScriptBackend * backend,
                                          const gchar * message)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);
  GumV8ScriptBackendPrivate * priv = self->priv;

  if (priv->debug_handler == NULL)
    return;

  Isolate * isolate = GUM_V8_SCRIPT_BACKEND_GET_ISOLATE (self);

  glong command_length;
  uint16_t * command = g_utf8_to_utf16 (message, (glong) strlen (message), NULL,
      &command_length, NULL);
  g_assert (command != NULL);

  Debug::SendCommand (isolate, command, command_length);

  g_free (command);

  gum_script_scheduler_push_job_on_js_thread (
      gum_v8_script_backend_get_scheduler (self),
      G_PRIORITY_DEFAULT,
      (GumScriptJobFunc) gum_v8_script_backend_do_process_debug_messages,
      self, NULL, self);
}

static void
gum_v8_script_backend_do_process_debug_messages (GumV8ScriptBackend * self)
{
  GumV8ScriptBackendPrivate * priv = self->priv;
  Isolate * isolate = GUM_V8_SCRIPT_BACKEND_GET_ISOLATE (self);
  Locker locker (isolate);
  Isolate::Scope isolate_scope (isolate);
  HandleScope handle_scope (isolate);
  Local<Context> context (Local<Context>::New (isolate, *priv->debug_context));
  Context::Scope context_scope (context);

  Debug::ProcessDebugMessages ();
}

static void
gum_v8_script_backend_ignore (GumScriptBackend * backend,
                              GumThreadId thread_id)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);

  gum_v8_script_backend_adjust_ignore_level (self, thread_id, 1);
}

static void
gum_v8_script_backend_unignore (GumScriptBackend * backend,
                                GumThreadId thread_id)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);

  gum_v8_script_backend_adjust_ignore_level (self, thread_id, -1);
}

static void
gum_v8_script_backend_adjust_ignore_level (GumV8ScriptBackend * self,
                                           GumThreadId thread_id,
                                           gint adjustment)
{
  GumV8ScriptBackendPrivate * priv = self->priv;

  gum_interceptor_ignore_current_thread (priv->interceptor);

  g_rw_lock_writer_lock (&priv->ignored_lock);
  gum_v8_script_backend_adjust_ignore_level_unlocked (self, thread_id,
      adjustment);
  g_rw_lock_writer_unlock (&priv->ignored_lock);

  gum_interceptor_unignore_current_thread (priv->interceptor);
}

static void
gum_v8_script_backend_adjust_ignore_level_unlocked (
    GumV8ScriptBackend * self,
    GumThreadId thread_id,
    gint adjustment)
{
  GumV8ScriptBackendPrivate * priv = self->priv;
  gpointer thread_id_ptr = GSIZE_TO_POINTER (thread_id);
  gint level;

  level = GPOINTER_TO_INT (g_hash_table_lookup (priv->ignored_threads,
      thread_id_ptr));
  level += adjustment;

  if (level > 0)
  {
    g_hash_table_insert (priv->ignored_threads, thread_id_ptr,
        GINT_TO_POINTER (level));
  }
  else
  {
    g_hash_table_remove (priv->ignored_threads, thread_id_ptr);
  }
}

static void
gum_v8_script_backend_unignore_later (GumScriptBackend * backend,
                                      GumThreadId thread_id)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);
  GumV8ScriptBackendPrivate * priv = self->priv;
  GMainContext * main_context;
  GSource * source;

  main_context = gum_script_scheduler_get_js_context (
      gum_v8_script_backend_get_scheduler (self));

  gum_interceptor_ignore_current_thread (priv->interceptor);

  g_rw_lock_writer_lock (&priv->ignored_lock);

  priv->pending_unignores = g_slist_prepend (priv->pending_unignores,
      GSIZE_TO_POINTER (thread_id));
  source = priv->pending_timeout;
  priv->pending_timeout = NULL;

  g_rw_lock_writer_unlock (&priv->ignored_lock);

  if (source != NULL)
  {
    g_source_destroy (source);
    g_source_unref (source);
  }
  source = g_timeout_source_new_seconds (5);
  g_source_set_callback (source, gum_flush_pending_unignores, self, NULL);
  g_source_attach (source, main_context);

  g_rw_lock_writer_lock (&priv->ignored_lock);

  if (priv->pending_timeout == NULL)
  {
    priv->pending_timeout = source;
    source = NULL;
  }

  g_rw_lock_writer_unlock (&priv->ignored_lock);

  if (source != NULL)
  {
    g_source_destroy (source);
    g_source_unref (source);
  }

  gum_interceptor_unignore_current_thread (priv->interceptor);
}

static gboolean
gum_flush_pending_unignores (gpointer user_data)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (user_data);
  GumV8ScriptBackendPrivate * priv = self->priv;

  gum_interceptor_ignore_current_thread (priv->interceptor);

  g_rw_lock_writer_lock (&priv->ignored_lock);

  if (priv->pending_timeout == g_main_current_source ())
  {
    g_source_unref (priv->pending_timeout);
    priv->pending_timeout = NULL;
  }

  while (priv->pending_unignores != NULL)
  {
    GumThreadId thread_id;

    thread_id = GPOINTER_TO_SIZE (priv->pending_unignores->data);
    priv->pending_unignores = g_slist_delete_link (priv->pending_unignores,
        priv->pending_unignores);
    gum_v8_script_backend_adjust_ignore_level_unlocked (self, thread_id, -1);
  }

  g_rw_lock_writer_unlock (&priv->ignored_lock);

  gum_interceptor_unignore_current_thread (priv->interceptor);

  return FALSE;
}

static gboolean
gum_v8_script_backend_is_ignoring (GumScriptBackend * backend,
                                   GumThreadId thread_id)
{
  GumV8ScriptBackend * self = GUM_V8_SCRIPT_BACKEND (backend);
  GumV8ScriptBackendPrivate * priv = self->priv;
  gboolean is_ignored;

  g_rw_lock_reader_lock (&priv->ignored_lock);

  is_ignored = priv->ignored_threads != NULL && g_hash_table_contains (
      priv->ignored_threads, GSIZE_TO_POINTER (thread_id));

  g_rw_lock_reader_unlock (&priv->ignored_lock);

  return is_ignored;
}

static gboolean
gum_v8_script_backend_supports_unload (GumScriptBackend * backend)
{
  (void) backend;

  return TRUE;
}
