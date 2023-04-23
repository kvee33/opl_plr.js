/* Nuked OPL3 wrapper for easy Emscripted compilation / usage.
 * Licensed under the same license (LGPL 2.1 or later) as Nuked OPL3,
 * as is required.
 */
#include <emscripten.h>
#include "opl3.h"

int16_t sample_buf[4];
opl3_chip chip;

EMSCRIPTEN_KEEPALIVE void opl3_reset(uint32_t samplerate)
{
    OPL3_Reset(&chip, samplerate);
}

EMSCRIPTEN_KEEPALIVE void opl3_write(uint16_t reg, uint8_t data)
{
    OPL3_WriteRegBuffered(&chip, reg, data);
}

EMSCRIPTEN_KEEPALIVE void opl3_render()
{
    OPL3_Generate4ChResampled(&chip, &sample_buf[0]);
}

EMSCRIPTEN_KEEPALIVE int16_t *opl3_buf_ptr()
{
    return sample_buf;
}
