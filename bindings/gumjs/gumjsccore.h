/*
 * Copyright (C) 2015 Ole André Vadla Ravnås <oleavr@nowsecure.com>
 *
 * Licence: wxWindows Library Licence, Version 3.1
 */

#ifndef __GUM_JSCRIPT_CORE_H__
#define __GUM_JSCRIPT_CORE_H__

#include "gumjscscript.h"
#include "gumjscscriptbackend.h"
#include "gumscriptscheduler.h"

#include <gum/gumexceptor.h>
#include <JavaScriptCore/JavaScriptCore.h>

#define GUM_JSC_CORE_LOCK(core)   (g_mutex_lock (&(core)->mutex))
#define GUM_JSC_CORE_UNLOCK(core) (g_mutex_unlock (&(core)->mutex))

#define GUM_JSC_SCOPE_INIT(C) { C, NULL }

G_BEGIN_DECLS

typedef struct _GumJscCore GumJscCore;
typedef struct _GumJscScope GumJscScope;
typedef struct _GumJscWeakRef GumJscWeakRef;

typedef struct _GumJscScheduledCallback GumJscScheduledCallback;
typedef struct _GumJscExceptionSink GumJscExceptionSink;
typedef struct _GumJscMessageSink GumJscMessageSink;

typedef struct _GumJscNativePointer GumJscNativePointer;
typedef struct _GumJscCpuContext GumJscCpuContext;
typedef guint GumJscCpuContextAccess;
typedef struct _GumJscNativeResource GumJscNativeResource;

typedef void (* GumJscWeakNotify) (gpointer data);
typedef void (* GumJscMessageEmitter) (GumJscScript * script,
    const gchar * message, GBytes * data);

struct _GumJscCore
{
  GumJscScript * script;
  GumJscScriptBackend * backend;
  GumJscMessageEmitter message_emitter;
  GumScriptScheduler * scheduler;
  GumExceptor * exceptor;
  JSContextRef ctx;

  GMutex mutex;

  GCond event_cond;
  volatile guint event_count;

  GumJscExceptionSink * unhandled_exception_sink;
  GumJscMessageSink * incoming_message_sink;

  GSList * unprotect_requests;
  GSource * unprotect_source;

  GHashTable * weak_refs;
  guint last_weak_ref_id;

  GSList * scheduled_callbacks;
  guint last_callback_id;

  GHashTable * native_resources;

  JSClassRef native_pointer;
  JSClassRef native_function;
  JSClassRef native_callback;
  JSClassRef cpu_context;
  JSObjectRef array_buffer;
};

struct _GumJscScope
{
  GumJscCore * core;
  JSValueRef exception;
};

struct _GumJscNativePointer
{
  gsize instance_size;
  gpointer value;
};

struct _GumJscCpuContext
{
  GumCpuContext * handle;
  GumJscCpuContextAccess access;
  GumCpuContext storage;
};

enum _GumJscCpuContextAccess
{
  GUM_CPU_CONTEXT_READONLY = 1,
  GUM_CPU_CONTEXT_READWRITE
};

struct _GumJscNativeResource
{
  GumJscWeakRef * weak_ref;
  gpointer data;
  GDestroyNotify notify;

  GumJscCore * core;
};

G_GNUC_INTERNAL void _gum_jsc_core_init (GumJscCore * self,
    GumJscScript * script, GumJscMessageEmitter message_emitter,
    GumScriptScheduler * scheduler, JSContextRef ctx, JSObjectRef scope);
G_GNUC_INTERNAL void _gum_jsc_core_flush (GumJscCore * self);
G_GNUC_INTERNAL void _gum_jsc_core_dispose (GumJscCore * self);
G_GNUC_INTERNAL void _gum_jsc_core_finalize (GumJscCore * self);

G_GNUC_INTERNAL void _gum_jsc_core_emit_message (GumJscCore * self,
    const gchar * message, GBytes * data);
G_GNUC_INTERNAL void _gum_jsc_core_post_message (GumJscCore * self,
    const gchar * message);

G_GNUC_INTERNAL void _gum_jsc_core_unprotect_later (GumJscCore * self,
    JSValueRef value);

G_GNUC_INTERNAL void _gum_jsc_core_push_job (GumJscCore * self,
    GumScriptJobFunc job_func, gpointer data, GDestroyNotify data_destroy);

G_GNUC_INTERNAL void _gum_jsc_scope_enter (GumJscScope * self,
    GumJscCore * core);
G_GNUC_INTERNAL void _gum_jsc_scope_flush (GumJscScope * self);
G_GNUC_INTERNAL void _gum_jsc_scope_leave (GumJscScope * self);

G_END_DECLS

#endif
