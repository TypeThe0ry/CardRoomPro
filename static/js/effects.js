/* =====================================================================
 * 雀阁 · 特效与音效引擎 (FX)
 * 纯 Web Audio API 合成 + DOM/CSS 动画，无外部资源
 * 全局对象：window.FX
 *   FX.unlock()            // 首次用户交互后解锁音频
 *   FX.play(typeKey, ctx)  // 根据牌型 key 触发音效+视效
 *   FX.flash(text, opt)    // 单独打出特效大字
 *   FX.beep(name)          // 单独触发指定音效
 *   FX.muted (bool)        // 静音开关
 * ===================================================================== */
(function (global) {
  'use strict';

  // —— 牌型 → 特效预设 ——
  // 类型来自 core-validator 返回的 type 字段 (A / AA / AAA / AAAA / KING /
  // AAAB / AAABB / ABCDE / AABBCC / AAABBB / AAAABC / AAAABBCC)
  var PRESETS = {
    KING:     { kind: 'king',    label: '王 炸',  cls: 'fx-king',     sound: 'bomb-king', shake: 'strong' },
    AAAA:     { kind: 'bomb',    label: '炸 弹',  cls: 'fx-bomb',     sound: 'bomb',      shake: 'medium' },
    AAAABC:   { kind: 'bomb',    label: '四带二', cls: 'fx-bomb-soft',sound: 'bomb',      shake: 'medium' },
    AAAABBCC: { kind: 'bomb',    label: '四带二对',cls: 'fx-bomb-soft',sound: 'bomb',     shake: 'medium' },
    AAABBB:   { kind: 'plane',   label: '飞 机',  cls: 'fx-plane',    sound: 'plane',     shake: 'soft' },
    AAABB:    { kind: 'plane',   label: '飞机带翼',cls: 'fx-plane',   sound: 'plane',     shake: 'soft' },
    ABCDE:    { kind: 'straight',label: '顺 子',  cls: 'fx-straight', sound: 'straight',  shake: 'soft' },
    AABBCC:   { kind: 'pair',    label: '连 对',  cls: 'fx-pair',     sound: 'pair',      shake: 'soft' },
    AAA:      { kind: 'soft',    label: '三 张',  cls: 'fx-soft',     sound: 'play',      shake: 'none' },
    AAAB:     { kind: 'soft',    label: '三带一', cls: 'fx-soft',     sound: 'play',      shake: 'none' },
    AA:       { kind: 'tap',     label: '',       cls: 'fx-tap',      sound: 'play',      shake: 'none' },
    A:        { kind: 'tap',     label: '',       cls: 'fx-tap',      sound: 'play',      shake: 'none' },
    PASS:     { kind: 'tap',     label: '不 出',  cls: 'fx-pass',     sound: 'pass',      shake: 'none' }
  };

  // ============================================================
  // 音频合成
  // ============================================================
  var ctx = null;
  var masterGain = null;
  var unlocked = false;

  function ensureCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.45;
      masterGain.connect(ctx.destination);
    }
    return ctx;
  }

  function unlock() {
    var c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') {
      c.resume().catch(function () {});
    }
    unlocked = true;
  }

  function envelope(node, t0, attack, decay, sustain, release, peak) {
    peak = peak == null ? 1 : peak;
    var g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak,           t0 + attack);
    g.exponentialRampToValueAtTime(peak * sustain, t0 + attack + decay);
    g.exponentialRampToValueAtTime(0.0001,         t0 + attack + decay + release);
  }

  function playTone(freq, dur, opt) {
    var c = ensureCtx(); if (!c || FX.muted) return;
    opt = opt || {};
    var t0 = c.currentTime + (opt.delay || 0);
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = opt.wave || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opt.glide) {
      osc.frequency.exponentialRampToValueAtTime(opt.glide, t0 + dur);
    }
    osc.connect(gain).connect(masterGain);
    envelope(gain, t0, opt.attack || 0.005, opt.decay || 0.05,
             opt.sustain || 0.5, opt.release || dur, opt.peak || 0.6);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // 噪声爆破（鼓声/炸响）
  function playNoise(dur, opt) {
    var c = ensureCtx(); if (!c || FX.muted) return;
    opt = opt || {};
    var t0 = c.currentTime + (opt.delay || 0);
    var len = Math.max(1, Math.floor(c.sampleRate * dur));
    var buf = c.createBuffer(1, len, c.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = c.createBufferSource();
    src.buffer = buf;
    var biquad = c.createBiquadFilter();
    biquad.type = opt.filterType || 'lowpass';
    biquad.frequency.value = opt.filter || 800;
    var gain = c.createGain();
    gain.gain.value = opt.peak || 0.5;
    src.connect(biquad).connect(gain).connect(masterGain);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // 钟磬（多泛音叠加）
  function playBell(freq, dur) {
    var harmonics = [1, 2.0, 2.76, 5.4];
    var amps      = [0.6, 0.35, 0.18, 0.08];
    for (var i = 0; i < harmonics.length; i++) {
      playTone(freq * harmonics[i], dur * (1 - i * 0.1), {
        wave: 'sine',
        attack: 0.003, decay: 0.2,
        sustain: 0.3, release: dur, peak: amps[i]
      });
    }
  }

  // —— 命名音效 ——
  var SOUNDS = {
    play: function () {
      playTone(720, 0.18, { wave: 'triangle', attack: 0.003, decay: 0.06, sustain: 0.2, release: 0.18, peak: 0.35 });
    },
    pass: function () {
      playTone(360, 0.18, { wave: 'sine', glide: 220, attack: 0.005, decay: 0.05, sustain: 0.25, release: 0.18, peak: 0.3 });
    },
    pair: function () {
      playTone(660, 0.16, { wave: 'triangle', peak: 0.32 });
      playTone(880, 0.20, { wave: 'triangle', delay: 0.08, peak: 0.32 });
    },
    straight: function () {
      // 五声音阶上行
      var scale = [392, 440, 523, 587, 659, 784];
      for (var i = 0; i < scale.length; i++) {
        playTone(scale[i], 0.12, { wave: 'triangle', delay: i * 0.06, peak: 0.3 });
      }
    },
    plane: function () {
      // 多普勒呼啸
      playTone(180, 0.55, { wave: 'sawtooth', glide: 980, attack: 0.02, decay: 0.1, sustain: 0.7, release: 0.4, peak: 0.28 });
      playTone(120, 0.55, { wave: 'sine',     glide: 60,  attack: 0.05, decay: 0.1, sustain: 0.5, release: 0.4, peak: 0.22 });
      playNoise(0.45, { filter: 1600, filterType: 'bandpass', peak: 0.18, delay: 0.05 });
    },
    bomb: function () {
      playNoise(0.45, { filter: 220, peak: 0.7 });
      playTone(80, 0.5, { wave: 'sine', glide: 35, attack: 0.001, decay: 0.05, sustain: 0.6, release: 0.45, peak: 0.55 });
      playTone(160, 0.35, { wave: 'square', delay: 0.02, attack: 0.002, decay: 0.04, sustain: 0.4, release: 0.3, peak: 0.32 });
    },
    'bomb-king': function () {
      // 雷霆+钟磬
      playNoise(0.7, { filter: 180, peak: 0.85 });
      playTone(60, 0.85, { wave: 'sine', glide: 28, peak: 0.7, release: 0.8 });
      playBell(523, 1.4);
      playBell(392, 1.4);
      playTone(1320, 0.5, { wave: 'triangle', delay: 0.25, peak: 0.4, release: 0.5 });
    },
    win: function () {
      var notes = [523, 659, 784, 1046];
      for (var i = 0; i < notes.length; i++) {
        playTone(notes[i], 0.4, { wave: 'triangle', delay: i * 0.12, peak: 0.4 });
      }
      playBell(1046, 1.6);
    },
    lose: function () {
      var notes = [523, 466, 392, 311];
      for (var i = 0; i < notes.length; i++) {
        playTone(notes[i], 0.45, { wave: 'sine', delay: i * 0.15, peak: 0.32 });
      }
    },
    chip: function () {
      playTone(1320, 0.05, { wave: 'square', peak: 0.18 });
    },
    deal: function () {
      playNoise(0.18, { filter: 3200, filterType: 'highpass', peak: 0.22 });
    },
    call: function () {
      playTone(880, 0.18, { wave: 'triangle', peak: 0.34 });
      playTone(1320, 0.18, { wave: 'triangle', delay: 0.06, peak: 0.28 });
    },
    tick: function () {
      playTone(1500, 0.04, { wave: 'square', peak: 0.16 });
    }
  };

  function beep(name) {
    var fn = SOUNDS[name];
    if (fn) try { fn(); } catch (e) {}
  }

  // ============================================================
  // 视觉特效
  // ============================================================
  var stage = null;
  function ensureStage() {
    if (stage && document.body.contains(stage)) return stage;
    stage = document.createElement('div');
    stage.className = 'fx-stage';
    document.body.appendChild(stage);
    return stage;
  }

  function shake(level) {
    if (level === 'none' || !level) return;
    var el = document.body;
    el.classList.remove('fx-shake-soft', 'fx-shake-medium', 'fx-shake-strong');
    // reflow
    void el.offsetWidth;
    el.classList.add('fx-shake-' + level);
    setTimeout(function () { el.classList.remove('fx-shake-' + level); }, 600);
  }

  function flash(text, opt) {
    opt = opt || {};
    var s = ensureStage();
    var node = document.createElement('div');
    node.className = 'fx-burst ' + (opt.cls || '');
    if (text) {
      var span = document.createElement('span');
      span.className = 'fx-burst-text';
      span.textContent = text;
      node.appendChild(span);
    }
    if (opt.kind === 'plane') {
      // 加几个流光粒子
      for (var i = 0; i < 5; i++) {
        var p = document.createElement('i');
        p.className = 'fx-plane-streak';
        p.style.top = (20 + i * 12) + '%';
        p.style.animationDelay = (i * 60) + 'ms';
        node.appendChild(p);
      }
    }
    if (opt.kind === 'bomb' || opt.kind === 'king') {
      var ring = document.createElement('i');
      ring.className = 'fx-shockwave';
      node.appendChild(ring);
      if (opt.kind === 'king') {
        var ring2 = document.createElement('i');
        ring2.className = 'fx-shockwave fx-shockwave-2';
        node.appendChild(ring2);
      }
    }
    if (opt.kind === 'straight') {
      var rib = document.createElement('i');
      rib.className = 'fx-ribbon';
      node.appendChild(rib);
    }
    s.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, opt.life || 1400);
  }

  // 主入口：根据 type 派发
  function play(typeKey, info) {
    var preset = PRESETS[typeKey] || PRESETS.A;
    if (info && info.isPass) preset = PRESETS.PASS;
    flash(preset.label, { cls: preset.cls, kind: preset.kind });
    shake(preset.shake);
    beep(preset.sound);
  }

  var FX = {
    PRESETS: PRESETS,
    muted: false,
    unlock: unlock,
    play: play,
    flash: flash,
    beep: beep,
    setMuted: function (v) { this.muted = !!v; },
    isUnlocked: function () { return unlocked; }
  };

  // 首次任意点击/键入解锁音频（浏览器策略）
  function bindUnlock() {
    var fn = function () {
      unlock();
      window.removeEventListener('click', fn, true);
      window.removeEventListener('keydown', fn, true);
      window.removeEventListener('touchstart', fn, true);
    };
    window.addEventListener('click', fn, true);
    window.addEventListener('keydown', fn, true);
    window.addEventListener('touchstart', fn, true);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindUnlock);
    } else { bindUnlock(); }
  }

  global.FX = FX;
})(typeof window !== 'undefined' ? window : this);
