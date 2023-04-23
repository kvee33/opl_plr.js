// opl_plr.js by kvee

/*
 * MIT License
 * 
 * Copyright (c) 2023 kvee
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/*
 * Requires an OPL3 emulator script to be loaded prior to loading this script.
 * Right now it targets Emscripten-compiled code that exposes the following API functions / arrays:
 * - void opl3_reset(uint32_t samplerate)
 * - void opl3_write(uint16_t reg, uint8_t data)
 * - void opl3_render()
 * - int16_t *opl3_buf_ptr()
 *     This buffer points to a static memory location containing current samples after calling opl3_render();
 * - HEAP16
 *     The memory array samples are gathered from
 * 
 * The emulator should be returned as a constructor function called OPL3 that returns an object with these functions / arrays.
 */

function opl_plr() {
    var plr = {
        context: null,
        ptr: null,
        soundData: null,
        queuedSoundData: null,
        dataIndex: 0,
        samplePosition: 0,
        afterSeek: false,
        softStop: 0,
        opl3: null,
    };

    function loadSoundData(soundData) {
        // 2xOPL2 -> OPL3
        if (soundData.dualOpl2Mode) {
            // Process relevant register writes
            soundData.commands = soundData.commands.map(c => {
                if (// Command writes into a relevant register...
                    ((c.r & 0xFF) >= 0xC0 && (c.r & 0xFF) <= 0xC8)
                    // ...that has all channel bits off
                    // (which means it's likely just plain OPL2 data as expected)
                    && (c.v & 0xF0) == 0)
                    // Set channel bits for OPL3 playback
                    c.v |= (c.r < 0x100 ? 0x10 : 0x20);

                return c;
            });

            // Enable NEW for stereo
            soundData.commands.unshift({ t: 0, r: 0x105, v: 1 });
        }

        plr.queuedSoundData = soundData;
    }

    function processImf(imfData, imfRate) {
        var soundData = {
            commands: [],
            cmdRate: imfRate
        };
        var arr = new Uint8Array(imfData);

        console.debug("IMF file rate:", imfRate);

        var time = 0;
        var length = arr[0] | (arr[1] << 8);
        var extraSearch = arr[2] | (arr[3] << 8);
        var startOffset = 2;

        if (length == 0) {
            length = arr.byteLength;
            startOffset = extraSearch == 0 ? 0 : 2;
        }

        for (var i = startOffset; i < length; i += 4) {
            soundData.commands.push({ t: time, r: arr[i], v: arr[i + 1] });
            time += arr[i + 2] | (arr[i + 3] << 8);
        }

        return soundData;
    };

    function processRaw(rawData) {
        const pitFreq = 14318180 / 12;
        var soundData = {
            commands: [],
            cmdRate: pitFreq
        };
        var arr = new Uint8Array(rawData);

        const get16 = i => arr[i] | (arr[i + 1] << 8);
        const get32 = i => arr[i] | (arr[i + 1] << 8) | (arr[i + 2] << 16) | (arr[i + 3] << 24);

        if (get32(0) != 0x41574152 /* "RAWA" */
            && get32(4) != 0x41544144 /* "DATA" */) {
            console.error("Not a RAW file: Bad file identifier!");
            return soundData;
        }

        console.debug("RAW file");

        var time = 0;
        var clock = get16(8);
        var regOffset = 0;
        for (var i = 10; i < arr.byteLength; i += 2) {
            const r = arr[i + 1];
            const v = arr[i];
            if (r == 0) {
                time += v * clock;
                continue;
            }
            else if (r == 2) {
                if (v == 0) {
                    // Clock change.
                    i += 2;
                    clock = get16(i);
                }
                else if (v == 1) {
                    // Set low chip / p0
                    regOffset = 0;
                }
                else if (v == 2) {
                    // Set high chip / p1
                    regOffset = 0x100;
                }
                continue;
            }
            else {
                soundData.commands.push({ t: time, r: r | regOffset, v: v });
            }
        }

        return soundData;
    };

    function processDro(droData) {
        var soundData = {
            commands: [],
            cmdRate: 1000,
            dualOpl2Mode: false
        };
        var arr = new Uint8Array(droData);

        const get16 = i => arr[i] | (arr[i + 1] << 8);
        const get32 = i => arr[i] | (arr[i + 1] << 8) | (arr[i + 2] << 16) | (arr[i + 3] << 24);

        if (get32(0) != 0x41524244 /* "DBRA" */
            && get32(4) != 0x4C504F57 /* "WOPL" */) {
            console.error("Not a DRO file: Bad file identifier!");
            return soundData;
        }

        const version = get16(8).toString(16) + "." + get16(10).toString(16);

        console.debug("DRO file version:", version == "0.1" ? 1.0 : +version);

        if (version < 2) {
            const hardware = arr[0x14];
            switch (hardware) {
                case 0:
                    console.debug("Chip type: OPL2");
                    break;
                case 1:
                    console.debug("Chip type: OPL3");
                    break;
                case 2:
                    console.debug("Chip type: Dual OPL2");
                    soundData.dualOpl2Mode = true;
                    break;
                default:
                    console.debug("Unknown chip type!");
                    return soundData;
            }
            const dataOffset = (get32(0x14) - hardware == 0) ? 0x18 : 0x15;

            var time = 0;
            var regOffset = 0;
            for (var i = dataOffset; i < arr.byteLength; i++) {
                const r = arr[i];
                switch (r) {
                    // Delay D
                    case 0:
                        time += arr[i + 1] + 1;
                        i++;
                        break;

                    // Delay Dl, Dh
                    case 1:
                        time += (arr[i + 1] | (arr[i + 2] << 8)) + 1;
                        i += 2;
                        break;

                    // Set low chip / p0
                    case 2:
                        regOffset = 0;
                        break;

                    // Set high chip / p1
                    case 3:
                        regOffset = 0x100;
                        break;

                    // Register escape: [E], R, V
                    case 4:
                        soundData.commands.push({ t: time, r: arr[i + 1] | regOffset, v: arr[i + 2] });
                        i += 2;
                        break;

                    // R, V
                    default:
                        soundData.commands.push({ t: time, r: r | regOffset, v: arr[i + 1] });
                        i++;
                        break;
                }
            }

            return soundData;
        }
        else if (version == 2) {
            //0x12
            const hardware = arr[0x14];
            switch (hardware) {
                case 0:
                    console.debug("Chip type: OPL2");
                    break;
                case 1:
                    console.debug("Chip type: Dual OPL2");
                    soundData.dualOpl2Mode = true;
                    break;
                case 2:
                    console.debug("Chip type: OPL3");
                    break;
                default:
                    console.debug("Unknown chip type!");
                    return soundData;
            }

            const format = arr[0x15];
            if (format != 0) {
                console.error("Only interleaved mode is supported!");
                return soundData;
            }

            const compression = arr[0x16];
            if (compression != 0) {
                console.error("Only uncompressed data is supported!");
                return soundData;
            }

            const shortDelayCode = arr[0x17];
            const longDelayCode = arr[0x18];
            const codemapLength = arr[0x19];
            var codes = [];
            for (var i = 0; i < codemapLength; i++)
                codes[i] = arr[0x1A + i];

            var time = 0;
            for (var i = 0x1A + codemapLength; i < arr.byteLength; i++) {
                const r = arr[i];
                switch (r) {
                    // Delay D
                    case shortDelayCode:
                        time += arr[i + 1] + 1;
                        i++;
                        break;

                    // 256x delay D
                    case longDelayCode:
                        time += (arr[i + 1] + 1) << 8;
                        i++;
                        break;

                    // R, V
                    default:
                        const rc = (r & 0x80) ? 0x100 | codes[r & 0x7F] : codes[r];
                        soundData.commands.push({ t: time, r: rc, v: arr[i + 1] });
                        i++;
                        break;
                }
            }

            return soundData;
        } else {
            console.error("DRO version", +version, "playback not supported!");
            return soundData;
        }
    };

    function processVgm(vgmData, loopRepeat) {
        var soundData = {
            commands: [],
            cmdRate: 44100,
            dualOpl2Mode: false
        };
        var arr = new Uint8Array(vgmData);

        const get32 = i => arr[i] | (arr[i + 1] << 8) | (arr[i + 2] << 16) | (arr[i + 3] << 24);

        if (get32(0) != 0x206D6756 /* "Vgm " */) {
            console.error("Not a VGM file: Bad file identifier!");
            return soundData;
        }

        const version = get32(8).toString(16);
        const dataOffset = version < 150 ? 0x40 : 0x34 + get32(0x34);

        console.debug("VGM file version:", +(version / 100).toFixed(2), "data offset:", dataOffset)

        var loopOffset = get32(0x1C);
        if (loopOffset)
            loopOffset += 0x1C;
        const loopCount = get32(0x20);
        if (loopCount)
            console.debug("Loop present:", loopCount, "@", loopOffset);

        const clockOpl2 = get32(0x50) & 0x3FFFFFFF;
        const clockOpl3 = get32(0x5C) & 0x3FFFFFFF;
        if (clockOpl2 == 3579545)
            console.debug("OPL2 detected:", clockOpl2, "Hz", "(standard clock rate)");
        else if (clockOpl2)
            console.debug("OPL2 detected:", clockOpl2, "Hz");
        if (clockOpl3 == 14318180)
            console.debug("OPL3 detected:", clockOpl3, "Hz", "(standard clock rate)");
        else if (clockOpl3)
            console.debug("OPL3 detected:", clockOpl3, "Hz");

        const dualOpl2 = get32(0x50) & 0x40000000;
        const dualOpl3 = get32(0x5C) & 0x40000000;
        if (dualOpl2) {
            console.debug("Dual OPL2 mode!");
            soundData.dualOpl2Mode = true;
        }
        if (dualOpl3) {
            console.error("Dual OPL3 mode not supported!");
            return soundData;
        }

        if (clockOpl2 && clockOpl3) {
            console.error("Combined OPL2 and OPL3 playback not supported!");
            return soundData;
        }

        var time = 0;
        for (var loop = 0; loop < (loopCount ? (1 + (loopRepeat ?? 1)) : 1); loop++) {
            var start = loop == 0 ? dataOffset : loopOffset;
            for (var i = start; i < arr.byteLength; i++) {
                if (arr[i] >= 0x70 && arr[i] <= 0x7F) {
                    // Delay D
                    time += arr[i] & 0x0F;
                }
                else switch (arr[i]) {
                    case 0x5A:
                        // YM3812 R, V
                        soundData.commands.push({ t: time, r: arr[i + 1], v: arr[i + 2] });
                        i += 2;
                        break;

                    case 0x5B:
                        // YM3526 R, V
                        soundData.commands.push({ t: time, r: arr[i + 1], v: arr[i + 2] });
                        i += 2;
                        break;

                    case 0x5E:
                        // YMF262 p0R, V
                        soundData.commands.push({ t: time, r: arr[i + 1], v: arr[i + 2] });
                        i += 2;
                        break;

                    case 0xAA:
                    // YM3812#2 R, V
                    // Stored in YMF262 p1. Only allowed because the OPL2 + OPL3 combination is forbidden!
                    // case fall-through!
                    case 0x5F:
                        // YMF262 p1R, V
                        soundData.commands.push({ t: time, r: 0x100 | arr[i + 1], v: arr[i + 2] });
                        i += 2;
                        break;

                    case 0x61:
                        // Delay Dl, Dh
                        time += arr[i + 1] | (arr[i + 2] << 8);
                        i += 2;
                        break;

                    case 0x62:
                        // Delay 735
                        time += 735;
                        break;

                    case 0x63:
                        // Delay 882
                        time += 882;
                        break;

                    case 0x66:
                        // End of sound data
                        i = arr.byteLength;
                        break;

                    default:
                        console.error("Unknown command", arr[i].toString(16), "at offset", i);
                        return;
                }
            }
        }
        return soundData;
    };

    function isPlaying() {
        return plr.context?.state == "running" && plr.softStop == 0;
    }

    function play() {
        if (!isPlaying()
            // We have data queued
            && plr.queuedSoundData?.commands.length > 0
            // Or have current valid data
            || (plr.soundData?.commands.length > 0 && plr.dataIndex < plr.soundData.commands.length)) {
            plr.softStop = 0;
            return plr.context.resume();
        }
        else
            return Promise.resolve();
    }

    function stop() {
        plr.softStop = 1;
    }

    function getPlaybackTime() {
        return plr.samplePosition / (plr.context?.sampleRate ?? 1);
    }

    function getTotalTime() {
        if (!plr.soundData?.commands || plr.soundData.commands.length == 0)
            return 0;

        return plr.soundData.commands[plr.soundData.commands.length - 1].t / plr.soundData.cmdRate;
    }

    function seek(time) {
        if (!plr.soundData?.commands)
            return;

        // Time in sound data units
        const adjTime = time * plr.soundData.cmdRate;

        plr.opl3.reset(plr.context.sampleRate);
        plr.dataIndex = 0;
        var registerData = [];
        while (plr.dataIndex < plr.soundData.commands.length
            && plr.soundData.commands[plr.dataIndex].t < adjTime) {
            const command = plr.soundData.commands[plr.dataIndex++];
            registerData[command.r] = command.v;
        }
        // Write possible NEW first, if applicable
        if (registerData[0x105])
            plr.opl3.write(0x105, registerData[0x105]);
        for (const r in registerData)
            plr.opl3.write(r, registerData[r]);

        if (plr.dataIndex < plr.soundData.commands.length) {
            plr.samplePosition = time * plr.context.sampleRate;
            plr.afterSeek = true;
        }
        else
            stop();
    }

    function init() {
        const opl3 = plr.opl3 = new OPL3();

        function soundInit() {
            plr.context = new window.AudioContext();

            var proc = plr.context.createScriptProcessor(0, 0, 2);
            proc.onaudioprocess = function (e) {
                var out = e.outputBuffer;
                var outd = [out.getChannelData(0), out.getChannelData(1)];

                if (plr.queuedSoundData) {
                    plr.soundData = plr.queuedSoundData;
                    plr.queuedSoundData = null;
                    plr.dataIndex = 0;
                    plr.samplePosition = 0;
                    opl3.reset(plr.context.sampleRate);
                }

                if (!plr.soundData || plr.softStop > 0) {
                    for (var sample = 0; sample < proc.bufferSize; sample++)
                        outd[0][sample] = outd[1][sample] = 0;
                    if (plr.softStop++ == 4) {
                        plr.context.suspend();
                        plr.softStop = 0;
                    }
                    return;
                }

                if (plr.afterSeek) {
                    plr.samplePosition = proc.bufferSize * Math.floor(plr.samplePosition / proc.bufferSize);
                    plr.afterSeek = false;
                }

                const rateFactor = plr.soundData.cmdRate / plr.context.sampleRate;

                for (var sample = 0; sample < proc.bufferSize; sample++) {
                    while (plr.dataIndex < plr.soundData.commands.length
                        && plr.soundData.commands[plr.dataIndex].t <= plr.samplePosition * rateFactor) {
                        const command = plr.soundData.commands[plr.dataIndex++];
                        opl3.write(command.r, command.v);
                    }
                    if (plr.dataIndex == plr.soundData.commands.length)
                        stop();
                    else
                        plr.samplePosition++;

                    opl3.render();

                    outd[0][sample] = opl3.HEAP16[plr.ptr / 2 + 0] / 32768;
                    outd[1][sample] = opl3.HEAP16[plr.ptr / 2 + 1] / 32768;
                }
            }

            var gain = plr.context.createGain();
            proc.connect(gain);
            gain.connect(plr.context.destination);
            gain.gain.value = 1;
        }

        soundInit();

        opl3.reset(plr.context.sampleRate);
        plr.ptr = opl3.buf_ptr();
    }

    init();

    return {
        processImf,
        processRaw,
        processDro,
        processVgm,
        loadSoundData,

        isPlaying,
        getPlaybackTime,
        getTotalTime,

        play,
        stop,
        seek
    };
}
