/* panasonic-cd-v1 */
(function () {
  "use strict";

  var IS_TOUCH = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  var IS_NARROW = Math.min(window.innerWidth, window.innerHeight) < 820;
  var IS_MOBILE = IS_TOUCH && IS_NARROW;

  var ALBUMS = [
    { id: "clementi", title: "Clementi", work: "Six Sonatinas  ·  Op.36 No.1 Andante", audio: "audio/01-clementi.mp3" },
    { id: "bach", title: "Bach", work: "WTC I  ·  Prelude & Fugue No.1  BWV 846", audio: "audio/02-bach.mp3" },
    { id: "beethoven", title: "Beethoven", work: "Minuets  ·  WoO 10 No.2 in G", audio: "audio/03-beethoven.mp3" },
    { id: "chopin", title: "Chopin", work: "Nocturnes  ·  Op.9 No.2 in E♭", audio: "audio/04-chopin.mp3" }
  ];

  var canvas = document.getElementById("c");
  var hintEl = document.getElementById("hint");
  var loadBar = document.getElementById("load-bar");
  var loadingEl = document.getElementById("loading");

  var renderer, scene, camera, clock;
  var pivot; // yaw/pitch orbit around look target
  var desk, player, rack;
  var cases = [];
  var mats = {};
  var tex = {};
  var envMap = null;

  var displayCanvas, displayCtx, displayTex;
  var bezelCanvas, bezelTex;
  var backCanvas, backTex;

  var audio = new Audio();
  audio.preload = "auto";
  audio.loop = false;
  var audioUnlocked = false;

  var state = {
    view: "far",
    busy: false,
    power: true,
    lid: 0,          // 0 closed, 1 open
    transport: "stop",
    pitch: 0,        // -1..1
    pitchOn: true,
    playerAlbum: null,
    held: null,
    heldOpen: false,
    handDisc: null,  // album id if a disc is floating
    hover: null
  };

  var lidPivot, wellGroup, clampMesh, jogMesh, pitchCap, spindle;
  var flLight;
  var discObjects = {}; // albumId -> cd group
  var clickables = [];

  var camRig = {
    farPos: new THREE.Vector3(0.22, 0.82, 1.22),
    farTarget: new THREE.Vector3(0.04, 0.04, 0.02),
    nearPos: new THREE.Vector3(0.06, 0.40, 0.64),
    nearTarget: new THREE.Vector3(0.02, 0.10, 0.00),
    pos: new THREE.Vector3(0.22, 0.82, 1.22),
    target: new THREE.Vector3(0.04, 0.04, 0.02),
    yaw: 0,
    pitch: 0
  };

  var tweens = [];
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutBack(t) {
    var c1 = 1.2508, c2 = c1 * 1.525;
    return t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function tween(dur, fn, done, ease) {
    ease = ease || easeInOut;
    var tw = { t: 0, dur: dur, fn: fn, done: done, ease: ease };
    tweens.push(tw);
    return tw;
  }
  function tickTweens(dt) {
    for (var i = tweens.length - 1; i >= 0; i--) {
      var tw = tweens[i];
      tw.t += dt;
      var u = Math.min(1, tw.t / tw.dur);
      tw.fn(tw.ease(u), u);
      if (u >= 1) {
        tweens.splice(i, 1);
        if (tw.done) tw.done();
      }
    }
  }
  function tweenVec3(v, to, dur, ease, done) {
    var from = v.clone();
    return tween(dur, function (k) { v.lerpVectors(from, to, k); }, done, ease);
  }
  function tweenRotX(obj, to, dur, ease, done) {
    var from = obj.rotation.x;
    return tween(dur, function (k) { obj.rotation.x = lerp(from, to, k); }, done, ease);
  }
  function tweenRotY(obj, to, dur, ease, done) {
    var from = obj.rotation.y;
    return tween(dur, function (k) { obj.rotation.y = lerp(from, to, k); }, done, ease);
  }
  function runSeq(steps, done) {
    var i = 0;
    function next() {
      if (i >= steps.length) { if (done) done(); return; }
      var step = steps[i++];
      step(next);
    }
    next();
  }

  function setHint(s) { hintEl.textContent = s; }

  function updateHint() {
    if (state.view === "far") {
      setHint("点击机身靠近  ·  点击珠宝盒拿起打开  ·  放入播放");
      return;
    }
    if (state.handDisc) {
      setHint("点击空盒放回碟片  ·  或点进机舱放入播放");
      return;
    }
    if (state.held && !state.heldOpen) {
      setHint("点击盒子，打开盒盖");
      return;
    }
    if (state.held && state.heldOpen) {
      setHint(state.held.userData.hasDisc ? "点击碟片取出，放入播放" : "点击盒子合盖放回架子");
      return;
    }
    if (state.playerAlbum && state.transport === "play") {
      setHint(state.playerAlbum.work + "  ·  播放 / 暂停 / 开盖取碟");
      return;
    }
    if (state.playerAlbum) {
      setHint("点播放，或开盖取碟换下一张");
      return;
    }
    setHint("点击架子上的珠宝盒，拿起打开，取出放入播放");
  }

  /* ---------------- audio / sfx ---------------- */
  var actx = null;
  function ensureAudioCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === "suspended") actx.resume();
    return actx;
  }
  function sfxClick() {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 1900;
    g.gain.value = 0.03;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
    o.stop(ctx.currentTime + 0.06);
  }
  function sfxLid(open) {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var dur = 0.45;
    var buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.4);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = open ? 900 : 600;
    f.Q.value = 0.7;
    var g = ctx.createGain();
    g.gain.value = 0.08;
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start();
  }
  function sfxPlastic() {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = 420;
    g.gain.value = 0.05;
    o.connect(g); g.connect(ctx.destination);
    o.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.14);
    o.start(); o.stop(ctx.currentTime + 0.15);
  }

  function unlockAudioFromGesture() {
    ensureAudioCtx();
    if (!audioUnlocked) {
      audio.muted = true;
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
      audio.pause();
      audio.muted = false;
      audio.currentTime = 0;
      audioUnlocked = true;
    }
  }

  function applyPitch() {
    var rate = state.pitchOn ? (1 + state.pitch * 0.08) : 1;
    try { audio.playbackRate = rate; } catch (e) {}
  }

  function loadAlbumAudio(album) {
    if (audio.src.indexOf(album.audio) === -1) {
      audio.src = album.audio;
      audio.load();
    }
  }

  function startPlay() {
    if (!state.playerAlbum) return;
    loadAlbumAudio(state.playerAlbum);
    applyPitch();
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
    state.transport = "play";
    updateHint();
  }
  function pausePlay() {
    audio.pause();
    state.transport = "pause";
    updateHint();
  }
  function stopPlay() {
    audio.pause();
    try { audio.currentTime = 0; } catch (e) {}
    state.transport = "stop";
    updateHint();
  }

  audio.addEventListener("ended", function () {
    state.transport = "stop";
    updateHint();
  });

  /* ---------------- display FL ---------------- */
  function makeDisplay() {
    displayCanvas = document.createElement("canvas");
    displayCanvas.width = 1024;
    displayCanvas.height = 256;
    displayCtx = displayCanvas.getContext("2d");
    displayTex = new THREE.CanvasTexture(displayCanvas);
    displayTex.colorSpace = THREE.SRGBColorSpace;
    displayTex.anisotropy = 8;
    drawDisplay();
  }

  function drawSeg7(ctx, x, y, s, ch, on) {
    // s = segment size
    var w = s * 0.62, t = s * 0.14, h = s;
    var map = {
      "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
      "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
      "-": "g", " ": "", "A": "abcefg", "P": "abefg", "L": "def", "Y": "bcdfg"
    };
    var segs = map[ch] || "";
    ctx.save();
    ctx.translate(x, y);
    function seg(id, pts) {
      ctx.beginPath();
      pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
      ctx.closePath();
      if (segs.indexOf(id) >= 0 && on) {
        ctx.fillStyle = "rgba(160, 245, 255, 0.95)";
        ctx.shadowColor = "rgba(80, 220, 255, 0.95)";
        ctx.shadowBlur = 5;
        ctx.fill();
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(50, 110, 120, 0.28)";
        ctx.fill();
      }
    }
    var g = t * 0.35;
    seg("a", [[t, 0], [w - t, 0], [w - t - t, t], [t + t, t]]);
    seg("b", [[w, t], [w, h], [w - t, h - g], [w - t, t + t]]);
    seg("c", [[w, h + g], [w, h * 2 - t], [w - t, h * 2 - t * 2], [w - t, h + t]]);
    seg("d", [[t, h * 2], [w - t, h * 2], [w - t - t, h * 2 - t], [t + t, h * 2 - t]]);
    seg("e", [[0, h + g], [t, h + t], [t, h * 2 - t * 2], [0, h * 2 - t]]);
    seg("f", [[0, t], [t, t + t], [t, h - g], [0, h]]);
    seg("g", [[t, h], [t + t, h - t * 0.5], [w - t - t, h - t * 0.5], [w - t, h], [w - t - t, h + t * 0.5], [t + t, h + t * 0.5]]);
    ctx.restore();
  }

  function drawDisplay() {
    var ctx = displayCtx, w = displayCanvas.width, h = displayCanvas.height;
    ctx.fillStyle = "#05080b";
    ctx.fillRect(0, 0, w, h);
    // faint tube glass
    var grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "rgba(40,80,90,0.18)");
    grd.addColorStop(0.5, "rgba(10,20,24,0)");
    grd.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    if (!state.power) {
      displayTex.needsUpdate = true;
      return;
    }

    ctx.fillStyle = "rgba(120, 230, 245, 0.75)";
    ctx.font = "700 26px 'IBM Plex Mono', 'SF Mono', Menlo, monospace";
    ctx.shadowColor = "rgba(80,220,255,0.7)";
    ctx.shadowBlur = 6;
    ctx.fillText("TRACK", 40, 40);
    ctx.fillText("MIN  SEC", 300, 40);
    ctx.font = "600 18px 'IBM Plex Mono', Menlo, monospace";
    ctx.fillText("MUSIC CALENDAR", 40, 168);

    var track = "-";
    var mm = "--", ss = "--", tt = "-";
    if (state.playerAlbum) {
      track = "1";
      var total = audio.currentTime || 0;
      var m = Math.floor(total / 60);
      var sec = Math.floor(total % 60);
      var ten = Math.floor((total * 10) % 10);
      mm = (m < 10 ? "0" : "") + m;
      ss = (sec < 10 ? "0" : "") + sec;
      tt = "" + ten;
    }
    var on = true;
    drawSeg7(ctx, 40, 50, 48, track, on);

    function pair(x, str) {
      drawSeg7(ctx, x, 50, 48, str[0], on);
      drawSeg7(ctx, x + 44, 50, 48, str[1], on);
    }
    pair(280, mm);
    ctx.fillStyle = "rgba(170,250,255,0.95)";
    ctx.shadowBlur = 6;
    ctx.fillRect(378, 78, 7, 7);
    ctx.fillRect(378, 118, 7, 7);
    pair(400, ss);
    ctx.beginPath(); ctx.arc(500, 150, 5, 0, 6.3); ctx.fill();
    drawSeg7(ctx, 520, 50, 48, tt, on);

    // music calendar 1-20
    ctx.shadowBlur = 6;
    ctx.font = "600 18px 'IBM Plex Mono', Menlo, monospace";
    for (var i = 1; i <= 20; i++) {
      var lit = !!(state.playerAlbum && i === 1);
      var dim = !state.playerAlbum;
      ctx.fillStyle = lit ? "rgba(160,245,255,0.95)" : (dim ? "rgba(40,90,100,0.25)" : "rgba(40,90,100,0.25)");
      ctx.shadowBlur = lit ? 8 : 0;
      var col = (i - 1) % 10;
      var row = Math.floor((i - 1) / 10);
      ctx.fillText(String(i), 40 + col * 40, 196 + row * 28);
    }

    // status legends
    ctx.font = "700 18px 'IBM Plex Mono', Menlo, monospace";
    function legend(label, x, y, lit) {
      ctx.fillStyle = lit ? "rgba(160,245,255,0.95)" : "rgba(40,90,100,0.22)";
      ctx.shadowBlur = lit ? 8 : 0;
      ctx.fillText(label, x, y);
    }
    legend("PLAY", 780, 80, state.transport === "play");
    legend("PAUSE", 780, 112, state.transport === "pause");
    legend("STOP", 780, 144, state.transport === "stop" && !!state.playerAlbum);
    legend("PITCH", 780, 176, state.pitchOn);
    var pr = (state.pitch >= 0 ? "+" : "") + (state.pitch * 8).toFixed(1);
    legend(pr + "%", 780, 208, state.pitchOn && Math.abs(state.pitch) > 0.01);

    displayTex.needsUpdate = true;
  }

  function makeBezel() {
    bezelCanvas = document.createElement("canvas");
    bezelCanvas.width = 2048;
    bezelCanvas.height = 512;
    var ctx = bezelCanvas.getContext("2d");
    ctx.fillStyle = "#161618";
    ctx.fillRect(0, 0, 2048, 512);
    // subtle vertical grain
    var g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2048, 512);
    // left branding — kept in the middle band so a sloped crop still shows it
    ctx.fillStyle = "#f2efe8";
    ctx.font = "600 96px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("Technics", 48, 230);
    ctx.fillStyle = "#d0cbc3";
    ctx.font = "400 32px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("Compact Disc Player", 52, 290);
    ctx.fillText("SL-P1200", 52, 335);
    // power
    ctx.fillStyle = "#b0aaa2";
    ctx.font = "600 22px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("POWER", 60, 400);
    ctx.fillStyle = "#d8b25a";
    ctx.fillRect(160, 378, 7, 40);
    ctx.strokeStyle = "#4a4a4c";
    ctx.lineWidth = 3;
    ctx.strokeRect(148, 368, 80, 60);
    // display window cut (right two thirds)
    ctx.fillStyle = "#050608";
    roundRect(ctx, 620, 50, 1360, 410, 8);
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.stroke();
    bezelTex = new THREE.CanvasTexture(bezelCanvas);
    bezelTex.colorSpace = THREE.SRGBColorSpace;
    bezelTex.anisotropy = 8;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function makeBackPanel() {
    backCanvas = document.createElement("canvas");
    backCanvas.width = 1024;
    backCanvas.height = 256;
    var ctx = backCanvas.getContext("2d");
    ctx.fillStyle = "#121214";
    ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = "#d8d4cc";
    ctx.font = "600 36px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("Technics", 40, 70);
    ctx.fillStyle = "#8a8680";
    ctx.font = "500 16px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("LINE OUT", 40, 130);
    ctx.fillText("WIRED REMOTE", 220, 130);
    ctx.fillText("SUBCODE", 430, 130);
    ctx.fillText("AC IN", 860, 130);
    // RCA
    ctx.beginPath(); ctx.arc(55, 180, 14, 0, 6.3); ctx.fillStyle = "#c0452a"; ctx.fill();
    ctx.beginPath(); ctx.arc(95, 180, 14, 0, 6.3); ctx.fillStyle = "#c0c0c4"; ctx.fill();
    // DIN
    ctx.beginPath(); ctx.arc(260, 180, 16, 0, 6.3); ctx.fillStyle = "#1a1a1c"; ctx.strokeStyle = "#888"; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(460, 180, 16, 0, 6.3); ctx.fill(); ctx.stroke();
    // laser label
    ctx.fillStyle = "#c9a24a";
    ctx.fillRect(560, 150, 150, 56);
    ctx.fillStyle = "#1a1208";
    ctx.font = "700 12px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("CLASS 1", 590, 174);
    ctx.fillText("LASER PRODUCT", 572, 192);
    backTex = new THREE.CanvasTexture(backCanvas);
    backTex.colorSpace = THREE.SRGBColorSpace;
  }

  /* ---------------- materials / mesh helpers ---------------- */
  function shadow(m) { m.castShadow = true; m.receiveShadow = true; return m; }
  function boxMesh(w, h, d, mat) { return shadow(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)); }
  function cylMesh(rTop, rBot, h, mat, seg) {
    return shadow(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg || 32), mat));
  }
  function clickable(mesh, data) {
    Object.assign(mesh.userData, data || {});
    mesh.userData.clickable = true;
    clickables.push(mesh);
    return mesh;
  }

  function buildMaterials() {
    var woodMap = tex.wood;
    woodMap.wrapS = woodMap.wrapT = THREE.RepeatWrapping;
    woodMap.anisotropy = 8;
    woodMap.colorSpace = THREE.SRGBColorSpace;
    mats.wood = new THREE.MeshStandardMaterial({
      map: woodMap, roughness: 0.48, metalness: 0.02, color: 0xffffff
    });
    mats.woodSide = mats.wood.clone();
    // darker sides use same map
    mats.plastic = new THREE.MeshStandardMaterial({
      color: 0x161618, roughness: 0.42, metalness: 0.12, envMap: envMap, envMapIntensity: 0.6
    });
    mats.plasticSoft = new THREE.MeshStandardMaterial({
      color: 0x1e1e22, roughness: 0.38, metalness: 0.08, envMap: envMap, envMapIntensity: 0.5
    });
    mats.plasticLite = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, roughness: 0.35, metalness: 0.1
    });
    mats.rubber = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.92, metalness: 0 });
    mats.gold = new THREE.MeshStandardMaterial({
      color: 0xc4a056, roughness: 0.32, metalness: 0.85, envMap: envMap, envMapIntensity: 1
    });
    mats.silver = new THREE.MeshStandardMaterial({
      map: tex.metal, color: 0xffffff, roughness: 0.28, metalness: 0.9, envMap: envMap, envMapIntensity: 1.1
    });
    tex.metal.colorSpace = THREE.SRGBColorSpace;
    tex.metal.anisotropy = 8;
    mats.smoked = new THREE.MeshPhysicalMaterial({
      color: 0x0a0a10, roughness: 0.06, metalness: 0.15, transmission: IS_MOBILE ? 0 : 0.25,
      thickness: 0.4, transparent: true, opacity: 0.45, envMap: envMap, envMapIntensity: 0.8
    });
    mats.glassClear = new THREE.MeshPhysicalMaterial({
      color: 0xe8eef4, roughness: 0.05, metalness: 0.05,
      transparent: true, opacity: 0.14,
      envMap: envMap, envMapIntensity: 0.8
    });
    mats.coverGloss = function (map) {
      return new THREE.MeshStandardMaterial({
        map: map, roughness: 0.28, metalness: 0.04, color: 0xffffff,
        envMap: envMap, envMapIntensity: 0.45
      });
    };
    mats.tray = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.45, metalness: 0.05 });
    mats.edge = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, roughness: 0.25, metalness: 0.7 });
    mats.displayGlass = new THREE.MeshPhysicalMaterial({
      color: 0x041018, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22,
      envMap: envMap, envMapIntensity: 0.8
    });
    mats.led = new THREE.MeshStandardMaterial({ color: 0xff3a2a, emissive: 0xff1a0a, emissiveIntensity: 1.6 });
    mats.fl = new THREE.MeshStandardMaterial({
      map: displayTex, color: 0xffffff, roughness: 0.35, metalness: 0.0,
      emissive: 0xffffff, emissiveMap: displayTex, emissiveIntensity: 0.62
    });
    mats.bezel = new THREE.MeshStandardMaterial({
      map: bezelTex, roughness: 0.4, metalness: 0.12, color: 0xffffff
    });
    mats.back = new THREE.MeshStandardMaterial({
      map: backTex, roughness: 0.45, metalness: 0.1, color: 0xffffff
    });
    mats.wall = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.9, metalness: 0 });
  }

  /* ---------------- room ---------------- */
  function buildRoom() {
    // desk
    var top = boxMesh(1.7, 0.05, 0.82, mats.wood);
    top.position.set(0.05, -0.025, 0.04);
    var woodUV = function (mesh, sx, sy) {
      var uv = mesh.geometry.attributes.uv;
      for (var i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
      }
      uv.needsUpdate = true;
    };
    woodUV(top, 3.4, 1.6);
    scene.add(top);
    desk = top;
    clickable(top, { kind: "desk" });

    // desk edge / apron
    var apron = boxMesh(1.7, 0.07, 0.04, mats.wood);
    apron.position.set(0.05, -0.06, 0.43);
    scene.add(apron);

    // back wall + side suggestion
    var wall = boxMesh(3.2, 1.8, 0.06, mats.wall);
    wall.position.set(0, 0.7, -0.52);
    wall.receiveShadow = true;
    scene.add(wall);
    var wallL = boxMesh(0.06, 1.8, 1.6, mats.wall);
    wallL.position.set(-1.0, 0.7, 0.1);
    scene.add(wallL);

    // soft lamp shade (decorative)
    var arm = boxMesh(0.012, 0.012, 0.28, mats.gold);
    arm.position.set(-0.62, 0.42, -0.18);
    scene.add(arm);
    var shade = cylMesh(0.07, 0.10, 0.09, new THREE.MeshStandardMaterial({
      color: 0xe8c9a0, roughness: 0.7, emissive: 0xffd8a0, emissiveIntensity: 0.25
    }), 24);
    shade.position.set(-0.48, 0.38, -0.18);
    scene.add(shade);
  }

  /* ---------------- player ---------------- */
  function labelButton(text, wpx, hpx, bg, fg) {
    var c = document.createElement("canvas");
    c.width = wpx; c.height = hpx;
    var ctx = c.getContext("2d");
    ctx.fillStyle = bg || "#1a1a1e";
    ctx.fillRect(0, 0, wpx, hpx);
    ctx.fillStyle = fg || "#d8d4cc";
    ctx.font = "600 " + Math.floor(hpx * 0.38) + "px 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, wpx / 2, hpx / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, metalness: 0.08 });
  }

  function buildPlayer() {
    var g = new THREE.Group();
    g.name = "player";

    var W = 0.430, D = 0.380, footH = 0.026;
    // feet
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
      var f = cylMesh(0.016, 0.017, footH, mats.rubber, 24);
      f.position.set(s[0] * (W / 2 - 0.032), footH / 2, s[1] * (D / 2 - 0.032));
      g.add(f);
    });

    var bodyY = footH;
    // lower chassis
    var chassisH = 0.058;
    var chassis = boxMesh(W, chassisH, D, mats.plastic);
    chassis.position.set(0, bodyY + chassisH / 2, 0);
    g.add(chassis);
    clickable(chassis, { kind: "player" });

    // gold pinstripe around mid
    var stripe = boxMesh(W + 0.001, 0.0022, D + 0.001, mats.gold);
    stripe.position.set(0, bodyY + 0.022, 0);
    g.add(stripe);

    // front apron details: headphone jack + slider
    var jack = cylMesh(0.004, 0.004, 0.01, mats.silver, 16);
    jack.rotation.x = Math.PI / 2;
    jack.position.set(0.175, bodyY + 0.016, D / 2 + 0.001);
    g.add(jack);
    var hsl = boxMesh(0.028, 0.006, 0.008, mats.plasticLite);
    hsl.position.set(0.13, bodyY + 0.016, D / 2 + 0.001);
    g.add(hsl);
    var hcap = boxMesh(0.008, 0.01, 0.01, mats.silver);
    hcap.position.set(0.13, bodyY + 0.016, D / 2 + 0.004);
    g.add(hcap);

    // gently sloped deck
    var deck = boxMesh(W - 0.004, 0.01, 0.255, mats.plasticSoft);
    var deckAngle = -0.10;
    deck.rotation.x = deckAngle;
    deck.position.set(0, bodyY + chassisH + 0.002, 0.04);
    g.add(deck);
    clickable(deck, { kind: "player" });

    // rear housing
    var rear = boxMesh(W, 0.086, 0.115, mats.plastic);
    rear.position.set(0, bodyY + chassisH + 0.043, -0.132);
    g.add(rear);
    clickable(rear, { kind: "player" });

    // sloped bezel face (plane, predictable UVs, faces the listener)
    var bezel = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.006, 0.100), mats.bezel);
    bezel.rotation.x = -1.05;
    bezel.position.set(0, bodyY + chassisH + 0.050, -0.068);
    bezel.castShadow = true;
    g.add(bezel);
    clickable(bezel, { kind: "player" });

    var fl = new THREE.Mesh(new THREE.PlaneGeometry(0.252, 0.068), mats.fl);
    fl.rotation.x = -1.05;
    fl.position.set(0.062, bodyY + chassisH + 0.052, -0.061);
    g.add(fl);
    var flg = new THREE.Mesh(new THREE.PlaneGeometry(0.256, 0.072), mats.displayGlass);
    flg.rotation.x = -1.05;
    flg.position.set(0.062, bodyY + chassisH + 0.053, -0.0595);
    g.add(flg);

    // power button (left of bezel)
    var pwr = boxMesh(0.016, 0.012, 0.008, mats.plasticLite);
    pwr.rotation.x = -1.05;
    pwr.position.set(-0.175, bodyY + chassisH + 0.032, -0.055);
    g.add(pwr);
    clickable(pwr, { kind: "power" });
    var pled = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 8, 8), mats.led);
    pled.position.set(-0.175, bodyY + chassisH + 0.038, -0.050);
    g.add(pled);

    // back panel
    var back = boxMesh(W - 0.02, 0.07, 0.002, mats.back);
    back.position.set(0, bodyY + 0.04, -D / 2 - 0.001);
    g.add(back);

    // ---- disc well (left) ----
    var wellX = -0.118, wellZ = 0.055, wellY = bodyY + chassisH + 0.004;
    var wellFrame = boxMesh(0.178, 0.012, 0.168, mats.plastic);
    wellFrame.position.set(wellX, wellY, wellZ);
    g.add(wellFrame);

    wellGroup = new THREE.Group();
    wellGroup.position.set(wellX, wellY + 0.001, wellZ);
    g.add(wellGroup);
    // recessed black well
    var wellPit = cylMesh(0.062, 0.062, 0.008, mats.tray, 48);
    wellPit.position.y = -0.002;
    wellGroup.add(wellPit);
    clickable(wellPit, { kind: "well" });
    spindle = cylMesh(0.006, 0.0075, 0.008, mats.silver, 20);
    spindle.position.y = 0.004;
    wellGroup.add(spindle);
    var spindleTop = cylMesh(0.004, 0.004, 0.006, mats.plasticLite, 16);
    spindleTop.position.y = 0.010;
    wellGroup.add(spindleTop);

    // lid pivot at back of well
    lidPivot = new THREE.Group();
    lidPivot.position.set(wellX, wellY + 0.008, wellZ - 0.082);
    g.add(lidPivot);
    var lid = boxMesh(0.176, 0.009, 0.166, mats.plastic);
    lid.position.set(0, 0, 0.082);
    lidPivot.add(lid);
    clickable(lid, { kind: "lid" });
    var lidFrame = boxMesh(0.150, 0.003, 0.120, mats.plasticLite);
    lidFrame.position.set(0, 0.006, 0.086);
    lidPivot.add(lidFrame);
    var win = boxMesh(0.138, 0.002, 0.108, mats.smoked);
    win.position.set(0, 0.0072, 0.086);
    lidPivot.add(win);
    // clamp under lid
    clampMesh = cylMesh(0.028, 0.028, 0.008, mats.plasticLite, 32);
    clampMesh.position.set(0, -0.008, 0.090);
    lidPivot.add(clampMesh);
    var clampPad = cylMesh(0.018, 0.018, 0.003, mats.rubber, 24);
    clampPad.position.set(0, -0.013, 0.090);
    lidPivot.add(clampPad);

    // ---- control island ----
    var islandY = bodyY + chassisH + 0.010;
    var islandZ = 0.055;
    var island = boxMesh(0.228, 0.012, 0.168, mats.plasticSoft);
    island.position.set(0.092, islandY, islandZ);
    g.add(island);

    function addBtn(x, z, w, d, h, label, action, bg) {
      var m = boxMesh(w, h || 0.007, d, labelButton(label, 128, 64, bg || "#1c1c20", "#e8e4dc"));
      m.position.set(x, islandY + 0.010, z);
      g.add(m);
      clickable(m, { kind: "btn", action: action });
      return m;
    }
    // numeric pad 1-0
    var keys = ["1","2","3","4","5","6","7","8","9","0"];
    keys.forEach(function (k, i) {
      var col = i % 5, row = Math.floor(i / 5);
      addBtn(0.010 + col * 0.018, 0.100 - row * 0.020, 0.016, 0.016, 0.006, k, "num");
    });
    // transport
    addBtn(0.112, 0.108, 0.028, 0.016, 0.007, "SKIP «", "prev");
    addBtn(0.112, 0.088, 0.028, 0.016, 0.007, "SKIP »", "next");
    addBtn(0.112, 0.068, 0.028, 0.016, 0.007, "STOP", "stop", "#2a1c1c");
    addBtn(0.112, 0.048, 0.028, 0.016, 0.007, "PAUSE", "pause", "#2a2a1c");
    addBtn(0.112, 0.026, 0.028, 0.020, 0.008, "PLAY", "play", "#1c2a1e");
    addBtn(0.112, 0.004, 0.028, 0.014, 0.007, "OPEN", "eject", "#1c1c2a");

    addBtn(0.018, 0.048, 0.022, 0.012, 0.006, "REPEAT", "repeat");
    addBtn(0.042, 0.048, 0.022, 0.012, 0.006, "MEMORY", "noop");
    addBtn(0.066, 0.048, 0.022, 0.012, 0.006, "TIME", "noop");
    addBtn(0.018, 0.030, 0.022, 0.012, 0.006, "CUE", "noop");
    addBtn(0.042, 0.030, 0.022, 0.012, 0.006, "INDEX", "noop");
    addBtn(0.066, 0.030, 0.022, 0.012, 0.006, "CLEAR", "noop");

    // jog dial
    jogMesh = cylMesh(0.032, 0.032, 0.008, mats.silver, 48);
    jogMesh.position.set(0.168, islandY + 0.012, 0.062);
    g.add(jogMesh);
    clickable(jogMesh, { kind: "jog" });
    var jogCap = cylMesh(0.012, 0.012, 0.009, mats.plastic, 24);
    jogCap.position.set(0.168, islandY + 0.013, 0.062);
    g.add(jogCap);
    // finger dent
    var dent = cylMesh(0.004, 0.004, 0.003, mats.plasticLite, 12);
    dent.position.set(0.168 + 0.022, islandY + 0.020, 0.062);
    g.add(dent);

    // pitch slider
    var pslot = boxMesh(0.012, 0.004, 0.110, mats.plastic);
    pslot.position.set(0.198, islandY + 0.010, 0.062);
    g.add(pslot);
    // scale marks
    for (var i = -4; i <= 4; i++) {
      var mk = boxMesh(0.006, 0.001, 0.001, mats.gold);
      mk.position.set(0.190, islandY + 0.013, 0.062 + i * 0.012);
      g.add(mk);
    }
    pitchCap = boxMesh(0.016, 0.010, 0.012, mats.silver);
    pitchCap.position.set(0.198, islandY + 0.016, 0.062);
    g.add(pitchCap);
    clickable(pitchCap, { kind: "pitch" });
    addBtn(0.198, 0.128, 0.020, 0.012, 0.006, "PITCH", "pitchToggle");

    // faint cyan point light from display
    flLight = new THREE.PointLight(0x7ad8ff, 0.08, 0.55, 2);
    flLight.position.set(0.06, bodyY + chassisH + 0.08, -0.02);
    g.add(flLight);

    // place so feet sit on y=0, centered
    g.position.set(-0.20, 0, 0);
    scene.add(g);
    player = g;
    return g;
  }

  /* ---------------- jewel cases & rack ---------------- */
  function makeCD(album) {
    var g = new THREE.Group();
    g.userData.kind = "cd";
    g.userData.album = album;
    var innerR = 0.0075, outerR = 0.060, th = 0.0012;
    var labelMat = new THREE.MeshStandardMaterial({
      map: tex["label-" + album.id], roughness: 0.45, metalness: 0.05, color: 0xffffff
    });
    tex["label-" + album.id].colorSpace = THREE.SRGBColorSpace;
    tex["label-" + album.id].anisotropy = 8;
    var rainMat = new THREE.MeshStandardMaterial({
      map: tex.rainbow, roughness: 0.18, metalness: 0.85, color: 0xffffff, envMap: envMap, envMapIntensity: 1.4
    });
    tex.rainbow.colorSpace = THREE.SRGBColorSpace;
    tex.rainbow.anisotropy = 8;
    var top = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 64), labelMat);
    top.rotation.x = -Math.PI / 2;
    top.position.y = th / 2;
    g.add(top);
    var bot = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 64), rainMat);
    bot.rotation.x = Math.PI / 2;
    bot.position.y = -th / 2;
    g.add(bot);
    var edge = new THREE.Mesh(new THREE.CylinderGeometry(outerR, outerR, th, 64, 1, true), mats.edge);
    g.add(edge);
    var hole = new THREE.Mesh(new THREE.CylinderGeometry(innerR, innerR, th, 24, 1, true), mats.edge);
    g.add(hole);
    // invisible thicker hit target
    var hit = new THREE.Mesh(new THREE.CylinderGeometry(outerR, outerR, 0.006, 32), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    clickable(hit, { kind: "cd", album: album, group: g });
    shadow(top); shadow(bot); shadow(edge);
    discObjects[album.id] = g;
    return g;
  }

  function makeJewelCase(album, slot) {
    var W = 0.125, H = 0.142, T = 0.010;
    var g = new THREE.Group();
    g.userData.kind = "case";
    g.userData.album = album;
    g.userData.slot = slot;
    g.userData.hasDisc = true;
    g.userData.open = 0;

    var coverMap = tex["cover-" + album.id];
    var backMap = tex["back-" + album.id];
    var spineMap = tex["spine-" + album.id];
    var bookMap = tex["booklet-" + album.id];
    [coverMap, backMap, spineMap, bookMap].forEach(function (m) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.anisotropy = 8;
    });

    // base group (tray + back + spine)
    var base = new THREE.Group();
    g.add(base);

    var coverMat = mats.coverGloss(coverMap);
    var backMat = new THREE.MeshStandardMaterial({ map: backMap, roughness: 0.5, metalness: 0.0 });
    var spineMat = new THREE.MeshStandardMaterial({ map: spineMap, roughness: 0.5, metalness: 0.0 });
    var bookMat = new THREE.MeshStandardMaterial({ map: bookMap, roughness: 0.62, metalness: 0.0 });

    // back card (outer back of case)
    var back = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.002, H - 0.002), backMat);
    back.position.set(0, 0, -T / 2);
    back.rotation.y = Math.PI;
    base.add(back);
    shadow(back);

    // black tray
    var tray = boxMesh(W - 0.006, H - 0.008, 0.0038, mats.tray);
    tray.position.set(0.001, 0, -0.001);
    base.add(tray);
    var recess = new THREE.Mesh(new THREE.CylinderGeometry(0.061, 0.061, 0.002, 48), mats.plastic);
    recess.rotation.x = Math.PI / 2;
    recess.position.set(0.004, 0, 0.0015);
    base.add(recess);
    var hub = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.004, 16), mats.plasticLite);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(0.004, 0, 0.002);
    base.add(hub);

    // spine wall (left)
    var spine = new THREE.Mesh(new THREE.PlaneGeometry(T, H - 0.002), spineMat);
    spine.position.set(-W / 2, 0, 0);
    spine.rotation.y = -Math.PI / 2;
    base.add(spine);

    var rimMat = new THREE.MeshStandardMaterial({
      color: 0xd8dee6, roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.55,
      envMap: envMap, envMapIntensity: 0.7
    });
    var rimTop = boxMesh(W, 0.0032, T, rimMat);
    rimTop.position.set(0, H / 2 - 0.0014, 0);
    base.add(rimTop);
    var rimBot = boxMesh(W, 0.0032, T, rimMat);
    rimBot.position.set(0, -H / 2 + 0.0014, 0);
    base.add(rimBot);
    var rimRight = boxMesh(0.0032, H, T, rimMat);
    rimRight.position.set(W / 2 - 0.0014, 0, 0);
    base.add(rimRight);

    // front cover group, hinge at left / front edge
    var coverG = new THREE.Group();
    coverG.position.set(-W / 2, 0, T / 2);
    g.add(coverG);
    g.userData.cover = coverG;

    // Visible artwork on the outside of the lid (what you see on the shelf)
    var frontArt = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.006, H - 0.006), coverMat);
    frontArt.position.set(W / 2, 0, 0.0002);
    coverG.add(frontArt);
    frontArt.castShadow = true;

    // very light clear pane over the art (no shadow — shadows made it look like a grey slab)
    var frontClear = new THREE.Mesh(new THREE.BoxGeometry(W - 0.002, H - 0.002, 0.0012), mats.glassClear);
    frontClear.position.set(W / 2, 0, 0.0010);
    coverG.add(frontClear);

    // booklet on the inside of the lid (faces the tray when closed, visible when opened)
    var booklet = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.008, H - 0.010), bookMat);
    booklet.position.set(W / 2, 0, -0.0008);
    booklet.rotation.y = Math.PI;
    coverG.add(booklet);

    // plastic rim of the lid
    var lidRimT = boxMesh(W, 0.003, 0.0024, rimMat);
    lidRimT.position.set(W / 2, H / 2 - 0.0014, 0.0006);
    coverG.add(lidRimT);
    var lidRimB = boxMesh(W, 0.003, 0.0024, rimMat);
    lidRimB.position.set(W / 2, -H / 2 + 0.0014, 0.0006);
    coverG.add(lidRimB);

    // CD in tray, slightly in front of tray
    var cd = makeCD(album);
    cd.rotation.x = 0;
    cd.position.set(0.004, 0, 0.0035);
    // CD lies in XY of case (case stands in XY, thickness Z) — disc should lie in the case plane, facing out
    // Case local: Y up, X right, Z out. Disc default is horizontal (XZ). Rotate to face +Z.
    cd.rotation.x = Math.PI / 2;
    base.add(cd);
    g.userData.cd = cd;
    g.userData.base = base;

    // hit box for the whole case
    var hit = new THREE.Mesh(new THREE.BoxGeometry(W + 0.004, H + 0.004, T + 0.006), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    clickable(hit, { kind: "case", group: g });

    return g;
  }

  function buildRack() {
    var g = new THREE.Group();
    // low wooden crate / shelf
    var board = boxMesh(0.56, 0.016, 0.16, mats.wood);
    board.position.set(0, 0.008, 0);
    g.add(board);
    var backb = boxMesh(0.56, 0.10, 0.012, mats.wood);
    backb.position.set(0, 0.058, -0.074);
    g.add(backb);
    var sideL = boxMesh(0.012, 0.10, 0.16, mats.wood);
    sideL.position.set(-0.274, 0.058, 0);
    g.add(sideL);
    var sideR = boxMesh(0.012, 0.10, 0.16, mats.wood);
    sideR.position.set(0.274, 0.058, 0);
    g.add(sideR);
    // front lip
    var lip = boxMesh(0.56, 0.018, 0.008, mats.wood);
    lip.position.set(0, 0.024, 0.076);
    g.add(lip);

    g.position.set(0.36, 0, 0.02);
    scene.add(g);
    rack = g;

    ALBUMS.forEach(function (album, i) {
      var c = makeJewelCase(album, i);
      var n = ALBUMS.length;
      var x = (i - (n - 1) / 2) * 0.132;
      var home = new THREE.Vector3(0.36 + x, 0.016 + 0.071, 0.030);
      c.position.copy(home);
      c.rotation.set(0, -0.18 + 0.10 * (i - 1.5), 0);
      c.userData.homePos = home.clone();
      c.userData.homeRot = c.rotation.clone();
      scene.add(c);
      cases.push(c);
    });
  }

  /* ---------------- camera ---------------- */
  function layoutCameras() {
    var portrait = window.innerHeight > window.innerWidth * 1.05;
    if (portrait) {
      camRig.farPos.set(0.08, 1.55, 1.15);
      camRig.farTarget.set(0.08, 0.04, 0.02);
      camRig.nearPos.set(0.08, 0.82, 0.88);
      camRig.nearTarget.set(0.07, 0.08, 0.02);
      camera.fov = 50;
    } else {
      camRig.farPos.set(0.22, 0.82, 1.22);
      camRig.farTarget.set(0.04, 0.04, 0.02);
      camRig.nearPos.set(0.12, 0.46, 0.82);
      camRig.nearTarget.set(0.08, 0.09, 0.02);
      camera.fov = 40;
    }
    camera.updateProjectionMatrix();
    if (state.view === "far") {
      camRig.pos.copy(camRig.farPos);
      camRig.target.copy(camRig.farTarget);
    } else {
      camRig.pos.copy(camRig.nearPos);
      camRig.target.copy(camRig.nearTarget);
    }
  }

  function applyCamera() {
    var pos = camRig.pos.clone();
    var tgt = camRig.target.clone();
    // orbit around target
    var off = pos.clone().sub(tgt);
    var e = new THREE.Euler(camRig.pitch, camRig.yaw, 0, "YXZ");
    off.applyEuler(e);
    camera.position.copy(tgt).add(off);
    camera.lookAt(tgt);
  }

  function goView(which, done) {
    state.view = which;
    document.body.classList.toggle("near", which === "near");
    var toP = which === "near" ? camRig.nearPos : camRig.farPos;
    var toT = which === "near" ? camRig.nearTarget : camRig.farTarget;
    var fromP = camRig.pos.clone();
    var fromT = camRig.target.clone();
    var fromY = camRig.yaw, fromPi = camRig.pitch;
    tween(1.15, function (k) {
      camRig.pos.lerpVectors(fromP, toP, k);
      camRig.target.lerpVectors(fromT, toT, k);
      camRig.yaw = lerp(fromY, 0, k);
      camRig.pitch = lerp(fromPi, 0, k);
    }, function () { updateHint(); if (done) done(); }, easeInOut);
    updateHint();
  }

  /* ---------------- interaction logic ---------------- */
  var HOLD = new THREE.Vector3(0.14, 0.20, 0.30);
  var HOLD_ROT = new THREE.Euler(-0.42, 0.25, 0.04);
  function holdPos() {
    if (window.innerHeight > window.innerWidth * 1.05) return new THREE.Vector3(0.10, 0.26, 0.48);
    return HOLD.clone();
  }
  function holdRot() { return HOLD_ROT; }

  function setBusy(v) { state.busy = v; }

  function moveCaseTo(caseG, pos, rot, dur, done) {
    var fp = caseG.position.clone();
    var frx = caseG.rotation.x, fry = caseG.rotation.y, frz = caseG.rotation.z;
    tween(dur || 0.7, function (k) {
      caseG.position.lerpVectors(fp, pos, k);
      caseG.rotation.x = lerp(frx, rot.x, k);
      caseG.rotation.y = lerp(fry, rot.y, k);
      caseG.rotation.z = lerp(frz, rot.z, k);
    }, done, easeInOut);
  }

  function pickupCase(caseG, done) {
    if (state.held && state.held !== caseG) {
      returnCase(state.held, function () { pickupCase(caseG, done); });
      return;
    }
    sfxPlastic();
    state.held = caseG;
    moveCaseTo(caseG, holdPos(), holdRot(), 0.7, function () {
      state.held = caseG;
      updateHint();
      if (done) done();
    });
  }

  function openCover(caseG, done) {
    sfxPlastic();
    var cover = caseG.userData.cover;
    tweenRotY(cover, -2.15, 0.65, easeInOutBack, function () {
      state.heldOpen = true;
      caseG.userData.open = 1;
      updateHint();
      if (done) done();
    });
  }
  function closeCover(caseG, done) {
    sfxPlastic();
    var cover = caseG.userData.cover;
    tweenRotY(cover, 0, 0.5, easeInOut, function () {
      state.heldOpen = false;
      caseG.userData.open = 0;
      updateHint();
      if (done) done();
    });
  }

  function returnCase(caseG, done) {
    function put() {
      if (state.held === caseG) { state.held = null; state.heldOpen = false; }
      moveCaseTo(caseG, caseG.userData.homePos, caseG.userData.homeRot, 0.65, function () {
        updateHint();
        if (done) done();
      });
    }
    if (caseG.userData.open) closeCover(caseG, put);
    else put();
  }

  function setLid(open, done) {
    sfxLid(open);
    var to = open ? -1.15 : 0; // radians, almost vertical
    tweenRotX(lidPivot, to, open ? 0.75 : 0.65, easeInOut, function () {
      state.lid = open ? 1 : 0;
      if (done) done();
    });
  }

  function worldPos(obj) {
    var v = new THREE.Vector3();
    obj.getWorldPosition(v);
    return v;
  }

  function placeDiscInWell(album, done) {
    var cd = discObjects[album.id];
    scene.attach(cd);
    var target = worldPos(spindle);
    target.y += 0.004;
    var start = cd.position.clone();
    // also flatten the disc to lie in XZ
    var rx0 = cd.rotation.x, ry0 = cd.rotation.y, rz0 = cd.rotation.z;
    var mid = start.clone().lerp(target, 0.45);
    mid.y += 0.12;
    tween(0.85, function (k) {
      var a = k < 0.55 ? (k / 0.55) : 1;
      var b = k < 0.55 ? 0 : (k - 0.55) / 0.45;
      if (k < 0.55) {
        // bezier-ish lift
        var t = a;
        var p = start.clone().lerp(mid, t);
        p.y = lerp(start.y, mid.y, t) + Math.sin(t * Math.PI) * 0.02;
        cd.position.copy(p);
      } else {
        cd.position.lerpVectors(mid, target, b);
      }
      cd.rotation.x = lerp(rx0, -0, k); // will set properly after attach
      // interpolate toward horizontal
      var qEnd = new THREE.Euler(-0, 0, 0);
      cd.rotation.x = lerp(rx0, 0, k);
      cd.rotation.y = lerp(ry0, 0, k);
      cd.rotation.z = lerp(rz0, 0, k);
    }, function () {
      wellGroup.attach(cd);
      cd.position.set(0, 0.005, 0);
      cd.rotation.set(0, 0, 0);
      state.playerAlbum = album;
      state.handDisc = null;
      if (done) done();
    }, easeInOut);
  }

  function takeDiscFromWell(done) {
    var album = state.playerAlbum;
    if (!album) { if (done) done(); return; }
    var cd = discObjects[album.id];
    scene.attach(cd);
    var start = cd.position.clone();
    var hover = start.clone();
    hover.y += 0.14;
    hover.z += 0.08;
    hover.x += 0.06;
    tweenVec3(cd.position, hover, 0.55, easeOut, function () {
      state.playerAlbum = null;
      state.handDisc = album;
      if (done) done();
    });
    // tilt slightly
    tween(0.55, function (k) { cd.rotation.x = lerp(0, 0.5, k); });
  }

  function takeDiscFromCase(caseG, done) {
    var album = caseG.userData.album;
    var cd = discObjects[album.id];
    scene.attach(cd);
    caseG.userData.hasDisc = false;
    var start = cd.position.clone();
    var mid = start.clone();
    mid.y += 0.08;
    tweenVec3(cd.position, mid, 0.4, easeOut, function () {
      state.handDisc = album;
      if (done) done();
    });
  }

  function putDiscInCase(caseG, album, done) {
    var cd = discObjects[album.id];
    var destParent = caseG.userData.base;
    // animate in world to the tray position then attach
    var dest = new THREE.Vector3(0.004, 0, 0.0035);
    destParent.localToWorld(dest);
    var start = cd.position.clone();
    var mid = start.clone().lerp(dest, 0.5);
    mid.y += 0.06;
    var rx0 = cd.rotation.x, ry0 = cd.rotation.y, rz0 = cd.rotation.z;
    tween(0.55, function (k) {
      var p1 = start.clone().lerp(mid, Math.min(1, k * 2));
      var p2 = mid.clone().lerp(dest, Math.max(0, k * 2 - 1));
      cd.position.copy(k < 0.5 ? p1 : p2);
    }, function () {
      destParent.attach(cd);
      cd.position.set(0.004, 0, 0.0035);
      cd.rotation.set(Math.PI / 2, 0, 0);
      caseG.userData.hasDisc = true;
      if (state.handDisc === album) state.handDisc = null;
      if (done) done();
    }, easeInOut);
    tween(0.55, function (k) {
      cd.rotation.x = lerp(rx0, Math.PI / 2, k);
      cd.rotation.y = lerp(ry0, 0, k);
      cd.rotation.z = lerp(rz0, 0, k);
    });
  }

  function findCaseFor(album) {
    for (var i = 0; i < cases.length; i++) {
      if (cases[i].userData.album.id === album.id) return cases[i];
    }
    return null;
  }

  function openCoverInPlace(caseG, done) {
    if (caseG.userData.open) { if (done) done(); return; }
    sfxPlastic();
    tweenRotY(caseG.userData.cover, -2.15, 0.45, easeInOut, function () {
      caseG.userData.open = 1;
      if (caseG === state.held) state.heldOpen = true;
      if (done) done();
    });
  }
  function closeCoverInPlace(caseG, done) {
    if (!caseG.userData.open) { if (done) done(); return; }
    sfxPlastic();
    tweenRotY(caseG.userData.cover, 0, 0.4, easeInOut, function () {
      caseG.userData.open = 0;
      if (caseG === state.held) state.heldOpen = false;
      if (done) done();
    });
  }
  // Return the loaded (or in-hand) disc to its own case. Does not steal a different held case.
  function shelveDisc(album, done) {
    if (!album) { if (done) done(); return; }
    var c = findCaseFor(album);
    runSeq([
      function (n) { if (state.playerAlbum === album) takeDiscFromWell(n); else n(); },
      function (n) {
        if (!c) { n(); return; }
        if (state.held === c) {
          if (c.userData.open) n(); else openCover(c, n);
        } else {
          openCoverInPlace(c, n);
        }
      },
      function (n) { if (c) putDiscInCase(c, album, n); else n(); },
      function (n) {
        if (!c) { n(); return; }
        if (state.held === c) n();
        else closeCoverInPlace(c, n);
      }
    ], done);
  }

  function ejectSequence(done) {
    stopPlay();
    var album = state.playerAlbum;
    runSeq([
      function (n) { if (state.lid) n(); else setLid(true, n); },
      function (n) { shelveDisc(album, n); },
      function (n) { setLid(false, n); }
    ], function () { updateHint(); if (done) done(); });
  }

  function loadFromOpenCase(caseG) {
    var album = caseG.userData.album;
    unlockAudioFromGesture();
    loadAlbumAudio(album);
    // prime play in the same gesture
    audio.muted = true;
    var primed = audio.play();
    if (primed && primed.catch) primed.catch(function () {});
    audio.pause();
    audio.muted = false;
    try { audio.currentTime = 0; } catch (e) {}

    setBusy(true);
    var steps = [];
    if (state.playerAlbum) {
      steps.push(function (n) { ejectSequence(n); });
    }
    steps.push(function (n) { takeDiscFromCase(caseG, n); });
    steps.push(function (n) { if (state.lid) n(); else setLid(true, n); });
    steps.push(function (n) { placeDiscInWell(album, n); });
    steps.push(function (n) { setLid(false, n); });
    steps.push(function (n) { startPlay(); n(); });
    steps.push(function (n) { returnCase(caseG, n); });
    runSeq(steps, function () { setBusy(false); updateHint(); });
  }

  function onCaseClicked(caseG) {
    if (state.view === "far") {
      setBusy(true);
      goView("near", function () {
        pickupCase(caseG, function () { setBusy(false); });
      });
      return;
    }
    // if a disc is in hand and this case is the owner and open (or we'll open it)
    if (state.handDisc) {
      var target = findCaseFor(state.handDisc);
      if (caseG !== target && caseG.userData.hasDisc) return;
      var c = caseG === target ? caseG : target;
      setBusy(true);
      runSeq([
        function (n) { if (state.held !== c) pickupCase(c, n); else n(); },
        function (n) { if (c.userData.open) n(); else openCover(c, n); },
        function (n) { putDiscInCase(c, state.handDisc, n); }
      ], function () { setBusy(false); updateHint(); });
      return;
    }
    if (state.held !== caseG) {
      setBusy(true);
      pickupCase(caseG, function () { setBusy(false); });
      return;
    }
    if (!state.heldOpen) {
      setBusy(true);
      openCover(caseG, function () { setBusy(false); });
      return;
    }
    // already open and empty: close and return
    if (!caseG.userData.hasDisc) {
      setBusy(true);
      returnCase(caseG, function () { setBusy(false); });
    }
  }

  function onCdClicked(album, group) {
    // CD in an open case?
    var owner = findCaseFor(album);
    if (owner && owner.userData.hasDisc && owner.userData.open && state.held === owner) {
      loadFromOpenCase(owner);
      return;
    }
    // CD hovering in hand — if well is open, place it
    if (state.handDisc === album) {
      unlockAudioFromGesture();
      loadAlbumAudio(album);
      audio.muted = true;
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
      audio.pause();
      audio.muted = false;
      try { audio.currentTime = 0; } catch (e) {}
      setBusy(true);
      runSeq([
        function (n) { if (state.lid) n(); else setLid(true, n); },
        function (n) { placeDiscInWell(album, n); },
        function (n) { setLid(false, n); },
        function (n) { startPlay(); n(); }
      ], function () { setBusy(false); updateHint(); });
    }
  }

  function onWellClicked() {
    if (state.handDisc) {
      onCdClicked(state.handDisc, discObjects[state.handDisc.id]);
      return;
    }
    if (state.playerAlbum) {
      // treat as eject request if lid closed? or open lid
      onAction("eject");
    } else {
      onAction("eject");
    }
  }

  function onAction(action) {
    sfxClick();
    if (action === "play") {
      if (!state.playerAlbum) return;
      unlockAudioFromGesture();
      startPlay();
    } else if (action === "pause") {
      if (state.transport === "play") pausePlay();
      else if (state.transport === "pause") startPlay();
    } else if (action === "stop") {
      stopPlay();
    } else if (action === "eject") {
      if (state.busy) return;
      if (state.playerAlbum) {
        setBusy(true);
        ejectSequence(function () { setBusy(false); });
      } else {
        setBusy(true);
        setLid(state.lid ? false : true, function () { setBusy(false); });
      }
    } else if (action === "pitchToggle") {
      state.pitchOn = !state.pitchOn;
      applyPitch();
    } else if (action === "power") {
      state.power = !state.power;
      if (!state.power) stopPlay();
      mats.fl.emissiveIntensity = state.power ? 0.62 : 0.05;
      flLight.intensity = state.power ? 0.15 : 0.0;
    }
    updateHint();
  }

  function onPlayerClicked() {
    if (state.view === "far") {
      setBusy(true);
      goView("near", function () { setBusy(false); });
    }
  }

  function goFar() {
    if (state.view === "far") return;
    function finish() {
      goView("far", function () { setBusy(false); });
    }
    setBusy(true);
    if (state.held) returnCase(state.held, finish);
    else finish();
  }

  /* ---------------- pointer ---------------- */
  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();
  var ptr = {
    down: false, sx: 0, sy: 0, x: 0, y: 0, dragged: false,
    mode: null, // orbit | jog | pitch | click
    hit: null
  };

  function ndc(e) {
    var r = canvas.getBoundingClientRect();
    var cx = (e.clientX !== undefined) ? e.clientX : (e.touches && e.touches[0].clientX);
    var cy = (e.clientY !== undefined) ? e.clientY : (e.touches && e.touches[0].clientY);
    pointer.x = ((cx - r.left) / r.width) * 2 - 1;
    pointer.y = -((cy - r.top) / r.height) * 2 + 1;
    return { x: cx, y: cy };
  }

  function pick() {
    raycaster.setFromCamera(pointer, camera);
    var hits = raycaster.intersectObjects(clickables, true);
    for (var i = 0; i < hits.length; i++) {
      var o = hits[i].object;
      while (o && !o.userData.clickable) o = o.parent;
      if (o && o.userData.clickable) return { obj: o, rec: hits[i] };
    }
    return null;
  }

  function handleClick(hit) {
    if (!hit) {
      return;
    }
    var d = hit.obj.userData;
    if (d.kind === "case") {
      onCaseClicked(d.group);
    } else if (d.kind === "cd") {
      onCdClicked(d.album, d.group);
    } else if (d.kind === "btn") {
      if (state.view === "far") { onPlayerClicked(); return; }
      onAction(d.action);
    } else if (d.kind === "lid") {
      if (state.view === "far") { onPlayerClicked(); return; }
      onAction("eject");
    } else if (d.kind === "well") {
      if (state.view === "far") { onPlayerClicked(); return; }
      onWellClicked();
    } else if (d.kind === "player" || d.kind === "power") {
      if (d.kind === "power" && state.view === "near") onAction("power");
      else onPlayerClicked();
    } else if (d.kind === "desk") {
      if (state.view === "near" && !state.held) goFar();
    } else if (d.kind === "jog") {
      if (state.view === "far") onPlayerClicked();
    } else if (d.kind === "pitch") {
      if (state.view === "far") onPlayerClicked();
    }
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    var p = ndc(e);
    ptr.down = true; ptr.sx = p.x; ptr.sy = p.y; ptr.x = p.x; ptr.y = p.y;
    ptr.dragged = false; ptr.mode = null;
    ptr.hit = pick();
    var kind = ptr.hit && ptr.hit.obj.userData.kind;
    if (kind === "jog" && state.view === "near") ptr.mode = "jog";
    else if (kind === "pitch" && state.view === "near") ptr.mode = "pitch";
    else if (!kind || kind === "desk") ptr.mode = IS_TOUCH ? "none" : "orbit";
    else ptr.mode = "click";
    if (ptr.mode === "jog" || ptr.mode === "pitch") e.preventDefault();
  }
  function onMove(e) {
    var p = ndc(e);
    var dx = p.x - ptr.x, dy = p.y - ptr.y;
    ptr.x = p.x; ptr.y = p.y;
    if (!ptr.down) {
      var h = pick();
      var kind = h && h.obj.userData.kind;
      canvas.style.cursor = (kind && kind !== "desk") ? "pointer" : (state.view === "near" && !IS_TOUCH ? "grab" : "default");
      return;
    }
    if (Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > 8) ptr.dragged = true;
    if (ptr.mode === "orbit" && state.view === "near" && !IS_TOUCH) {
      camRig.yaw += dx * 0.005;
      camRig.pitch += dy * 0.004;
      camRig.yaw = Math.max(-0.45, Math.min(0.45, camRig.yaw));
      camRig.pitch = Math.max(-0.22, Math.min(0.28, camRig.pitch));
    } else if (ptr.mode === "jog") {
      if (state.playerAlbum && audio.duration) {
        audio.currentTime = Math.max(0, Math.min(audio.duration - 0.05, audio.currentTime + dx * 0.04));
      }
      jogMesh.rotation.y += dx * 0.04;
    } else if (ptr.mode === "pitch") {
      state.pitch = Math.max(-1, Math.min(1, state.pitch - dy * 0.01));
      pitchCap.position.z = 0.062 + state.pitch * 0.048;
      applyPitch();
    }
  }
  function onUp(e) {
    if (!ptr.down) return;
    ndc(e);
    var wasDrag = ptr.dragged;
    var hit = ptr.hit;
    ptr.down = false;
    if (!wasDrag && !state.busy) {
      // re-pick in case
      handleClick(hit);
    }
  }

  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  document.getElementById("btn-back").addEventListener("click", function () { if (!state.busy) goFar(); });
  document.getElementById("btn-play").addEventListener("click", function () { unlockAudioFromGesture(); onAction("play"); });
  document.getElementById("btn-pause").addEventListener("click", function () { onAction("pause"); });
  document.getElementById("btn-stop").addEventListener("click", function () { onAction("stop"); });
  document.getElementById("btn-eject").addEventListener("click", function () { unlockAudioFromGesture(); onAction("eject"); });
  document.getElementById("credits-btn").addEventListener("click", function () {
    document.getElementById("credits").classList.add("open");
  });
  document.getElementById("credits-close").addEventListener("click", function () {
    document.getElementById("credits").classList.remove("open");
  });
  document.getElementById("credits").addEventListener("click", function (e) {
    if (e.target.id === "credits") e.currentTarget.classList.remove("open");
  });

  /* ---------------- loop / init ---------------- */
  var lastFl = 0;
  function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(0.05, clock.getDelta());
    tickTweens(dt);
    applyCamera();
    lastFl += dt;
    if (lastFl > 0.08) { lastFl = 0; if (state.power) drawDisplay(); }
    // slow spin when playing
    if (state.transport === "play" && state.playerAlbum) {
      var cd = discObjects[state.playerAlbum.id];
      if (cd && cd.parent === wellGroup) cd.rotation.y += dt * 2.4 * (state.pitchOn ? (1 + state.pitch * 0.08) : 1);
    }
    renderer.render(scene, camera);
  }

  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    layoutCameras();
    applyCamera();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2));
  }

  function initScene() {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !IS_MOBILE, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x120d0a, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !IS_MOBILE;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x120d0a, 1.8, 5.5);
    camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 12);
    clock = new THREE.Clock();

    // env
    var envScene = new THREE.Scene();
    envScene.add(new THREE.AmbientLight(0xffe8d0, 0.8));
    var eg = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 8), new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x2a2018 }));
    envScene.add(eg);
    var pmrem = new THREE.PMREMGenerator(renderer);
    envMap = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();

    var hemi = new THREE.HemisphereLight(0xffe6c8, 0x3a2414, 0.45);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xfff2e0, 1.55);
    key.position.set(0.8, 1.4, 0.9);
    key.castShadow = !IS_MOBILE;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.2;
    key.shadow.camera.far = 4;
    key.shadow.camera.left = -1.2;
    key.shadow.camera.right = 1.2;
    key.shadow.camera.top = 1.0;
    key.shadow.camera.bottom = -0.8;
    key.shadow.bias = -0.0004;
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xb8d0ff, 0.25);
    fill.position.set(-0.8, 0.5, 0.4);
    scene.add(fill);
    var lamp = new THREE.PointLight(0xffcc88, 0.55, 2.5, 2);
    lamp.position.set(-0.48, 0.38, -0.18);
    scene.add(lamp);
    var frontFill = new THREE.DirectionalLight(0xffe6d0, 0.28);
    frontFill.position.set(0.15, 0.55, 1.1);
    scene.add(frontFill);

    makeDisplay();
    makeBezel();
    makeBackPanel();
    buildMaterials();
    buildRoom();
    buildPlayer();
    buildRack();
    layoutCameras();
    applyCamera();
    updateHint();

    var qs = (location.search || "").replace(/^\?/, "");
    if (qs.indexOf("view=near") >= 0) {
      state.view = "near";
      document.body.classList.add("near");
      camRig.pos.copy(camRig.nearPos);
      camRig.target.copy(camRig.nearTarget);
      applyCamera();
      updateHint();
    }
    if (qs.indexOf("open=1") >= 0) {
      state.view = "near";
      document.body.classList.add("near");
      camRig.pos.copy(camRig.nearPos);
      camRig.target.copy(camRig.nearTarget);
      applyCamera();
      var c0 = cases[1] || cases[0];
      if (c0) {
        c0.position.copy(holdPos());
        c0.rotation.copy(holdRot());
        state.held = c0;
        c0.userData.cover.rotation.y = -2.15;
        state.heldOpen = true;
        c0.userData.open = 1;
        updateHint();
      }
    }

    window.addEventListener("resize", onResize);
    loop();
  }

  /* ---------------- load ---------------- */
  var manager = new THREE.LoadingManager();
  manager.onProgress = function (url, loaded, total) {
    loadBar.style.width = Math.round((loaded / total) * 100) + "%";
  };
  manager.onLoad = function () {
    try { initScene(); }
    catch (err) { console.error(err); loadingEl.querySelector(".sub").textContent = "加载出错，请刷新重试"; return; }
    setTimeout(function () { loadingEl.classList.add("hide"); }, 180);
    // preload audio
    ALBUMS.forEach(function (a) {
      var au = new Audio();
      au.preload = "auto";
      au.src = a.audio;
    });
  };
  manager.onError = function (u) { console.warn("load error", u); };

  var loader = new THREE.TextureLoader(manager);
  function loadTex(name, path) {
    tex[name] = loader.load(path);
  }
  function packedTex(name, fallback) {
    return (window.CD_TEX && window.CD_TEX[name]) || fallback;
  }
  loadTex("wood", packedTex("wood", "tex/wood.jpg"));
  loadTex("metal", packedTex("metal", "tex/metal.jpg"));
  loadTex("rainbow", packedTex("rainbow", "tex/cd-rainbow.jpg"));
  ALBUMS.forEach(function (a) {
    loadTex("cover-" + a.id, packedTex("cover-" + a.id, "tex/cover-" + a.id + ".jpg"));
    loadTex("back-" + a.id, packedTex("back-" + a.id, "tex/back-" + a.id + ".jpg"));
    loadTex("spine-" + a.id, packedTex("spine-" + a.id, "tex/spine-" + a.id + ".jpg"));
    loadTex("booklet-" + a.id, packedTex("booklet-" + a.id, "tex/booklet-" + a.id + ".jpg"));
    loadTex("label-" + a.id, packedTex("label-" + a.id, "tex/label-" + a.id + ".jpg"));
    if (window.CD_AUDIO && window.CD_AUDIO[a.id]) a.audio = window.CD_AUDIO[a.id];
  });
})();
