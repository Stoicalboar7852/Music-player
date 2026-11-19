/*
 * A stand-in for the NDI Runtime, for tests: the same C entry points Phosphor
 * calls (desktop/ndi.mjs), written from NDI's public API documentation, which
 * record what they are given instead of sending anything.
 *
 *   cc -shared -fPIC -o libfake-ndi.so fake-ndi.c
 *
 * Like the real runtime, NDIlib_send_send_video_async_v2 keeps using a
 * frame's memory until the next call: if the caller changes that memory too
 * early, the frame is counted as corrupt. With FAKE_NDI_STATS set, the stats
 * are also written to that file after every frame (for the Electron test,
 * which can't call into the app's process).
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  const char *p_ndi_name;
  const char *p_groups;
  bool clock_video;
  bool clock_audio;
} fake_send_create_t;

typedef struct {
  int xres, yres;
  int FourCC;
  int frame_rate_N, frame_rate_D;
  float picture_aspect_ratio;
  int frame_format_type;
  int64_t timecode;
  uint8_t *p_data;
  union {
    int line_stride_in_bytes;
    int data_size_in_bytes;
  };
  const char *p_metadata;
  int64_t timestamp;
} fake_video_frame_v2_t;

static int64_t initialized, created, frames, flushes, corrupt, destroyed_senders, clock_video;
static char name[256];
static fake_video_frame_v2_t last;
static int64_t first_pixel, brightness;
static const uint8_t *pending;
static size_t pending_size;
static uint32_t pending_sum;
static int sender_token;

static uint32_t checksum(const uint8_t *p, size_t n) {
  uint32_t s = 2166136261u;
  for (size_t i = 0; i < n; i++) {
    s ^= p[i];
    s *= 16777619u;
  }
  return s;
}

static void check_pending(void) {
  if (pending && checksum(pending, pending_size) != pending_sum) corrupt++;
  pending = NULL;
}

static void write_stats(void) {
  const char *file = getenv("FAKE_NDI_STATS");
  if (!file) return;
  FILE *f = fopen(file, "w");
  if (!f) return;
  fprintf(f, "{\"frames\":%lld,\"width\":%d,\"height\":%d,\"fourcc\":%d,\"stride\":%d,\"rateN\":%d,\"rateD\":%d,\"corrupt\":%lld,\"brightness\":%lld,\"name\":\"%s\"}\n",
          (long long)frames, last.xres, last.yres, last.FourCC, last.line_stride_in_bytes, last.frame_rate_N, last.frame_rate_D, (long long)corrupt,
          (long long)brightness, name);
  fclose(f);
}

bool NDIlib_initialize(void) {
  initialized++;
  return true;
}

void NDIlib_destroy(void) {}

const char *NDIlib_version(void) { return "Fake NDI 6.0"; }

void *NDIlib_send_create(const fake_send_create_t *settings) {
  created++;
  strncpy(name, settings && settings->p_ndi_name ? settings->p_ndi_name : "", sizeof name - 1);
  clock_video = settings ? settings->clock_video : -1;
  return &sender_token;
}

void NDIlib_send_destroy(void *instance) {
  if (instance == &sender_token) destroyed_senders++;
}

void NDIlib_send_send_video_async_v2(void *instance, const fake_video_frame_v2_t *frame) {
  (void)instance;
  check_pending();
  if (!frame) {
    flushes++;
    return;
  }
  frames++;
  last = *frame;
  pending = frame->p_data;
  pending_size = (size_t)frame->line_stride_in_bytes * (size_t)frame->yres;
  pending_sum = checksum(pending, pending_size);
  first_pixel = (int64_t)frame->p_data[0] | ((int64_t)frame->p_data[1] << 8) | ((int64_t)frame->p_data[2] << 16) | ((int64_t)frame->p_data[3] << 24);
  /* Average brightness (0..255) over every 97th pixel. */
  int64_t total = 0, count = 0;
  for (size_t i = 0; i + 3 < pending_size; i += 4 * 97) {
    total += (frame->p_data[i] + frame->p_data[i + 1] + frame->p_data[i + 2]) / 3;
    count++;
  }
  brightness = count ? total / count : 0;
  write_stats();
}

int NDIlib_send_get_no_connections(void *instance, uint32_t timeout_in_ms) {
  (void)instance;
  (void)timeout_in_ms;
  return 2;
}

/* For the tests. */
void fake_ndi_stats(int64_t *out) {
  out[0] = initialized;
  out[1] = created;
  out[2] = frames;
  out[3] = flushes;
  out[4] = corrupt;
  out[5] = last.xres;
  out[6] = last.yres;
  out[7] = last.FourCC;
  out[8] = last.line_stride_in_bytes;
  out[9] = last.frame_rate_N;
  out[10] = last.frame_rate_D;
  out[11] = last.frame_format_type;
  out[12] = last.timecode;
  out[13] = destroyed_senders;
  out[14] = (int64_t)(last.picture_aspect_ratio * 1000.0f + 0.5f);
  out[15] = first_pixel;
  out[16] = clock_video;
  out[17] = last.p_metadata == NULL;
  out[18] = last.timestamp;
}

const char *fake_ndi_name(void) { return name; }
