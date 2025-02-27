/*
 * Copyright (C) 2015 Ole André Vadla Ravnås <oleavr@nowsecure.com>
 *
 * Licence: wxWindows Library Licence, Version 3.1
 */

#ifndef __GUM_JSCRIPT_VALUE_H__
#define __GUM_JSCRIPT_VALUE_H__

#include "gumjsccore.h"

G_BEGIN_DECLS

typedef struct _GumJscArgs GumJscArgs;

struct _GumJscArgs
{
  gsize count;
  const JSValueRef * values;
  JSValueRef * exception;

  JSContextRef ctx;
  GumJscCore * core;
};

G_GNUC_INTERNAL gboolean _gumjs_args_parse (const GumJscArgs * self,
    const gchar * format, ...);

G_GNUC_INTERNAL GumJscWeakRef * _gumjs_weak_ref_new (JSContextRef ctx,
    JSValueRef value, GumJscWeakNotify notify, gpointer data,
    GDestroyNotify data_destroy);
G_GNUC_INTERNAL JSValueRef _gumjs_weak_ref_get (GumJscWeakRef * ref);
G_GNUC_INTERNAL void _gumjs_weak_ref_free (GumJscWeakRef * ref);

G_GNUC_INTERNAL gboolean _gumjs_boolean_try_get (JSContextRef ctx,
    JSValueRef value, gboolean * b, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_int_try_get (JSContextRef ctx,
    JSValueRef value, gint * i, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_uint_try_get (JSContextRef ctx,
    JSValueRef value, guint * u, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_uint_try_parse (JSContextRef ctx,
    JSStringRef str, guint * u, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_int64_try_get (JSContextRef ctx,
    JSValueRef value, gint64 * i, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_uint64_try_get (JSContextRef ctx,
    JSValueRef value, guint64 * u, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_number_try_get (JSContextRef ctx,
    JSValueRef value, gdouble * number, JSValueRef * exception);

G_GNUC_INTERNAL gchar * _gumjs_string_get (JSContextRef ctx,
    JSValueRef value);
G_GNUC_INTERNAL gboolean _gumjs_string_try_get (JSContextRef ctx,
    JSValueRef value, gchar ** str, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_string_try_get_opt (JSContextRef ctx,
    JSValueRef value, gchar ** str, JSValueRef * exception);
G_GNUC_INTERNAL gchar * _gumjs_string_from_jsc (JSStringRef str);
G_GNUC_INTERNAL gchar * _gumjs_string_from_value (JSContextRef ctx,
    JSValueRef value);
G_GNUC_INTERNAL JSValueRef _gumjs_string_to_value (JSContextRef ctx,
    const gchar * str);

G_GNUC_INTERNAL JSValueRef _gumjs_object_get (JSContextRef ctx,
    JSObjectRef object, const gchar * key);
G_GNUC_INTERNAL gboolean _gumjs_object_try_get (JSContextRef ctx,
    JSObjectRef object, const gchar * key, JSValueRef * value,
    JSValueRef * exception);
G_GNUC_INTERNAL guint _gumjs_object_get_uint (JSContextRef ctx,
    JSObjectRef object, const gchar * key);
G_GNUC_INTERNAL gboolean _gumjs_object_try_get_uint (JSContextRef ctx,
    JSObjectRef object, const gchar * key, guint * value,
    JSValueRef * exception);
G_GNUC_INTERNAL gchar * _gumjs_object_get_string (JSContextRef ctx,
    JSObjectRef object, const gchar * key);
G_GNUC_INTERNAL gboolean _gumjs_object_try_get_string (JSContextRef ctx,
    JSObjectRef object, const gchar * key, gchar ** value,
    JSValueRef * exception);
G_GNUC_INTERNAL void _gumjs_object_set (JSContextRef ctx, JSObjectRef object,
    const gchar * key, JSValueRef value);
G_GNUC_INTERNAL gboolean _gumjs_object_try_set (JSContextRef ctx,
    JSObjectRef object, const gchar * key, JSValueRef value,
    JSValueRef * exception);
G_GNUC_INTERNAL void _gumjs_object_set_int (JSContextRef ctx,
    JSObjectRef object, const gchar * key, gint value);
G_GNUC_INTERNAL gboolean _gumjs_object_try_set_int (JSContextRef ctx,
    JSObjectRef object, const gchar * key, gint value, JSValueRef * exception);
G_GNUC_INTERNAL void _gumjs_object_set_uint (JSContextRef ctx,
    JSObjectRef object, const gchar * key, guint value);
G_GNUC_INTERNAL gboolean _gumjs_object_try_set_uint (JSContextRef ctx,
    JSObjectRef object, const gchar * key, guint value, JSValueRef * exception);
G_GNUC_INTERNAL void _gumjs_object_set_string (JSContextRef ctx,
    JSObjectRef object, const gchar * key, const gchar * value);
G_GNUC_INTERNAL gboolean _gumjs_object_try_set_string (JSContextRef ctx,
    JSObjectRef object, const gchar * key, const gchar * value,
    JSValueRef * exception);
G_GNUC_INTERNAL void _gumjs_object_set_pointer (JSContextRef ctx,
    JSObjectRef object, const gchar * key, gpointer value,
    GumJscCore * core);
G_GNUC_INTERNAL gboolean _gumjs_object_try_set_pointer (JSContextRef ctx,
    JSObjectRef object, const gchar * key, gpointer value, GumJscCore * core,
    JSValueRef * exception);
G_GNUC_INTERNAL void _gumjs_object_set_function (JSContextRef ctx,
    JSObjectRef object, const gchar * key,
    JSObjectCallAsFunctionCallback callback);
G_GNUC_INTERNAL gboolean _gumjs_object_try_set_function (JSContextRef ctx,
    JSObjectRef object, const gchar * key,
    JSObjectCallAsFunctionCallback callback, JSValueRef * exception);

G_GNUC_INTERNAL gboolean _gumjs_callbacks_try_get (JSContextRef ctx,
    JSValueRef callbacks, const gchar * name, JSObjectRef * callback,
    JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_callbacks_try_get_opt (JSContextRef ctx,
    JSValueRef callbacks, const gchar * name, JSObjectRef * callback,
    JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_callback_try_get (JSContextRef ctx,
    JSValueRef value, JSObjectRef * callback, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_callback_try_get_opt (JSContextRef ctx,
    JSValueRef value, JSObjectRef * callback, JSValueRef * exception);

G_GNUC_INTERNAL JSObjectRef _gumjs_native_pointer_new (JSContextRef ctx,
    gpointer address, GumJscCore * core);
G_GNUC_INTERNAL gpointer _gumjs_native_pointer_value (JSValueRef value);
G_GNUC_INTERNAL gboolean _gumjs_native_pointer_try_get (JSContextRef ctx,
    JSValueRef value, GumJscCore * core, gpointer * target,
    JSValueRef * exception);

G_GNUC_INTERNAL JSObjectRef _gumjs_cpu_context_new (JSContextRef ctx,
    GumCpuContext * handle, GumJscCpuContextAccess access,
    GumJscCore * core);
G_GNUC_INTERNAL void _gumjs_cpu_context_detach (JSValueRef value);
G_GNUC_INTERNAL gboolean _gumjs_cpu_context_try_get (JSContextRef ctx,
    JSValueRef value, GumJscCore * core, GumCpuContext ** cpu_context,
    JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_cpu_context_try_get_opt (JSContextRef ctx,
    JSValueRef value, GumJscCore * core, GumCpuContext ** cpu_context,
    JSValueRef * exception);

G_GNUC_INTERNAL GumJscNativeResource * _gumjs_native_resource_new (
    JSContextRef ctx, gpointer data, GDestroyNotify notify,
    GumJscCore * core, JSObjectRef * handle);
G_GNUC_INTERNAL void _gumjs_native_resource_free (
    GumJscNativeResource * resource);

G_GNUC_INTERNAL JSObjectRef _gumjs_array_buffer_new (JSContextRef ctx,
    gsize size, GumJscCore * core);
G_GNUC_INTERNAL gpointer _gumjs_array_buffer_get_data (JSContextRef ctx,
    JSValueRef value, gsize * size);
G_GNUC_INTERNAL gboolean _gumjs_array_buffer_try_get_data (JSContextRef ctx,
    JSValueRef value, gpointer * data, gsize * size, JSValueRef * exception);

G_GNUC_INTERNAL gboolean _gumjs_byte_array_try_get (JSContextRef ctx,
    JSValueRef value, GBytes ** bytes, JSValueRef * exception);
G_GNUC_INTERNAL gboolean _gumjs_byte_array_try_get_opt (JSContextRef ctx,
    JSValueRef value, GBytes ** bytes, JSValueRef * exception);

G_GNUC_INTERNAL void _gumjs_throw (JSContextRef ctx, JSValueRef * exception,
    const gchar * format, ...);
G_GNUC_INTERNAL void _gumjs_throw_native (JSContextRef ctx,
    JSValueRef * exception, GumExceptionDetails * details,
    GumJscCore * core);
G_GNUC_INTERNAL void _gumjs_parse_exception_details (JSContextRef ctx,
    GumExceptionDetails * details, GumJscCore * core,
    JSObjectRef * exception, JSObjectRef * cpu_context);

G_GNUC_INTERNAL const gchar * _gumjs_thread_state_to_string (
    GumThreadState state);
G_GNUC_INTERNAL const gchar * _gumjs_memory_operation_to_string (
    GumMemoryOperation operation);

G_END_DECLS

#endif
