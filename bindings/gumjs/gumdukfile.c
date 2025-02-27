/*
 * Copyright (C) 2015 Ole André Vadla Ravnås <oleavr@nowsecure.com>
 *
 * Licence: wxWindows Library Licence, Version 3.1
 */

#include "gumdukfile.h"

#include "gumdukmacros.h"

#include <errno.h>
#include <string.h>

#define GUMJS_FILE(o) \
  ((GumFile *) _gumjs_get_private_data (ctx, o))

typedef struct _GumFile GumFile;

struct _GumFile
{
  FILE * handle;
};

GUMJS_DECLARE_CONSTRUCTOR (gumjs_file_construct)
GUMJS_DECLARE_FINALIZER (gumjs_file_finalize)
static void gum_file_close (GumFile * self);
GUMJS_DECLARE_FUNCTION (gumjs_file_write)
GUMJS_DECLARE_FUNCTION (gumjs_file_flush)
GUMJS_DECLARE_FUNCTION (gumjs_file_close)

static const duk_function_list_entry gumjs_file_functions[] =
{
  { "write", gumjs_file_write, 1 },
  { "flush", gumjs_file_flush, 0 },
  { "close", gumjs_file_close, 0 },

  { NULL, NULL, 0 }
};

void
_gum_duk_file_init (GumDukFile * self,
                    GumDukCore * core)
{
  duk_context * ctx = core->ctx;

  self->core = core;

  duk_push_c_function (ctx, gumjs_file_construct, 2);
  // [ construct ]
  duk_push_object (ctx);
  // [ construct proto ]
  duk_put_function_list (ctx, -1, gumjs_file_functions);
  duk_push_c_function (ctx, gumjs_file_finalize, 0);
  // [ construct proto finalize ]
  duk_set_finalizer (ctx, -2);
  // [ construct proto ]
  duk_put_prop_string (ctx, -2, "prototype");
  // [ construct ]
  self->file = _gumjs_duk_require_heapptr (ctx, -1);
  duk_put_global_string (ctx, "File");
  // []
}

void
_gum_duk_file_dispose (GumDukFile * self)
{
  _gumjs_duk_release_heapptr (self->core->ctx, self->file);
}

void
_gum_duk_file_finalize (GumDukFile * self)
{
  (void) self;
}

GUMJS_DEFINE_CONSTRUCTOR (gumjs_file_construct)
{
  gchar * filename = NULL;
  gchar * mode = NULL;
  FILE * handle;
  GumFile * file;

  if (!_gumjs_args_parse (ctx, "ss", &filename, &mode))
    goto beach;

  handle = fopen (filename, mode);
  if (handle == NULL)
    goto open_failed;

  file = g_slice_new (GumFile);
  file->handle = handle;

  _gumjs_set_private_data (ctx, _gumjs_duk_get_this (ctx), file);

  goto beach;

open_failed:
  {
    _gumjs_throw (ctx, "failed to open file (%s)", strerror (errno));
    goto beach;
  }
beach:
  {
    return 0;
  }
}

GUMJS_DEFINE_FINALIZER (gumjs_file_finalize)
{
  if (_gumjs_is_arg0_equal_to_prototype (ctx, "File"))
    return 0;

  GumFile * file = GUMJS_FILE (_gumjs_duk_get_this (ctx));

  gum_file_close (file);

  g_slice_free (GumFile, file);
  return 0;
}

static gboolean
gum_file_check_open (GumFile * self,
                     duk_context * ctx)
{
  if (self->handle == NULL)
  {
    _gumjs_throw (ctx, "file is closed");
    return FALSE;
  }

  return TRUE;
}

static void
gum_file_close (GumFile * self)
{
  g_clear_pointer (&self->handle, fclose);
}

GUMJS_DEFINE_FUNCTION (gumjs_file_write)
{
  GumFile * self;
  GumDukValue * value;
  GBytes * bytes;

  self = GUMJS_FILE (_gumjs_duk_get_this (ctx));

  if (!_gumjs_args_parse (ctx, "V", &value))
  {
    duk_push_null (ctx);
    return 1;
  }

  if (!gum_file_check_open (self, ctx))
  {
    duk_push_null (ctx);
    return 1;
  }

  if (value->type == DUK_TYPE_STRING)
  {
    fwrite (value->data._string, strlen (value->data._string), 1, self->handle);
  }
  else if (_gumjs_byte_array_try_get (ctx, value, &bytes))
  {
    gconstpointer data;
    gsize size;

    data = g_bytes_get_data (bytes, &size);
    fwrite (data, size, 1, self->handle);

    g_bytes_unref (bytes);
  }
  else
  {
    goto invalid_argument;
  }

  g_free (value);
  duk_push_undefined (ctx);
  return 1;

invalid_argument:
  {
    g_free (value);
    _gumjs_throw (ctx, "argument must be a string or byte array");
    duk_push_null (ctx);
    return 1;
  }
}

GUMJS_DEFINE_FUNCTION (gumjs_file_flush)
{
  GumFile * self = GUMJS_FILE (_gumjs_duk_get_this (ctx));

  if (!gum_file_check_open (self, ctx))
  {
    duk_push_null (ctx);
    return 1;
  }

  fflush (self->handle);

  duk_push_undefined (ctx);
  return 1;
}

GUMJS_DEFINE_FUNCTION (gumjs_file_close)
{
  GumFile * self = GUMJS_FILE (_gumjs_duk_get_this (ctx));

  if (!gum_file_check_open (self, ctx))
  {
    duk_push_null (ctx);
    return 1;
  }

  gum_file_close (self);

  duk_push_undefined (ctx);
  return 1;
}
